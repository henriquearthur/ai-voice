import AppKit
import AVFoundation
import CoreAudio
import EscutaCore
import Speech
import Combine

struct Heard: Identifiable {
    let id = UUID()
    let at: Date
    let text: String
    let wakeRange: Range<String.Index>?
    let command: String?
}

struct Command: Identifiable {
    let id: Int
    let at: Date
    let text: String
    var state: String = "enviado"   // enviado → entregue | falhou → recebido → respondido
    var reply: String?
    var target: String?
    var mode: String?
    var speechMs: Int?
    var deliverMs: Int?
}

enum Phase: Equatable {
    case starting, listening, hearing, armed, sent, working, paused, error

    var symbol: String {
        switch self {
        case .starting: return "ellipsis.circle"
        case .listening: return "waveform"
        case .hearing: return "waveform.badge.mic"
        case .armed: return "waveform.circle.fill"
        case .sent: return "paperplane.fill"
        case .working: return "ellipsis.bubble.fill"
        case .paused: return "mic.slash"
        case .error: return "exclamationmark.triangle.fill"
        }
    }
    var label: String {
        switch self {
        case .starting: return "Iniciando"
        case .listening: return "Ouvindo"
        case .hearing: return "Ouvindo voz"
        case .armed: return "Jarvis detectado, pode falar"
        case .sent: return "Pedido enviado ao Claude"
        case .working: return "Claude trabalhando"
        case .paused: return "Pausado"
        case .error: return "Erro"
        }
    }
}

/// Estado do áudio compartilhado com a thread de captura.
final class AudioGate: @unchecked Sendable {
    private let lock = NSLock()
    private var _paused = false
    var paused: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _paused }
        set { lock.lock(); _paused = newValue; lock.unlock() }
    }
}

