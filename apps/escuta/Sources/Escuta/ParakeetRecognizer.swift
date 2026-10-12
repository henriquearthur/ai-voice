import AVFoundation
import EscutaCore
import FluidAudio
import Foundation

/// Reconhecimento local com o NVIDIA Parakeet TDT v3 (multilíngue, pt e inglês na mesma frase) via
/// FluidAudio, em Core ML no Neural Engine. Igual aos apps de reunião locais: a VAD Silero corta a fala
/// e só o trecho com voz vai ao modelo (ruído nunca chega a ele, então não vira palavra inventada).
///
/// Enquanto a pessoa fala, o trecho inteiro é transcrito de novo a cada bloco de 256 ms (resultado
/// provisório, para interromper o Jarvis e mostrar no painel); quando a VAD vê silêncio, ou a escuta
/// pede os finais, o trecho é transcrito uma última vez e sai como final.
final class ParakeetRecognizer: SpeechEngine, @unchecked Sendable {
    var onEvent: ((Recognizer.Event) -> Void)?
    var onState: ((String) -> Void)?
    var onRestart: (() -> Void)?
    private var onVoice: ((Date) -> Void)?
    var hasVAD: Bool { true }
    func setVoiceHandler(_ handler: @escaping (Date) -> Void) { onVoice = handler }

    let generation = 1
    private let minConfidence: Double
    init(minConfidence: Double) { self.minConfidence = minConfidence }
    private(set) var startedAt = Date()
    private var format: AVAudioFormat?
    private var pipeline: ParakeetPipeline?

    private enum Input {
        case audio([Float])
        case finalize(CheckedContinuation<Void, Never>)
    }
    private let lock = NSLock()
    private var pending: [Float] = []
    private var queued = 0
    private var continuation: AsyncStream<Input>.Continuation?

    @MainActor
    func prepare() async throws -> AVAudioFormat {
        if let f = format { return f }
        let t0 = Date()
        onState?("carregando o Parakeet")
        let models = try await AsrModels.downloadAndLoad(version: .v3)
        let asr = AsrManager(config: .default)
        try await asr.loadModels(models)
        let vad = try await VadManager(config: VadConfig(defaultThreshold: 0.6))
        let p = ParakeetPipeline(asr: asr, vad: vad, layers: models.version.decoderLayers, minConfidence: minConfidence)
        // Aquece o Neural Engine: a primeira inferência compila e demora.
        _ = try? await p.transcribe([Float](repeating: 0, count: 16000))
        pipeline = p
        logLine("Parakeet TDT v3 e VAD Silero prontos em \(Int(Date().timeIntervalSince(t0) * 1000)) ms")
        guard let f = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false) else {
            throw NSError(domain: "escuta", code: 2, userInfo: [NSLocalizedDescriptionKey: "Sem formato 16 kHz"])
        }
        format = f
        let (stream, cont) = AsyncStream<Input>.makeStream()
        lock.withLock { continuation = cont }
        Task.detached(priority: .userInitiated) { [weak self] in
            for await input in stream {
                guard let self else { return }
                switch input {
                case .audio(let chunk):
                    let backlog = self.lock.withLock { () -> Int in self.queued -= 1; return self.queued }
                    let out = await p.process(chunk, partials: backlog == 0)
                    await self.deliver(out)
                case .finalize(let done):
                    await self.deliver(await p.finalize())
                    done.resume()
                }
            }
        }
        return f
    }

    @MainActor
    func start(reason: String) async {
        startedAt = Date()
        guard reason.hasPrefix("início") else { return }
        logLine("reconhecimento Parakeet iniciado (\(reason))")
        emit(["type": "recognizer", "generation": generation, "reason": reason, "engine": "parakeet"])
        onState?("ok")
    }

    @MainActor
    func finalizeNow() async {
        guard let c = lock.withLock({ continuation }) else { return }
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in c.yield(.finalize(done)) }
    }

    /// Thread de áudio: junta em blocos de 4096 amostras (256 ms), o tamanho da VAD.
    func feed(_ buffer: AVAudioPCMBuffer) {
        guard let ch = buffer.floatChannelData?[0] else { return }
        let n = Int(buffer.frameLength)
        lock.lock()
        defer { lock.unlock() }
        pending.append(contentsOf: UnsafeBufferPointer(start: ch, count: n))
        let size = VadManager.chunkSize
        while pending.count >= size, let c = continuation {
            queued += 1
            c.yield(.audio(Array(pending[0..<size])))
            pending.removeFirst(size)
        }
        // Sem consumidor ainda (carregando): guarda no máximo ~30 s.
        if pending.count > 16000 * 30 { pending.removeFirst(pending.count - 16000 * 30) }
    }

    private func deliver(_ out: [ParakeetPipeline.Output]) async {
        guard !out.isEmpty else { return }
        await MainActor.run {
            for o in out {
                switch o {
                case .voice(let at): onVoice?(at)
                case .text(let text, let isFinal, let confidence):
                    onEvent?(Recognizer.Event(generation: generation, text: text, isFinal: isFinal, confidence: confidence))
                case .failed(let why): onState?("erro: \(why)")
                }
            }
        }
    }
}

