"""Normaliza o texto antes do Kokoro para que termos técnicos saiam pronunciáveis em pt-BR.

O G2P pt-br (espeak-ng) lê siglas como numerais romanos (CI vira "cento e um"), junta
identificadores (DATABASE_URL) e engole a pontuação de nomes de arquivo (package.json). Aqui:

- snake_case e SCREAMING_CASE viram palavras separadas: DATABASE_URL -> database URL;
- o ponto dentro de nomes de arquivo e domínios vira "ponto": package.json -> package ponto json;
- siglas e palavras técnicas saem do dicionário: CI -> cê i, PR -> pê érre, pytest -> pai test.

Números (3.14, 1.000) e pontuação de fim de frase ficam intactos. Para estender, acrescente
entradas em SIGLAS (casa só em maiúsculas, aceita plural com "s"), PALAVRAS (ignora caixa) ou
EXTENSOES (só depois do último ponto de um nome de arquivo). Grafias com acento agudo isolado
("í") fazem o espeak dizer "i agudo": use a vogal sem acento quando ela estiver sozinha.
"""

import re

# Siglas em maiúsculas. Ausentes daqui, o espeak soletra sozinho (HTTP, SQL, TTS, MCP, LLM...),
# mas as que parecem numeral romano (CI, CLI) ou palavra (URL, JSON, API) precisam de grafia.
SIGLAS = {
    "API": "a pê i",
    "AWS": "a dáblio ésse",
    "CI": "cê i",
    "CD": "cê dê",
    "CLI": "cê ele i",
    "CPU": "cê pê u",
    "CSS": "cê ésse ésse",
    "DNS": "dê ene ésse",
    "GPU": "gê pê u",
    "HTML": "agá tê eme ele",
    "HTTP": "agá tê tê pê",
    "HTTPS": "agá tê tê pê ésse",
    "ID": "i dê",
    "IP": "i pê",
    "JSON": "jêison",
    "LLM": "ele ele eme",
    "MCP": "eme cê pê",
    "MD": "eme dê",
    "OK": "oquei",
    "PDF": "pê dê éfe",
    "PR": "pê érre",
    "README": "rid mi",
    "SDK": "ésse dê cá",
    "SQL": "ésse quê ele",
    "SSH": "ésse ésse agá",
    "TTS": "tê tê ésse",
    "UI": "u i",
    "URL": "u erre ele",
    "YAML": "iâmel",
}

# Palavras técnicas em qualquer caixa (pytest, Pytest, PYTEST).
PALAVRAS = {
    "env": "énvi",
    "git": "guit",
    "github": "guit rãb",
    "json": "jêison",
    "npm": "ene pê eme",
    "pytest": "pai test",
    "python": "páiton",
    "readme": "rid mi",
    "yaml": "iâmel",
}

# Extensões de arquivo (o trecho depois do último ponto).
EXTENSOES = {
    "js": "jota ésse",
    "json": "jêison",
    "md": "eme dê",
    "py": "pai",
    "sh": "ésse agá",
    "toml": "tómel",
    "ts": "tê ésse",
    "tsx": "tê ésse xis",
    "txt": "tê xis tê",
    "yaml": "iâmel",
    "yml": "iâmel",
}

# Um "token" técnico: palavra com sublinhados, pontos ou hífens internos, com ponto inicial
# opcional (.env). O ponto final de frase não entra, porque não é seguido de letra ou dígito.
_TOKEN = re.compile(r"(?<![\w.])\.?\w+(?:[.\-]\w+)*")


def _palavra(w: str, de_identificador: bool) -> str:
    sigla = SIGLAS.get(w)
    if sigla is not None:
        return sigla
    if len(w) > 2 and w.endswith("s") and w[:-1] in SIGLAS and w[:-1].isupper():
        return SIGLAS[w[:-1]] + "s"  # PRs -> pê érres
    palavra = PALAVRAS.get(w.lower())
    if palavra is not None:
        return palavra
    if de_identificador and w.isupper():
        return w.lower()  # DATABASE em DATABASE_URL
    return w


def _segmento(seg: str, extensao: bool) -> str:
    if extensao:
        ext = EXTENSOES.get(seg.lower())
        if ext is not None:
            return ext
    partes = [p for p in seg.split("_") if p]
    if not partes:
        return ""
    de_identificador = len(partes) > 1 or "_" in seg
    return " ".join(
        "-".join(_palavra(h, de_identificador) for h in p.split("-")) for p in partes
    )


def _token(m: re.Match) -> str:
    tok = m.group(0)
    inicio_ponto = tok.startswith(".")
    corpo = tok[1:] if inicio_ponto else tok
    segs = corpo.split(".")
    # Só é nome de arquivo/domínio se algum trecho depois de um ponto começa com letra;
    # assim 3.14, 1.000 e v1.2.3 continuam sendo números.
    pontuado = inicio_ponto or any(s[:1].isalpha() for s in segs[1:])
    if not pontuado:
        segs = [corpo]
    falados = []
    for i, s in enumerate(segs):
        ext = pontuado and len(segs) > 1 and i == len(segs) - 1 or (inicio_ponto and len(segs) == 1)
        falados.append(_segmento(s, ext))
    texto = " ponto ".join(f for f in falados if f)
    return ("ponto " + texto) if inicio_ponto else texto


def normalizar(texto: str) -> str:
    """Devolve o texto com identificadores, nomes de arquivo e siglas escritos como se falam."""
    return _TOKEN.sub(_token, texto)
