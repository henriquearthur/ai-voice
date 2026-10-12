import AVFoundation
import CoreAudio
import CoreMedia

/// Captura só de entrada (AVCaptureSession), num microfone escolhido pelo nome.
/// Não abre unidade de saída, não usa voice processing, não faz ducking e não troca o dispositivo
/// padrão do sistema: a saída de áudio do Mac (AirPods, alto-falante) fica intocada.
final class MicCapture: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    private let session = AVCaptureSession()
    private let output = AVCaptureAudioDataOutput()
    private let queue = DispatchQueue(label: "escuta.mic", qos: .userInteractive)
    private(set) var device: AVCaptureDevice?
    var onBuffer: ((AVAudioPCMBuffer) -> Void)?
    /// Ganho automático antes do medidor e do reconhecedor (nil = desligado).
    /// ESCUTA_AGC=0 desliga; ESCUTA_AGC_ALVO muda o alvo (dBFS).
    var agc: AGC? = {
        let env = ProcessInfo.processInfo.environment
        if env["ESCUTA_AGC"] == "0" { return nil }
        var a = AGC()
        if let t = env["ESCUTA_AGC_ALVO"].flatMap(Float.init) { a.target = t }
        return a
    }()
    /// Grava o áudio cru do microfone (antes do ganho) para diagnóstico: ESCUTA_GRAVAR=/caminho.caf.
    private var dump: AVAudioFile?
    private let dumpPath = ProcessInfo.processInfo.environment["ESCUTA_GRAVAR"]
    private var lastAGCLog = Date()

    /// Volume de entrada do aparelho no máximo (CoreAudio), reaplicado a cada abertura ou troca.
    private func maximizeVolume(_ d: AVCaptureDevice) {
        guard let id = Audio.device(uid: d.uniqueID) else { logLine("volume de entrada: não achei \(d.localizedName) no CoreAudio"); return }
        let done = Audio.maximizeInput(id)
        logLine("volume de entrada de \(d.localizedName): " + (done.isEmpty ? "sem controle ajustável" : done.joined(separator: ", ")))
    }

    static func inputs() -> [AVCaptureDevice] {
        AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified).devices
    }

    static func isBluetooth(_ d: AVCaptureDevice) -> Bool {
        let t = UInt32(bitPattern: d.transportType)
        return t == kAudioDeviceTransportTypeBluetooth || t == kAudioDeviceTransportTypeBluetoothLE
    }

    /// Nomes em ordem de preferência, separados por vírgula ("HyperX,iPhone").
    static func hints(_ hint: String) -> [String] {
        hint.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    /// Posição do microfone na lista de preferência (menor é melhor); nil se não está na lista.
    static func rank(_ name: String, hint: String) -> Int? {
        hints(hint).firstIndex { name.localizedCaseInsensitiveContains($0) }
    }

    /// O primeiro microfone presente da lista; senão o embutido. Nunca um Bluetooth (abrir o mic dos
    /// AirPods derruba eles para o modo chamada).
    static func pick(hint: String) -> AVCaptureDevice? {
        let all = inputs().filter { !isBluetooth($0) }
        for h in hints(hint) {
            if let d = all.first(where: { $0.localizedName.localizedCaseInsensitiveContains(h) }) { return d }
        }
        return all.first { UInt32(bitPattern: $0.transportType) == kAudioDeviceTransportTypeBuiltIn }
            ?? all.first
    }

    func start(_ d: AVCaptureDevice) throws {
        device = d
        maximizeVolume(d)
        let input = try AVCaptureDeviceInput(device: d)
        session.beginConfiguration()
        guard session.canAddInput(input) else { session.commitConfiguration(); throw err("não deu para usar \(d.localizedName)") }
        session.addInput(input)
        output.audioSettings = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsNonInterleaved: true,
            AVNumberOfChannelsKey: 1,
        ]
        output.setSampleBufferDelegate(self, queue: queue)
        guard session.canAddOutput(output) else { session.commitConfiguration(); throw err("saída de captura indisponível") }
        session.addOutput(output)
        session.commitConfiguration()
        session.startRunning()
    }

    /// Troca o microfone com a captura no ar (aparelho entrou ou saiu), sem reiniciar o processo.
    func switchTo(_ d: AVCaptureDevice) throws {
        let input = try AVCaptureDeviceInput(device: d)
        session.beginConfiguration()
        let old = session.inputs
        old.forEach { session.removeInput($0) }
        guard session.canAddInput(input) else {
            old.forEach { if session.canAddInput($0) { session.addInput($0) } }
            session.commitConfiguration()
            throw err("não deu para usar \(d.localizedName)")
        }
        session.addInput(input)
        session.commitConfiguration()
        device = d
        maximizeVolume(d)
        queue.async { self.agc?.reset() }
        if !session.isRunning { session.startRunning() }
    }

    func stop() { session.stopRunning() }

    func captureOutput(_ o: AVCaptureOutput, didOutput sb: CMSampleBuffer, from c: AVCaptureConnection) {
        guard let desc = sb.formatDescription, var asbd = desc.audioStreamBasicDescription,
              let fmt = AVAudioFormat(streamDescription: &asbd) else { return }
        let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sb))
        guard frames > 0, let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: frames) else { return }
        buf.frameLength = frames
        let st = CMSampleBufferCopyPCMDataIntoAudioBufferList(sb, at: 0, frameCount: Int32(frames), into: buf.mutableAudioBufferList)
        guard st == noErr else { return }
        if let path = dumpPath {
            if dump == nil { dump = try? AVAudioFile(forWriting: URL(fileURLWithPath: path), settings: fmt.settings) }
            try? dump?.write(from: buf)
        }
        if var a = agc, let ch = buf.floatChannelData {
            a.process(ch, frames: Int(frames), channels: Int(fmt.channelCount), sampleRate: fmt.sampleRate)
            agc = a
            if Date().timeIntervalSince(lastAGCLog) >= 60 {
                lastAGCLog = Date()
                logLine(String(format: "ganho automático: %+.1f dB (fala %.0f dBFS, ruído %.0f dBFS, alvo %.0f)", a.gainDB, a.speechDB, a.floorDB, a.target))
            }
        }
        onBuffer?(buf)
    }

    private func err(_ m: String) -> NSError { NSError(domain: "escuta", code: 2, userInfo: [NSLocalizedDescriptionKey: m]) }
}