final class Escuta: ObservableObject {
    @Published var phase: Phase = .starting
    @Published var partial = ""
    @Published var heard: [Heard] = []
    @Published var commands: [Command] = []
    @Published var micName = "—"
    @Published var airpodsName: String?
    @Published var airpodsRate: Double = 0
    @Published var errorText: String?
    @Published var armedUntil: Date? {
        // Sem o tick rápido parado, a janela vence na hora certa por um tick marcado para o fim dela.
        didSet {
            guard let u = armedUntil else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + max(0, u.timeIntervalSinceNow) + 0.01) { [weak self] in
                MainActor.assumeIsolated { self?.tick() }
            }
        }
    }
    @Published var lastWakeAt: Date?
    @Published var diag = "áudio: aguardando"
    @Published var waiting: [WaitItem] = []
    @Published var silentFor = 0
    @Published var jarvisSpeaking = false
    /// A fala em andamento é um pedido (começou com "Jarvis" ou veio na janela depois dele).
    @Published var capturing = false
    @Published var recognizerState = "iniciando"

    let config: Config
    let router: Router
    let recognizer: SpeechEngine
    let gate = AudioGate()
    /// Onda do painel, fora deste objeto: o nível muda a cada buffer e não pode redesenhar tudo.
    let levelFeed = LevelFeed()
    private let mic = MicCapture()
    private var converter: AVAudioConverter?   // só na thread de captura
    private var nextID = 1
    private var claudeOffset: UInt64 = 0
    private var phaseReset: DispatchWorkItem?
    private var lastPartialAt: Date?
    private var buffersIn = 0, framesOut = 0, convErrors = 0, partials = 0, finals = 0
    private var peakDB: Float = -120
    private var voiceMeter = VoiceMeter()
    private var minutePeakDB: Float = -120
    private var formats = ""
    private let startedAt = Date()
    private var audioStartedAt: Date?
    private var lastDiagLog = Date.distantPast
    private var fileFeedDone = false

    // Fim de fala
    private var segments: [String] = []
    private var livePartial = ""
    private var lastWhole = ""
    private var utteranceStart: Date?
    private var lastTextChangeAt = Date.distantPast
    private var lastVoiceAt = Date.distantPast
    private var lastEventAt = Date()
    private var bargedIn = false
    private var speechEndedAt = Date.distantPast
    private var overlapped = false
    private var finalizeAt: Date?
    private var finalizeDone = false
    /// Silêncio real (medidor ou VAD) que fecha a frase: nunca menos que isto, para a pausa de respiração não cortar.
    static let hangover = 1.2
    /// Resultados finais que chegam a menos disto um do outro são a mesma frase.
    static let mergeWindow = 1.5
    /// Início de voz exige este tanto seguido acima do limiar (clique ou estalo isolado não conta).
    static let voiceOnset = 0.06
    private var voiceRun = 0.0
    private var lastFinalAt = Date.distantPast
    /// Trecho ainda em revisão que foi enviado no fechamento: se o final dele chegar depois, não vira frase nova.
    private var flushedVolatile: (text: String, at: Date)?
    private let lockQueue = DispatchQueue(label: "escuta.fala-lock")

    var isPaused: Bool { phase == .paused }

    init(config: Config) {
        self.config = config
        self.router = Router(config: config)
        self.recognizer = SpeechEngines.make(config)
        // Status antigo do claude.jsonl não vale para os pedidos deste processo (os ids recomeçam em 1).
        let status = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("claude.jsonl")
        claudeOffset = (try? FileManager.default.attributesOfItem(atPath: status.path)[.size] as? UInt64) ?? 0
        recognizer.onEvent = { [weak self] e in MainActor.assumeIsolated { self?.onTranscript(e) } }
        recognizer.onState = { [weak self] s in self?.recognizerState = s }
        recognizer.onRestart = { [weak self] in self?.keepVolatileText() }
        // Com VAD (Parakeet), o silêncio do fim de fala vem dela, não do volume do microfone.
        recognizer.setVoiceHandler { [weak self] at in self?.lastVoiceAt = at }
        Task { @MainActor in await self.start() }
        scheduleTick()
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.reportDiag() }
        if config.audioFile == nil {
            Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in self?.checkAirPods() }
            watchClaudeStatus()
            Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.watchClaudeStatus() }
            Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in self?.refreshWaiting() }
        }
        pollSpeechLock()
        handleTerm()
    }

    // MARK: Ciclo de vida

    @MainActor
    func start() async {
        logLine("iniciando; silêncio \(config.endpoint.silence) s (\(config.endpoint.openSilence) s em frase aberta), "
                + "destino \(config.outputFile ?? "herdr \(config.pane)")")
        if let file = config.audioFile { await startFromFile(file); return }

        watchAudioSystem()
        checkAirPods()

        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: break
        case .notDetermined:
            logLine("pedindo acesso ao microfone (o macOS mostra um aviso)")
            if !(await AVCaptureDevice.requestAccess(for: .audio)) { waitForMicPermission(); return }
        default:
            waitForMicPermission(); return
        }
        let speechAuth = SFSpeechRecognizer.authorizationStatus()
        if config.stt == "parakeet" {
            logLine("reconhecimento: Parakeet TDT v3 local (sem o reconhecimento de fala da Apple)")
        } else if speechAuth == .notDetermined {
            logLine("pedindo acesso ao reconhecimento de fala")
            let s = await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) } }
            logLine("reconhecimento de fala: \(s.rawValue)")
        } else {
            logLine("reconhecimento de fala: \(speechAuth.rawValue) (3 = autorizado)")
        }

        let fmt: AVAudioFormat
        do { fmt = try await recognizer.prepare() } catch {
            fail("Transcritor: \(error.localizedDescription)")
            restart(reason: "transcritor indisponível", after: 30)
            return
        }
        await recognizer.start(reason: "início")

        guard let device = MicCapture.pick(hint: config.micHint) else {
            fail("Nenhum microfone encontrado")
            restart(reason: "sem microfone", after: 30)
            return
        }
        micName = device.localizedName
        mic.onBuffer = { [weak self] buf in self?.process(buf, to: fmt) }
        do { try mic.start(device) } catch {
            fail("Microfone: \(error.localizedDescription)")
            restart(reason: "mic não abriu", after: 15)
            return
        }
        formats = "mic \(device.localizedName) → \(Int(fmt.sampleRate)) Hz"
        logLine("captura: \(formats)")
        audioStartedAt = Date()
        phase = .listening
        emit(["type": "ready", "mic": micName, "wake_word": "jarvis", "locale": "pt-BR", "stt": config.stt,
              "silence": config.endpoint.silence, "open_silence": config.endpoint.openSilence])
    }

    /// Sem permissão do microfone: fica de pé avisando e confere a cada 10 s; liberou, recomeça.
    private func waitForMicPermission() {
        fail("Libere o microfone para “Escuta” em Ajustes do Sistema > Privacidade e Segurança > Microfone")
        Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] t in
            if AVCaptureDevice.authorizationStatus(for: .audio) == .authorized {
                t.invalidate()
                self?.restart(reason: "microfone liberado")
            }
        }
    }

    /// Captura → medidor → (silêncio se o Jarvis fala) → conversão → reconhecedor. Thread de áudio.
    private func process(_ buffer: AVAudioPCMBuffer, to fmt: AVAudioFormat) {
        if gate.paused { return }
        if converter?.inputFormat != buffer.format { converter = AVAudioConverter(from: buffer.format, to: fmt) }
        guard let converter else { return }
        meter(buffer)
        let cap = AVAudioFrameCount(Double(buffer.frameLength) * fmt.sampleRate / buffer.format.sampleRate) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: cap) else { return }
        var fed = false
        var e: NSError?
        converter.convert(to: out, error: &e) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true; status.pointee = .haveData; return buffer
        }
        let ok = e == nil
        let n = Int(out.frameLength)
        DispatchQueue.main.async {
            self.buffersIn += 1
            if ok { self.framesOut += n; self.framesOutTotal += n; self.outRate = fmt.sampleRate } else { self.convErrors += 1 }
        }
        if ok, n > 0 { recognizer.feed(out) }
    }

    // MARK: Teste com arquivo de áudio

    @MainActor
    private func startFromFile(_ path: String) async {
        let file: AVAudioFile
        do { file = try AVAudioFile(forReading: URL(fileURLWithPath: path)) } catch {
            logLine("não abri \(path): \(error.localizedDescription)"); exit(2)
        }
        let fmt: AVAudioFormat
        do { fmt = try await recognizer.prepare() } catch { logLine("transcritor: \(error)"); exit(2) }
        await recognizer.start(reason: "início (arquivo)")
        let src = file.processingFormat
        micName = "arquivo \(URL(fileURLWithPath: path).lastPathComponent)"
        formats = "arquivo \(Int(src.sampleRate)) Hz → \(Int(fmt.sampleRate)) Hz"
        phase = .listening
        audioStartedAt = Date()
        emit(["type": "ready", "mic": micName, "silence": config.endpoint.silence, "stt": config.stt])
        let chunk = AVAudioFrameCount(src.sampleRate / 10)
        var silenceLeft = Int(config.trailingSilence * 10)
        let q = DispatchQueue(label: "escuta.arquivo")
        let timer = DispatchSource.makeTimerSource(queue: q)
        timer.schedule(deadline: .now(), repeating: 0.1)
        timer.setEventHandler { [weak self] in
            guard let self, let buf = AVAudioPCMBuffer(pcmFormat: src, frameCapacity: chunk) else { return }
            if file.framePosition < file.length {
                try? file.read(into: buf, frameCount: chunk)
            } else if silenceLeft > 0 {
                silenceLeft -= 1
                buf.frameLength = chunk
                for b in UnsafeMutableAudioBufferListPointer(buf.mutableAudioBufferList) where b.mData != nil {
                    memset(b.mData, 0, Int(b.mDataByteSize))
                }
            } else {
                timer.cancel()
                DispatchQueue.main.async { self.finishFileRun() }
                return
            }
            self.process(buf, to: fmt)
        }
        timer.resume()
        fileTimer = timer
    }
    private var fileTimer: DispatchSourceTimer?
    private var lastVoiceAtForCommand: [Int: Date] = [:]

    @MainActor
    private func finishFileRun() {
        if !(segments.isEmpty && livePartial.isEmpty) { flush(reason: "fim do arquivo") }
        releaseHeld()
        router.q.async {
            DispatchQueue.main.async {
                emit(["type": "stopped", "reason": "fim do arquivo"])
                exit(0)
            }
        }
    }

    // MARK: Controles

    func togglePause() {
        if isPaused {
            gate.paused = false
            phase = .listening; emit(["type": "resumed"])
        } else {
            gate.paused = true
            segments = []; livePartial = ""; utteranceStart = nil
            phase = .paused; partial = ""; emit(["type": "paused"])
        }
    }

    /// Sai para o launchd abrir de novo do zero (mic, transcritor e tap): mais confiável que remontar o AVAudioEngine.
    private var lastRestart = Date.distantPast
    func restart(reason: String, after delay: TimeInterval = 0) {
        guard config.audioFile == nil else { return }
        guard Date().timeIntervalSince(lastRestart) > 20 || delay > 0 else { return }
        lastRestart = Date()
        emit(["type": "restart", "reason": reason, "in": delay])
        logLine("reiniciando o processo: \(reason)")
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.shutdown(code: 75, reason: reason) }
    }

    /// Sai de verdade (código 0): o LaunchAgent só reabre depois de falha ou no próximo login.
    func quit() {
        logLine("encerrada pelo Sair")
        MainActor.assumeIsolated { shutdown(code: 0, reason: "Sair") }
    }

    // MARK: Encerramento sem perder fala

    /// SIGTERM (launchctl bootout, reinstalação, logout) passa pelo mesmo encerramento cuidadoso.
    private var termSource: DispatchSourceSignal?
    private func handleTerm() {
        signal(SIGTERM, SIG_IGN)
        let src = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        src.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.shutdown(code: 0, reason: "SIGTERM") } }
        src.resume()
        termSource = src
    }

    /// Pedido de saída com alguém falando: espera a frase terminar (fim de fala normal, que envia),
    /// e só então sai. Passou do limite, envia o que tiver. Sem isso, o começo da frase morria com o processo.
    private struct Stopping { let code: Int32; let reason: String; let since: Date; let deadline: Date }
    private var stopping: Stopping?
    private var exiting = false

    @MainActor
    func shutdown(code: Int32, reason: String, grace: TimeInterval = 20) {
        guard stopping == nil else { return }
        let now = Date()
        stopping = Stopping(code: code, reason: reason, since: now, deadline: now.addingTimeInterval(grace))
        let talking = utteranceStart != nil || now.timeIntervalSince(lastVoiceAt) < 1.5
        logLine("encerrando (\(reason))" + (talking ? "; espero a fala em curso terminar" : ""))
        checkShutdown()
        if !tickFast { scheduleTick() }
    }

    @MainActor
    private func checkShutdown() {
        guard let s = stopping, !exiting else { return }
        let now = Date()
        // Voz no microfone sem texto ainda: o reconhecedor atrasa ~2 s, dá até 3 s para o texto aparecer.
        let voiceWithoutText = utteranceStart == nil && now.timeIntervalSince(lastVoiceAt) < 1.5
            && now.timeIntervalSince(s.since) < 3
        if (utteranceStart != nil || voiceWithoutText) && now < s.deadline { return }
        exiting = true
        if !(segments.isEmpty && livePartial.isEmpty) { flush(reason: "encerramento") }
        releaseHeld()
        let waited = Int(now.timeIntervalSince(s.since) * 1000)
        // O envio ao herdr roda na fila do roteador: sai depois dele.
        router.q.async {
            DispatchQueue.main.async {
                emit(["type": "stopped", "reason": s.reason, "code": Int(s.code), "waited_ms": waited])
                exit(s.code)
            }
        }
    }

    private func fail(_ msg: String) {
        errorText = msg; phase = .error
        logLine("erro: \(msg)")
        emit(["type": "error", "message": msg])
    }

    // MARK: Áudio

    private func meter(_ buffer: AVAudioPCMBuffer) {
        guard let ch = buffer.floatChannelData?[0] else { return }
        let n = Int(buffer.frameLength)
        var sum: Float = 0
        for i in 0..<n { sum += ch[i] * ch[i] }
        let rms = sqrt(sum / Float(max(n, 1)))
        let db = 20 * log10(max(rms, 1e-6))
        let seconds = Double(n) / buffer.format.sampleRate
        DispatchQueue.main.async {
            self.peakDB = max(self.peakDB, db)
            self.minutePeakDB = max(self.minutePeakDB, db)
            // Limiar calibrado para o microfone atual (piso de ruído e nível de voz dele), sem o -48 dB fixo:
            // o HyperX fala a -60..-37 dB e entre as palavras manda silêncio digital; com -48 o medidor ficava
            // surdo e a frase fechava no meio da palavra.
            let isVoice = self.voiceMeter.feed(db: db, seconds: seconds)
            // Onda do painel relativa ao piso do aparelho: headset baixo também mexe a onda.
            let level = max(0, min(1, (db - max(self.voiceMeter.floor, -90)) / 40))
            self.voiceRun = isVoice ? self.voiceRun + seconds : 0
            // Já falando, cada bloco com voz renova; para começar, ~60 ms seguidos.
            let speaking = Date().timeIntervalSince(self.lastVoiceAt) < 0.3
            if !self.recognizer.hasVAD, isVoice, speaking || self.voiceRun >= Self.voiceOnset { self.lastVoiceAt = Date() }
            self.levelFeed.push(level)
        }
    }

    /// coreaudiod reiniciou, o microfone sumiu ou a captura deu erro: sai e o launchd abre de novo do zero.
    private func watchAudioSystem() {
        var addr = Audio.address(kAudioHardwarePropertyServiceRestarted)
        AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, DispatchQueue.main) { [weak self] _, _ in
            self?.restart(reason: "coreaudiod reiniciou")
        }
        let nc = NotificationCenter.default
        nc.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: nil, queue: .main) { [weak self] n in
            guard let self else { return }
            let e = n.userInfo?[AVCaptureSessionErrorKey] as? NSError
            // Erro porque o microfone saiu: troca para o próximo da lista em vez de reiniciar.
            if let d = self.mic.device, !d.isConnected { self.reselectMic("erro na captura com \(d.localizedName) desconectado"); return }
            self.restart(reason: "erro na captura: \(e?.localizedDescription ?? "?")")
        }
        nc.addObserver(forName: AVCaptureDevice.wasDisconnectedNotification, object: nil, queue: .main) { [weak self] n in
            guard let self, let d = n.object as? AVCaptureDevice, d.uniqueID == self.mic.device?.uniqueID else { return }
            self.reselectMic("\(d.localizedName) desconectou")
        }
        nc.addObserver(forName: AVCaptureDevice.wasConnectedNotification, object: nil, queue: .main) { [weak self] n in
            guard let self, let d = n.object as? AVCaptureDevice, !MicCapture.isBluetooth(d) else { return }
            // Pode chegar antes do aparelho estar pronto: tenta de novo logo depois.
            self.reselectMic("\(d.localizedName) conectou")
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.reselectMic("\(d.localizedName) conectou") }
        }
    }

    /// Captura sempre do melhor microfone presente na ordem do ESCUTA_MIC (HyperX, iPhone, MacBook),
    /// trocando na hora quando um aparelho entra ou sai.
    private func reselectMic(_ why: String) {
        guard audioStartedAt != nil, config.audioFile == nil else { return }
        guard let best = MicCapture.pick(hint: config.micHint) else {
            fail("Nenhum microfone encontrado")
            restart(reason: "sem microfone", after: 15)
            return
        }
        if let cur = mic.device, cur.uniqueID == best.uniqueID, cur.isConnected { return }
        let from = micName
        do {
            try mic.switchTo(best)
        } catch {
            restart(reason: "troca de microfone falhou: \(error.localizedDescription)")
            return
        }
        micName = best.localizedName
        voiceMeter.reset()
        formats = "mic \(best.localizedName) → 16000 Hz"
        if phase == .error { phase = .listening; errorText = nil }
        logLine("captura: mic \(best.localizedName) (troca: \(why))")
        emit(["type": "mic", "from": from, "to": best.localizedName, "reason": why])
    }

    private func checkAirPods() {
        let out = Audio.defaultDevice(kAudioHardwarePropertyDefaultOutputDevice)
        guard Audio.isBluetooth(out) else { airpodsName = nil; return }
        let r = Audio.rate(out)
        if r != airpodsRate || airpodsName == nil {
            emit(["type": "airpods", "device": Audio.name(out), "rate": r, "profile": r >= 44100 ? "A2DP estéreo" : "HFP mono"])
        }
        airpodsName = Audio.name(out)
        airpodsRate = r
    }

    // MARK: Jarvis falando

    /// Confere o fala.lock a cada 50 ms. O reconhecedor continua ouvindo enquanto o Jarvis fala,
    /// para o dono poder interromper.
    private func pollSpeechLock() {
        let path = config.speechLock
        lockQueue.async { [weak self] in
            var wasHeld = false
            while let self {
                let held = SpeechLock.isHeld(path)
                if held != wasHeld {
                    wasHeld = held
                    DispatchQueue.main.async {
                        self.jarvisSpeaking = held
                        if held {
                            self.bargedIn = false
                        } else {
                            self.speechEndedAt = Date()
                            // Reabre a janela de conversa: o dono responde sem dizer "Jarvis".
                            let until = Date().addingTimeInterval(self.config.conversationWindow)
                            if (self.armedUntil ?? .distantPast) < until { self.armedUntil = until }
                        }
                        emit(["type": held ? "jarvis_speaking" : "jarvis_quiet"])
                    }
                }
                Thread.sleep(forTimeInterval: 0.05)
            }
        }
    }

    /// O Jarvis está falando, ou acabou há pouco (o eco da sala ainda chega ao reconhecedor).
    private var inSpeech: Bool { jarvisSpeaking || Date().timeIntervalSince(speechEndedAt) < config.speechTail }

    /// O dono disse "Jarvis" (ou "para", "espera", "chega") por cima da fala: cala o Jarvis na hora.
    @MainActor
    private func checkBargeIn(_ text: String) {
        guard jarvisSpeaking, !bargedIn, !text.isEmpty else { return }
        // Qualquer fala do dono que não seja eco do que o Jarvis está dizendo interrompe. Sem palavra especial.
        // Sem filtro de eco, por ordem do dono: qualquer fala com palavras corta a fala do Jarvis.
        let owner = text
        guard !BargeIn.isNoise(owner) else { return }
        // Palavra solta sem voz agora no microfone ou com confiança baixa não corta o Jarvis.
        let voiceNow = Date().timeIntervalSince(lastVoiceAt) < 1.5
        guard !BargeIn.isWeak(owner, confidence: liveConfidence, hadVoice: voiceNow) else { return }
        bargedIn = true
        let path = config.speechLock
        let t0 = Date()
        // Fila própria: a lockQueue está ocupada para sempre com o laço que vigia o fala.lock.
        DispatchQueue.global(qos: .userInteractive).async {
            let killed = Speaker.stop(lock: path)
            let ms = Int(Date().timeIntervalSince(t0) * 1000)
            DispatchQueue.main.async {
                logLine("interrompeu o Jarvis em \(ms) ms (ouviu \"\(owner)\"); processos encerrados: \(killed)")
                emit(["type": "barge_in", "owner": owner, "heard": text, "killed": killed, "kill_ms": ms, "audio_s": self.audioSeconds])
            }
        }
    }

    private var framesOutTotal = 0
    private var outRate = 16000.0
    /// Segundos de áudio já entregues ao reconhecedor (nos testes com arquivo, a posição no arquivo).
    private var audioSeconds: Double { (Double(framesOutTotal) / outRate * 100).rounded() / 100 }
    private var segConfidences: [Double] = []
    private var liveConfidence: Double?
    private var voiceInUtterance = false
    /// Confiança média da fala em andamento (trechos finais e o trecho em revisão).
    private var utteranceConfidence: Double? {
        let all = segConfidences + (liveConfidence.map { [$0] } ?? [])
        return all.isEmpty ? nil : all.reduce(0, +) / Double(all.count)
    }
    private var lastSpokenTs: Double = 0

    // MARK: Transcrição e fim de fala

    /// Decide se a frase vira pedido. arm = "Jarvis" sozinho.
    private func decide(_ text: String, startedAt: Date, overlapped: Bool) -> (wake: Range<String.Index>?, command: String?, arm: Bool) {
        // Toda fala com palavras vai ao orquestrador, sem palavra de ativação e sem filtro de eco.
        let owner = text
        let wake = Wake.prefix(owner)
        let rest = Wake.stripPrefix(owner)
        if BargeIn.isNoise(rest) { return (wake, nil, false) }
        if BargeIn.isWeak(rest, confidence: utteranceConfidence, hadVoice: voiceInUtterance) {
            logLine("descartada por ser curta e sem voz ou com confiança baixa: \"\(rest)\" (confiança \(utteranceConfidence.map { String(format: "%.2f", $0) } ?? "-"), voz \(voiceInUtterance))")
            return (wake, nil, false)
        }
        // "Para", "chega" soltos enquanto o Jarvis falava só calam o Jarvis.
        if overlapped && BargeIn.isOnlyStop(rest) { return (wake, nil, false) }
        return (wake, rest, false)
    }

    private var whole: String { (segments + [livePartial]).filter { !$0.isEmpty }.joined(separator: " ") }

    @MainActor
    private func onTranscript(_ e: Recognizer.Event) {
        lastEventAt = Date()
        if gate.paused { return }
        let current = e.generation == recognizer.generation
        // Resultado parcial de uma tarefa já trocada: a nova é quem manda agora.
        if !current && !e.isFinal { return }
        var text = e.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if e.isFinal { finals += 1 } else { partials += 1 }
        if e.isFinal {
            lastFinalAt = Date()
            // Final atrasado do trecho que já foi enviado em revisão no fechamento: já está no pedido.
            if utteranceStart == nil, let f = flushedVolatile, Date().timeIntervalSince(f.at) < 4,
               Self.sameWords(text, f.text) {
                logLine("final repetido do trecho já enviado, ignorado: \"\(text)\"")
                flushedVolatile = nil
                return
            }
            // Tarefa nova com pré-roll: o começo dela pode repetir as últimas palavras do trecho anterior.
            if let r = recognizer as? Recognizer, Date().timeIntervalSince(r.lastStartAt) < 8, let prev = segments.last {
                text = Self.dropOverlap(prev, text)
            }
            // Só pontuação ("." que o reconhecedor solta no silêncio) não é fala.
            if text.rangeOfCharacter(from: .alphanumerics) != nil { segments.append(text) }
            if current { livePartial = "" }
        } else {
            livePartial = text
        }
        let w = whole
        partial = w
        if ProcessInfo.processInfo.environment["ESCUTA_DEBUG"] != nil {
            logLine("evento final=\(e.isFinal) falando=\(jarvisSpeaking) conf=\(e.confidence.map { String(format: "%.2f", $0) } ?? "-") texto=\(text)")
        }
        if e.isFinal { if let c = e.confidence, !text.isEmpty { segConfidences.append(c) } ; liveConfidence = nil }
        else { liveConfidence = e.confidence }
        if Date().timeIntervalSince(lastVoiceAt) < 2.5 { voiceInUtterance = true }
        checkBargeIn(text)
        guard w != lastWhole else { return }
        lastWhole = w
        guard !w.isEmpty else { return }
        lastTextChangeAt = Date()
        lastPartialAt = Date()
        if inSpeech { overlapped = true }
        let isCommand = true
        if capturing != isCommand { capturing = isCommand }
        if utteranceStart == nil { utteranceStart = Date() }
        if !tickFast { scheduleTick() }
        if phase == .listening { setPhase(.hearing, resetAfter: 1.5) }
        if Wake.leading(w) != nil, lastWakeAt.map({ Date().timeIntervalSince($0) > 2 }) ?? true { lastWakeAt = Date() }
    }

    private static func words(_ s: String) -> [String] {
        s.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
    }

    /// Mesmas palavras, ignorando pontuação e maiúsculas (ou uma começando pela outra).
    static func sameWords(_ a: String, _ b: String) -> Bool {
        let x = words(a).joined(separator: " "), y = words(b).joined(separator: " ")
        guard !x.isEmpty, !y.isEmpty else { return false }
        return x == y || x.hasPrefix(y) || y.hasPrefix(x)
    }

    /// Tira do começo de `next` as palavras (até 3) que repetem o fim de `prev` (sobreposição do pré-roll).
    static func dropOverlap(_ prev: String, _ next: String) -> String {
        let p = words(prev)
        let parts = next.split(separator: " ", omittingEmptySubsequences: true)
        let n = parts.map { words(String($0)).joined() }
        for k in stride(from: min(3, p.count, n.count), through: 1, by: -1)
            where Array(p.suffix(k)) == Array(n.prefix(k)) {
            return parts.dropFirst(k).joined(separator: " ")
        }
        return next
    }

    /// A tarefa de reconhecimento caiu: o trecho ainda em revisão vira definitivo, para não sumir.
    private func keepVolatileText() {
        if !livePartial.isEmpty { segments.append(livePartial); livePartial = "" }
    }

    /// O fim de fala e o encerramento precisam do tick a cada 0,2 s; parado, 1 s basta (troca preventiva
    /// e reconhecedor travado). A janela do Jarvis vence pelo tick marcado no armedUntil.
    private var tickTimer: Timer?
    private var tickFast = false
    private var tickBusy: Bool { utteranceStart != nil || stopping != nil || held != nil }

    private func scheduleTick() {
        tickTimer?.invalidate()
        tickFast = tickBusy
        tickTimer = Timer.scheduledTimer(withTimeInterval: tickFast ? 0.2 : 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.tick()
                if self.tickFast != self.tickBusy { self.scheduleTick() }
            }
        }
    }

    @MainActor
    private func tick() {
        let now = Date()
        // Expira a janela, mas não no meio de uma fala que começou dentro dela.
        if let until = armedUntil, now >= until, utteranceStart.map({ $0 >= until }) ?? true {
            armedUntil = nil
            if phase == .armed { phase = .listening }
        }
        if let start = utteranceStart, !whole.isEmpty {
            // O texto chega até ~2 s depois do som: voz pouco antes do começo do texto também conta.
            if lastVoiceAt > start.addingTimeInterval(-2.5) { voiceInUtterance = true }
            // Fim de fala pelo silêncio real (VAD, ou medidor com limiar relativo ao piso calibrado):
            // só 1,2 s ou mais fecha; pausa de respiração não. Pedir os finais com voz no microfone cortava
            // a palavra ao meio: o fim ia numa frase e o começo da seguinte saía mutilado.
            let sinceVoice = now.timeIntervalSince(lastVoiceAt)
            let sinceText = now.timeIntervalSince(lastTextChangeAt)
            let meterHeard = lastVoiceAt > start.addingTimeInterval(-2.5)
            let silence: Double
            if recognizer.hasVAD {
                silence = sinceVoice
            } else if meterHeard {
                // Ruído contínuo confundindo o medidor: texto parado há 4 s também vale como silêncio.
                silence = max(sinceVoice, sinceText - 2.7)
            } else {
                // O medidor não ouviu esta frase (calibrando): só o texto parado conta, com folga de 0,6 s.
                silence = sinceText - 0.6
            }
            let activityAt = now.addingTimeInterval(-silence)
            let sinceFinalize = finalizeAt.flatMap { $0 > activityAt && finalizeDone ? now.timeIntervalSince($0) : nil }
            var ep = config.endpoint
            // A VAD (Silero) já separa respiração de fim de fala: com ela vale o ESCUTA_SILENCIO (0,7 s).
            // O piso de 1,2 s fica só para o medidor de volume, que se engana mais.
            if !recognizer.hasVAD { ep.silence = max(ep.silence, Self.hangover) }
            ep.openSilence = max(ep.openSilence, ep.silence)
            var d = Endpoint.decide(text: whole, volatile: !livePartial.isEmpty, silence: silence,
                                    sinceText: sinceText, sinceFinalize: sinceFinalize,
                                    elapsed: now.timeIntervalSince(start), config: ep)
            // Finais a menos de 1,5 s um do outro são a mesma frase: espera a janela passar antes de fechar.
            // O final que veio do nosso pedido de finalização (com o silêncio confirmado) não reabre a janela;
            // senão todo fim de fala ganhava 1,5 s a mais e frases separadas por 2 s se juntavam.
            // Com VAD, o final vem do fim de fala que ela mesma detectou, e o silêncio já foi confirmado
            // por ela: a janela não se aplica (custava 1,5 s fixo em todo pedido).
            let askedFinal = recognizer.hasVAD || (meterHeard && finalizeAt.map { lastFinalAt >= $0 } == true)
            if case .close = d, now.timeIntervalSince(start) < ep.maxUtterance, !askedFinal,
               now.timeIntervalSince(lastFinalAt) < Self.mergeWindow {
                d = .wait
            }
            switch d {
            case .wait: break
            case .finalize:
                if let f = finalizeAt, f > activityAt { break }  // já pedido nesta pausa
                finalizeAt = now
                finalizeDone = false
                Task { @MainActor in
                    await recognizer.finalizeNow()
                    finalizeDone = true
                }
            case .close(let reason):
                flush(reason: reason, allowHold: recognizer.hasVAD)
            }
            checkShutdown()
            return
        }
        releaseHeldIfExpired(now)
        checkShutdown()
        guard audioStartedAt != nil, !gate.paused else { return }
        // Ninguém falando: troca preventiva da tarefa de reconhecimento, ou troca porque ela parou de responder.
        let quiet = now.timeIntervalSince(lastTextChangeAt) > 5 && now.timeIntervalSince(lastVoiceAt) > 3
        if quiet, now.timeIntervalSince(recognizer.startedAt) > config.rotateEvery {
            Task { @MainActor in await recognizer.start(reason: "troca preventiva") }
        } else if now.timeIntervalSince(lastVoiceAt) < 1, now.timeIntervalSince(lastEventAt) > 90,
                  now.timeIntervalSince(recognizer.startedAt) > 90 {
            lastEventAt = now
            Task { @MainActor in await recognizer.start(reason: "sem resultados há 90 s com voz no microfone") }
        }
    }

    /// Fala retida à espera de uma continuação (só com VAD): ver Endpoint.shouldHold.
    private struct Held { var text: String; var began: Date; var overlapped: Bool; var reason: String; var at: Date }
    private var held: Held?

    @MainActor
    private func releaseHeldIfExpired(_ now: Date) {
        guard let h = held, now.timeIntervalSince(h.at) >= Self.mergeWindow else { return }
        // Fala nova que começou dentro da janela ainda pode colar: espera ela terminar.
        if let s = utteranceStart, s.timeIntervalSince(h.at) < Self.mergeWindow { return }
        releaseHeld()
    }

    @MainActor
    private func releaseHeld() {
        guard let h = held else { return }
        held = nil
        deliver(text: h.text, began: h.began, wasOverlapped: h.overlapped, reason: h.reason)
    }

    /// Fim da fala: junta tudo e manda UMA mensagem.
    @MainActor
    private func flush(reason: String, allowHold: Bool = false) {
        var text = whole.trimmingCharacters(in: .whitespacesAndNewlines)
        flushedVolatile = livePartial.isEmpty ? nil : (livePartial, Date())
        var began = utteranceStart ?? Date()
        segments = []; livePartial = ""; lastWhole = ""; utteranceStart = nil; partial = ""
        finalizeAt = nil
        capturing = false
        var wasOverlapped = overlapped
        overlapped = false
        defer { segConfidences = []; liveConfidence = nil; voiceInUtterance = false }
        guard Endpoint.hasLetters(text) else {
            if text.isEmpty { return }
            emit(["type": "discarded", "text": text, "end": reason, "audio_s": audioSeconds])
            return
        }
        if let h = held {
            if Endpoint.shouldMerge(previous: h.text, gap: began.timeIntervalSince(h.at), window: Self.mergeWindow) {
                text = h.text + " " + text
                began = h.began
                wasOverlapped = wasOverlapped || h.overlapped
                held = nil
            } else {
                releaseHeld()
            }
        }
        if allowHold, Endpoint.shouldHold(text) {
            held = Held(text: text, began: began, overlapped: wasOverlapped, reason: reason, at: Date())
            return
        }
        deliver(text: text, began: began, wasOverlapped: wasOverlapped, reason: reason)
    }

    @MainActor
    private func deliver(text: String, began: Date, wasOverlapped: Bool, reason: String) {
        let duration = Date().timeIntervalSince(began)
        let d = decide(text, startedAt: began, overlapped: wasOverlapped)
        if d.wake != nil { lastWakeAt = Date() }
        if d.arm {
            armedUntil = Date().addingTimeInterval(config.armedWindow)
            setPhase(.armed)
            emit(["type": "armed", "seconds": config.armedWindow])
        }
        heard.insert(Heard(at: Date(), text: text, wakeRange: d.wake, command: d.command), at: 0)
        if heard.count > 12 { heard.removeLast() }
        emit(["type": "heard", "text": text, "wake": d.wake != nil, "end": reason, "during_speech": wasOverlapped,
              "confidence": utteranceConfidence ?? -1, "voice": voiceInUtterance, "sent": d.command != nil, "seconds": (duration * 10).rounded() / 10,
              "audio_s": audioSeconds])
        if let c = d.command, !c.isEmpty { send(c) }
    }

    @MainActor
    private func send(_ text: String) {
        armedUntil = Date().addingTimeInterval(config.conversationWindow)
        if config.sound { NSSound(named: "Tink")?.play() }  // recebido, na hora
        let id = nextID; nextID += 1
        // fala→texto: do fim da fala (medidor do microfone) até o pedido pronto para enviar.
        let speechMs = Int(Date().timeIntervalSince(lastVoiceAt) * 1000)
        commands.insert(Command(id: id, at: Date(), text: text, speechMs: speechMs), at: 0)
        if commands.count > 8 { commands.removeLast() }
        lastVoiceAtForCommand[id] = lastVoiceAt
        emit(["type": "command", "id": id, "text": text, "speech_ms": speechMs, "audio_s": audioSeconds])
        setPhase(.sent, resetAfter: 20)
        router.q.async { [weak self] in
            guard let self else { return }
            let r = self.router.route(text)
            DispatchQueue.main.async { self.applyResult(id: id, r) }
        }
    }

    @MainActor
    private func applyResult(id: Int, _ r: Router.Result) {
        if let i = commands.firstIndex(where: { $0.id == id }) {
            commands[i].target = r.who
            commands[i].mode = r.mode
            commands[i].deliverMs = r.ms
            commands[i].state = r.ok ? "entregue" : "falhou"
            if !r.ok { commands[i].reply = r.detail }
        }
        let latency = Int(Date().timeIntervalSince(lastVoiceAtForCommand[id] ?? Date()) * 1000)
        lastVoiceAtForCommand[id] = nil
        logLine("pedido #\(id) entregue a \(r.who) (\(r.mode)) \(latency) ms depois do fim da fala; envio \(r.ms) ms")
        emit(["type": "routed", "id": id, "latency_ms": latency, "pane": r.pane, "who": r.who, "mode": r.mode, "ok": r.ok, "ms": r.ms, "detail": r.detail])
        if !r.ok { logLine("entrega falhou: \(r.detail)") }
        refreshWaiting()
    }

    func refreshWaiting() {
        guard config.outputFile == nil else { return }
        router.q.async { [weak self] in
            guard let self else { return }
            self.router.refresh()
            let w = self.router.waiting()
            DispatchQueue.main.async { if self.waiting != w { self.waiting = w } }
        }
    }

    /// Resposta por clique na barra (o caminho "por texto").
    func answer(_ item: WaitItem, yes: Bool) {
        let id = nextID; nextID += 1
        commands.insert(Command(id: id, at: Date(), text: yes ? "sim (clique)" : "não (clique)"), at: 0)
        router.q.async { [weak self] in
            guard let self, let a = self.router.agent(item.pane) else { return }
            let r = self.router.deliver(to: a, text: yes ? "sim" : "não", isYes: yes, isNo: !yes)
            DispatchQueue.main.async { self.applyResult(id: id, r) }
        }
    }

    private func reportDiag() {
        diag = "áudio \(buffersIn / 2) buf/s · pico \(Int(peakDB)) dB · parciais \(partials) · finais \(finals) · rec #\(recognizer.generation)"
        if Date().timeIntervalSince(lastDiagLog) >= 60 {
            lastDiagLog = Date()
            logLine("\(diag) · pico no minuto \(Int(minutePeakDB)) dB · piso \(Int(voiceMeter.floor)) dB · voz \(Int(voiceMeter.voice)) dB · limiar \(Int(voiceMeter.threshold)) dB · conv_err \(convErrors) · frames \(framesOut) · \(formats)")
            minutePeakDB = -120
        }
        if config.audioFile == nil, phase != .paused, phase != .error,
           let s = audioStartedAt, Date().timeIntervalSince(s) > 8 {
            silentFor = buffersIn == 0 ? silentFor + 2 : 0
            if silentFor >= 6 { restart(reason: "sem áudio do microfone há \(silentFor) s") }
        }
        buffersIn = 0; peakDB = -120
    }

    private func setPhase(_ p: Phase, resetAfter: TimeInterval? = nil) {
        guard phase != .paused, phase != .error else { return }
        phase = p
        phaseReset?.cancel()
        if let t = resetAfter {
            let w = DispatchWorkItem { [weak self] in
                guard let self, self.phase == p else { return }
                self.phase = self.armedUntil != nil ? .armed : .listening
            }
            phaseReset = w
            DispatchQueue.main.asyncAfter(deadline: .now() + t, execute: w)
        }
    }

    // MARK: Status escrito pelo Claude (claude.jsonl: {"id":1,"state":"recebido"|"respondido","reply":"..."})

    /// Lê o claude.jsonl quando ele muda (evento do sistema de arquivos), em vez de abrir o arquivo a cada 0,4 s.
    /// Chamado a cada 1 s: só arma a vigia quando o arquivo surge ou foi trocado (apagado, renomeado).
    private var claudeWatch: DispatchSourceFileSystemObject?
    private func watchClaudeStatus() {
        guard claudeWatch == nil else { return }
        let path = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("claude.jsonl").path
        let fd = open(path, O_EVTONLY)
        guard fd >= 0 else { return }
        let src = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd,
                                                            eventMask: [.write, .extend, .attrib, .delete, .rename, .revoke],
                                                            queue: .main)
        src.setEventHandler { [weak self, weak src] in
            guard let self, let src else { return }
            if !src.data.isDisjoint(with: [.delete, .rename, .revoke]) {
                src.cancel()
                self.claudeWatch = nil
                self.watchClaudeStatus()
            }
            self.readClaudeStatus()
        }
        src.setCancelHandler { close(fd) }
        claudeWatch = src
        src.resume()
        readClaudeStatus()
    }

    private func readClaudeStatus() {
        let url = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("claude.jsonl")
        guard let h = try? FileHandle(forReadingFrom: url) else { return }
        defer { try? h.close() }
        let size = (try? h.seekToEnd()) ?? 0
        if size < claudeOffset { claudeOffset = 0 }
        guard size > claudeOffset else { return }
        try? h.seek(toOffset: claudeOffset)
        guard let data = try? h.readToEnd(), let s = String(data: data, encoding: .utf8) else { return }
        claudeOffset = size
        for line in s.split(separator: "\n") {
            guard let d = line.data(using: .utf8),
                  let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  let id = o["id"] as? Int, let state = o["state"] as? String,
                  let i = commands.firstIndex(where: { $0.id == id }) else { continue }
            commands[i].state = state
            if let r = o["reply"] as? String { commands[i].reply = r }
            if state == "recebido" { setPhase(.working, resetAfter: 120) }
            if state == "respondido" { setPhase(.listening) }
        }
    }
}
