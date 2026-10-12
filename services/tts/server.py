"""Servidor local de TTS (Kokoro-82M via mlx-audio) para o Jarvis.

Escuta só em 127.0.0.1 (porta JARVIS_TTS_PORT, padrão 7349). Não toca áudio: devolve WAV
para o cliente tocar. O modelo fica em JARVIS_TTS_MODEL_DIR (padrão: models/kokoro-82m-bf16 ao
lado deste arquivo); quem baixa é o services/tts/install.sh do repositório.

  GET  /health      -> 200 quando o modelo está carregado e aquecido
  GET  /voices      -> lista de vozes disponíveis
  POST /synthesize  -> {"text": "...", "voice": "pf_dora", "speed": 1.15} -> audio/wav

Telemetria: traces e métricas OpenTelemetry (service.name "jarvis-tts") por OTLP HTTP para
OTEL_EXPORTER_OTLP_ENDPOINT (padrão http://127.0.0.1:4318). A exportação roda em threads de fundo;
coletor fora do ar ou OpenTelemetry ausente não afetam a síntese.
"""

import io
import resource
import json
import ctypes
import ctypes.util
import logging
import os
import re
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

os.environ.setdefault("HF_HUB_OFFLINE", "1")

import numpy as np  # noqa: E402
from mlx_audio.tts.utils import load  # noqa: E402

HOST = "127.0.0.1"
PORT = int(os.environ.get("JARVIS_TTS_PORT") or 7349)
BASE = Path(__file__).resolve().parent
# O LaunchAgent roda com `python -I`, que tira a pasta do script do sys.path.
sys.path.insert(0, str(BASE))
from normaliza import normalizar  # noqa: E402
MODEL_DIR = Path(os.environ.get("JARVIS_TTS_MODEL_DIR") or BASE / "models" / "kokoro-82m-bf16")
VOICE_DIR = MODEL_DIR / "voices"
DEFAULT_VOICE = os.environ.get("JARVIS_TTS_VOICE") or "pf_dora"
DEFAULT_SPEED = float(os.environ.get("JARVIS_TTS_SPEED") or 1.15)
if not 0.5 <= DEFAULT_SPEED <= 2.0:
    raise SystemExit(f"JARVIS_TTS_SPEED={DEFAULT_SPEED} fora do intervalo 0.5 a 2.0")
LANG_CODE = "p"  # pt-br (espeak-ng via misaki)
MAX_TEXT = 4000
MAX_BODY = 64 * 1024
MAX_CHUNK = 250

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("jarvis-tts")