/// VAD → trecho de fala → Parakeet. Só roda na tarefa consumidora (serial).
final class ParakeetPipeline: @unchecked Sendable {
    enum Output {
        case voice(Date)
        case text(String, isFinal: Bool, confidence: Double?)
        case failed(String)
    }

    private let asr: AsrManager
    private let vad: VadManager
    private let layers: Int
    private let minConfidence: Double
    private var vadState: VadStreamState
    private var gate = VadGate()
    /// Os 3 blocos (~0,77 s) anteriores ao começo da fala: a VAD abre atrasada e cortaria a primeira sílaba.
    private var preroll: [Float] = []
    private static let prerollChunks = 3
    /// Blocos de cauda incluídos depois do fim da VAD, para não cortar a última palavra.
    private static let tailChunks = 2
    private var tailLeft = 0
    private var utterance: [Float] = []
    private var lastPartialText = ""
    private var failures = 0

    init(asr: AsrManager, vad: VadManager, layers: Int, minConfidence: Double) {
        self.asr = asr
        self.vad = vad
        self.layers = layers
        self.minConfidence = minConfidence
        self.vadState = VadStreamState.initial()
    }

    func process(_ chunk: [Float], partials: Bool) async -> [Output] {
        let at = Date()
        let p: Float
        do {
            let r = try await vad.processStreamingChunk(chunk, state: vadState)
            vadState = r.state
            p = r.probability
        } catch {
            return [.failed("VAD: \(error.localizedDescription)")]
        }
        var out: [Output] = []
        let voiced = gate.isVoice(p)
        let step = gate.step(p)
        if voiced, step != .silence { out.append(.voice(at)) }
        if ProcessInfo.processInfo.environment["ESCUTA_DEBUG"] != nil {
            logLine(String(format: "vad p=%.2f %@", p, "\(step)"))
        }
        switch step {
        case .silence:
            if tailLeft > 0 {
                utterance += chunk
                tailLeft -= 1
                if tailLeft == 0 { preroll = []; out += await final() }
            } else {
                keepPreroll(chunk)
            }
        case .start:
            if tailLeft > 0 {
                // Voltou a falar na cauda: é a mesma fala, só emenda.
                tailLeft = 0
                utterance += chunk
            } else {
                utterance = preroll + chunk
            }
            lastPartialText = ""
            if partials { out += await partial() }
        case .speech:
            tailLeft = 0
            utterance += chunk
            // Fala longa: fecha um trecho a cada ~14 s (a janela do modelo); a escuta junta os trechos.
            if utterance.count >= 16000 * 14 { out += await final() }
            else if partials { out += await partial() }
        case .end(let valid):
            utterance += chunk
            if valid {
                tailLeft = Self.tailChunks
            } else {
                utterance = []
                keepPreroll(chunk)
            }
        }
        return out
    }

    /// A escuta pediu os finais: transcreve o que houver e zera o trecho.
    func finalize() async -> [Output] {
        tailLeft = 0
        guard !utterance.isEmpty else { return [] }
        return await final()
    }

    private func keepPreroll(_ chunk: [Float]) {
        preroll.append(contentsOf: chunk)
        let max = Self.prerollChunks * chunk.count
        if preroll.count > max { preroll.removeFirst(preroll.count - max) }
    }

    private func partial() async -> [Output] {
        guard let r = await run(utterance) else { return [] }
        let text = r.text.trimmingCharacters(in: .whitespacesAndNewlines)
        // Provisório com confiança baixa não interrompe o Jarvis nem aparece: espera o próximo bloco.
        guard !text.isEmpty, text != lastPartialText, Double(r.confidence) >= minConfidence else { return [] }
        lastPartialText = text
        return [.text(text, isFinal: false, confidence: Double(r.confidence))]
    }

    private func final() async -> [Output] {
        let audio = utterance
        utterance = []
        lastPartialText = ""
        guard let r = await run(audio) else { return [.text("", isFinal: true, confidence: nil)] }
        let text = r.text.trimmingCharacters(in: .whitespacesAndNewlines)
        // Voz sem palavras de verdade (balbucio, fala ao contrário, TV ao fundo): o Parakeet inventa algo
        // com confiança baixa. Fala real fica acima de ~0,75 mesmo com ruído e termos em inglês.
        if !text.isEmpty, Double(r.confidence) < minConfidence {
            logLine(String(format: "Parakeet: descartado por confiança %.2f < %.2f: \"%@\"", r.confidence, minConfidence, text))
            return [.text("", isFinal: true, confidence: nil)]
        }
        return [.text(text, isFinal: true, confidence: text.isEmpty ? nil : Double(r.confidence))]
    }

    private func run(_ audio: [Float]) async -> ASRResult? {
        do {
            let r = try await transcribe(audio)
            failures = 0
            return r
        } catch {
            failures += 1
            logLine("Parakeet falhou (\(failures)x): \(error.localizedDescription)")
            return nil
        }
    }

    func transcribe(_ audio: [Float]) async throws -> ASRResult {
        // Trecho curto demais para o modelo: completa com silêncio até 1 s.
        var samples = audio
        if samples.count < 16000 { samples += [Float](repeating: 0, count: 16000 - samples.count) }
        var state = try TdtDecoderState(decoderLayers: layers)
        return try await asr.transcribe(samples, decoderState: &state, language: .portuguese)
    }
}