/// Ganho automático lento: leva a fala para perto de -20 dBFS antes do medidor e do reconhecedor.
/// Só aprende com blocos de fala (bem acima do ruído), então o silêncio não é amplificado até virar ruído alto.
/// Só aumenta (0 a +36 dB; o HyperX fala a -60..-40 dBFS); um limitador suave impede clipping.
struct AGC {
    var target: Float = -20
    var maxGain: Float = 36
    private(set) var gainDB: Float = 0
    private(set) var floorDB: Float = 0
    private(set) var speechDB: Float = -120
    private var started = false

    mutating func reset() { self = AGC(target: target, maxGain: maxGain) }

    mutating func process(_ ch: UnsafePointer<UnsafeMutablePointer<Float>>, frames n: Int, channels: Int, sampleRate: Double) {
        guard n > 0 else { return }
        let dt = Float(Double(n) / sampleRate)
        var sum: Float = 0
        for i in 0..<n { sum += ch[0][i] * ch[0][i] }
        let db = 20 * log10(max(sqrt(sum / Float(n)), 1e-7))
        if !started { started = true; floorDB = db }
        floorDB = db < floorDB ? db : min(db, floorDB + 0.5 * dt)
        // Fala: 12 dB acima do ruído e acima do silêncio digital.
        if db > floorDB + 12, db > -85 {
            speechDB = speechDB < db ? speechDB + min(db - speechDB, 30 * dt) : speechDB - min(speechDB - db, 3 * dt)
            let want = min(max(target - speechDB, 0), maxGain)
            // Desce rápido (fala ficou alta), sobe devagar.
            gainDB += want < gainDB ? max(want - gainDB, -20 * dt) : min(want - gainDB, 4 * dt)
        }
        guard gainDB > 0.1 else { return }
        let g = pow(10, gainDB / 20)
        for c in 0..<channels {
            let p = ch[c]
            for i in 0..<n {
                var y = p[i] * g
                let a = abs(y)
                if a > 0.9 { y = (y < 0 ? -1 : 1) * (0.9 + 0.1 * tanh((a - 0.9) / 0.1)) }
                p[i] = y
            }
        }
    }
}