OTLP_ENDPOINT = (os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT") or "http://127.0.0.1:4318").rstrip("/")
OTLP_TIMEOUT = 2.0
METRIC_INTERVAL_MS = 15_000


def _rss_bytes() -> int:
    """Memória residente atual (macOS, via task_info); sem ela, o pico de RSS."""
    try:
        libc = ctypes.CDLL(ctypes.util.find_library("c"))

        class TimeValue(ctypes.Structure):
            _fields_ = [("seconds", ctypes.c_int32), ("microseconds", ctypes.c_int32)]

        class MachTaskBasicInfo(ctypes.Structure):
            _fields_ = [
                ("virtual_size", ctypes.c_uint64),
                ("resident_size", ctypes.c_uint64),
                ("resident_size_max", ctypes.c_uint64),
                ("user_time", TimeValue),
                ("system_time", TimeValue),
                ("policy", ctypes.c_int32),
                ("suspend_count", ctypes.c_int32),
            ]

        info = MachTaskBasicInfo()
        count = ctypes.c_uint32(ctypes.sizeof(info) // 4)
        task = ctypes.c_uint32.in_dll(libc, "mach_task_self_")
        if libc.task_info(task, 20, ctypes.byref(info), ctypes.byref(count)) == 0:  # MACH_TASK_BASIC_INFO
            return int(info.resident_size)
    except Exception:  # noqa: BLE001
        pass
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak if sys.platform == "darwin" else peak * 1024


class _NoTelemetry:
    """Substituto quando o OpenTelemetry não carrega: tudo vira no-op."""

    def span(self, name, **_):
        import contextlib

        return contextlib.nullcontext(None)

    def __getattr__(self, _name):
        return lambda *a, **k: None


class Telemetry:
    def __init__(self):
        from opentelemetry import metrics, trace
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.metrics import Observation
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
        from opentelemetry.sdk.metrics.view import ExplicitBucketHistogramAggregation, View
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.trace import Status, StatusCode

        # Coletor fora do ar não pode encher o log de erro do LaunchAgent.
        logging.getLogger("opentelemetry").setLevel(logging.CRITICAL)
        self._Status, self._StatusCode = Status, StatusCode
        res = Resource.create({"service.name": "jarvis-tts", "service.namespace": "jarvis"})

        tp = TracerProvider(resource=res)
        tp.add_span_processor(
            BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{OTLP_ENDPOINT}/v1/traces", timeout=OTLP_TIMEOUT))
        )
        trace.set_tracer_provider(tp)
        self.tracer = trace.get_tracer("jarvis-tts")

        # Nomes já no formato do Prometheus. Sem `unit` onde a unidade está no nome: assim o
        # exportador OTLP->Prometheus não acrescenta _milliseconds/_seconds/_bytes; o _total dos
        # contadores também vem no próprio nome.
        millis = [50, 100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000, 8000, 13000, 20000, 30000, 60000]
        seconds = [0.5, 1, 2, 3, 5, 8, 13, 20, 30, 60, 120, 300]
        mp = MeterProvider(
            resource=res,
            metric_readers=[
                PeriodicExportingMetricReader(
                    OTLPMetricExporter(endpoint=f"{OTLP_ENDPOINT}/v1/metrics", timeout=OTLP_TIMEOUT),
                    export_interval_millis=METRIC_INTERVAL_MS,
                    export_timeout_millis=int(OTLP_TIMEOUT * 1000),
                )
            ],
            views=[
                View(instrument_name="jarvis_tts_sintese_ms", aggregation=ExplicitBucketHistogramAggregation(millis)),
                View(instrument_name="jarvis_tts_primeiro_audio_ms", aggregation=ExplicitBucketHistogramAggregation(millis)),
                View(instrument_name="jarvis_tts_audio_segundos", aggregation=ExplicitBucketHistogramAggregation(seconds)),
                View(
                    instrument_name="jarvis_tts_fator_tempo_real",
                    aggregation=ExplicitBucketHistogramAggregation([0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 4]),
                ),
                View(
                    instrument_name="jarvis_tts_caracteres",
                    aggregation=ExplicitBucketHistogramAggregation([10, 25, 50, 100, 200, 400, 800, 1500, 2500, 4000]),
                ),
            ],
        )
        metrics.set_meter_provider(mp)
        meter = metrics.get_meter("jarvis-tts")
        self.requests = meter.create_counter("jarvis_tts_requisicoes_total", unit="{request}", description="Pedidos POST /synthesize por status HTTP")
        self.errors = meter.create_counter("jarvis_tts_erros_total", unit="{error}", description="Pedidos de síntese que falharam, por tipo")
        self.duration = meter.create_histogram("jarvis_tts_sintese_ms", description="Latência total da síntese, em ms")
        self.ttfa = meter.create_histogram("jarvis_tts_primeiro_audio_ms", description="Do pedido ao primeiro trecho de áudio gerado, em ms")
        self.audio = meter.create_histogram("jarvis_tts_audio_segundos", description="Duração do áudio gerado, em segundos")
        self.rtf = meter.create_histogram("jarvis_tts_fator_tempo_real", unit="1", description="Tempo de síntese / duração do áudio (menor é melhor)")
        self.chars = meter.create_histogram("jarvis_tts_caracteres", unit="{char}", description="Caracteres por pedido")

        def rss(_options):
            yield Observation(_rss_bytes())

        def mlx_mem(_options):
            try:
                import mlx.core as mx

                yield Observation(int(mx.get_active_memory()), {"pool": "active"})
                yield Observation(int(mx.get_cache_memory()), {"pool": "cache"})
            except Exception:  # noqa: BLE001
                return

        meter.create_observable_gauge("jarvis_tts_memoria_bytes", [rss], description="Memória residente (RSS) do processo, em bytes")
        meter.create_observable_gauge("jarvis_tts_mlx_memoria_bytes", [mlx_mem], description="Memória do MLX (Metal) em uso e em cache, em bytes")
        self._tp, self._mp = tp, mp

    def span(self, name, **attrs):
        return self.tracer.start_as_current_span(name, attributes=attrs, record_exception=True)

    def error(self, span, kind: str, status: int, exc: Exception | None = None):
        attrs = {"error.type": kind, "http.response.status_code": status}
        self.errors.add(1, {"tipo": kind, "status": str(status)})
        if span is not None:
            span.set_attributes(attrs)
            span.set_status(self._Status(self._StatusCode.ERROR, kind))
            if exc is not None:
                span.record_exception(exc)


def _init_telemetry():
    try:
        return Telemetry()
    except Exception:  # noqa: BLE001
        log.warning("telemetria desligada (OpenTelemetry indisponível)", exc_info=True)
        return _NoTelemetry()


TELEMETRY = _NoTelemetry()

VOICES = sorted(p.stem for p in VOICE_DIR.glob("p*.safetensors"))
MODEL = None
READY = False
GEN_LOCK = threading.Lock()


def split_text(text: str) -> str:
    """Quebra em frases curtas, uma por linha (o G2P pt-br não faz chunking)."""
    text = re.sub(r"[ \t\r\f\v]+", " ", text).strip()
    pieces = []
    for line in re.split(r"\n+", text):
        for sent in re.split(r"(?<=[.!?…;:])\s+", line.strip()):
            sent = sent.strip()
            while len(sent) > MAX_CHUNK:
                cut = max(sent.rfind(", ", 0, MAX_CHUNK), sent.rfind(" ", 0, MAX_CHUNK))
                if cut <= 0:
                    cut = MAX_CHUNK
                pieces.append(sent[:cut].strip(" ,"))
                sent = sent[cut:].strip(" ,")
            if sent:
                pieces.append(sent)
    return "\n".join(pieces)


SPOKEN_PATH = os.path.expanduser("~/.local/share/jarvis/fala.txt")


def record_spoken(text: str) -> None:
    """Grava o último texto sintetizado: a Escuta usa para não confundir a voz do Jarvis com um pedido."""
    try:
        tmp = SPOKEN_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"ts": time.time(), "text": text}, f, ensure_ascii=False)
        os.replace(tmp, SPOKEN_PATH)
    except OSError:
        log.warning("não gravei %s", SPOKEN_PATH)


def synthesize(text: str, voice: str, speed: float) -> tuple[bytes, float | None, float]:
    """Devolve (wav, instante monotônico do primeiro trecho de áudio, segundos de áudio)."""
    chunks = []
    first_at = None
    with GEN_LOCK:
        for result in MODEL.generate(
            split_text(normalizar(text)),
            voice=str(VOICE_DIR / f"{voice}.safetensors"),
            speed=speed,
            lang_code=LANG_CODE,
            split_pattern=r"\n+",
        ):
            chunks.append(np.asarray(result.audio, dtype=np.float32))
            if first_at is None:
                first_at = time.monotonic()
    if not chunks:
        raise RuntimeError("nenhum áudio gerado")
    audio = np.concatenate(chunks)
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(MODEL.sample_rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue(), first_at, len(audio) / MODEL.sample_rate


class Handler(BaseHTTPRequestHandler):
    server_version = "jarvis-tts/1"

    def log_message(self, fmt, *args):
        log.info("%s %s", self.address_string(), fmt % args)

    def _json(self, code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            if READY:
                self._json(200, {"status": "ok", "model": "Kokoro-82M", "voices": VOICES})
            else:
                self._json(503, {"status": "loading"})
        elif self.path == "/voices":
            self._json(200, {"voices": VOICES, "default": DEFAULT_VOICE})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/synthesize":
            return self._json(404, {"error": "not found"})
        t0 = time.monotonic()
        with TELEMETRY.span("tts.synthesize", **{"http.request.method": "POST", "url.path": self.path}) as span:
            code = self._synthesize(span, t0)
            TELEMETRY.requests.add(1, {"status": str(code)})
            if span is not None:
                span.set_attribute("http.response.status_code", code)

    def _reject(self, span, code: int, kind: str, payload: dict) -> int:
        TELEMETRY.error(span, kind, code)
        self._json(code, payload)
        return code

    def _synthesize(self, span, t0: float) -> int:
        if not READY:
            return self._reject(span, 503, "not_ready", {"error": "modelo carregando"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            code = 413 if length > MAX_BODY else 400
            return self._reject(span, code, "invalid_body", {"error": "corpo inválido"})
        try:
            req = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeDecodeError):
            return self._reject(span, 400, "invalid_json", {"error": "JSON inválido"})
        if not isinstance(req, dict):
            return self._reject(span, 400, "invalid_json", {"error": "JSON inválido"})
        text = req.get("text")
        voice = req.get("voice") or DEFAULT_VOICE
        speed = req.get("speed", DEFAULT_SPEED)
        if not isinstance(text, str) or not text.strip():
            return self._reject(span, 400, "missing_text", {"error": "text obrigatório"})
        if len(text) > MAX_TEXT:
            return self._reject(span, 413, "text_too_long", {"error": f"text acima de {MAX_TEXT} caracteres"})
        if voice not in VOICES:
            return self._reject(span, 400, "unknown_voice", {"error": "voz desconhecida", "voices": VOICES})
        if not isinstance(speed, (int, float)) or not 0.5 <= speed <= 2.0:
            return self._reject(span, 400, "invalid_speed", {"error": "speed deve estar entre 0.5 e 2.0"})
        attrs = {"voz": voice}
        TELEMETRY.chars.record(len(text), attrs)
        if span is not None:
            span.set_attributes({"jarvis.tts.voice": voice, "jarvis.tts.speed": float(speed), "jarvis.tts.characters": len(text)})
        try:
            wav, first_at, audio_s = synthesize(text, voice, float(speed))
        except Exception as exc:  # noqa: BLE001
            log.exception("falha na síntese")
            TELEMETRY.error(span, type(exc).__name__, 500, exc)
            self._json(500, {"error": str(exc)})
            return 500
        elapsed = time.monotonic() - t0
        TELEMETRY.duration.record(elapsed * 1000, attrs)
        TELEMETRY.audio.record(audio_s, attrs)
        if first_at is not None:
            TELEMETRY.ttfa.record((first_at - t0) * 1000, attrs)
        rtf = elapsed / audio_s if audio_s > 0 else None
        if rtf is not None:
            TELEMETRY.rtf.record(rtf, attrs)
        if span is not None:
            span.set_attributes(
                {
                    "jarvis.tts.audio.duration_s": audio_s,
                    "jarvis.tts.time_to_first_audio_s": (first_at - t0) if first_at is not None else -1.0,
                    "jarvis.tts.real_time_factor": rtf if rtf is not None else -1.0,
                    "jarvis.tts.wav_bytes": len(wav),
                }
            )
        log.info("synth voice=%s chars=%d bytes=%d %.3fs", voice, len(text), len(wav), elapsed)
        record_spoken(text)
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self.end_headers()
        self.wfile.write(wav)
        return 200


def main():
    global MODEL, READY, TELEMETRY
    TELEMETRY = _init_telemetry()
    if not VOICES:
        sys.exit(f"nenhuma voz pt-BR em {VOICE_DIR}")
    t0 = time.monotonic()
    # Teto do cache de buffers do Metal (padrão: ilimitado, cresce até ~300 MB em repouso).
    import mlx.core as mx
    mx.set_cache_limit(int(os.environ.get("JARVIS_TTS_MLX_CACHE_MB") or 64) * 1024 * 1024)
    MODEL = load(str(MODEL_DIR))
    log.info("modelo carregado em %.2fs; vozes: %s", time.monotonic() - t0, ", ".join(VOICES))
    t0 = time.monotonic()
    for voice in VOICES:
        synthesize("Olá. Aquecendo a voz.", voice, 1.0)
    log.info("warm-up concluído em %.2fs", time.monotonic() - t0)
    READY = True
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.daemon_threads = True
    log.info("ouvindo em http://%s:%d", HOST, PORT)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
