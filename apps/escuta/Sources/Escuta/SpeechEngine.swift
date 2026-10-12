import AVFoundation
import Foundation

/// Motor de reconhecimento da escuta. `ESCUTA_STT=apple` (padrão): SpeechAnalyzer da Apple.
/// `ESCUTA_STT=parakeet`: NVIDIA Parakeet TDT v3 no Neural Engine, com VAD Silero na frente.
protocol SpeechEngine: AnyObject {
    /// Chamados na thread principal.
    var onEvent: ((Recognizer.Event) -> Void)? { get set }
    var onState: ((String) -> Void)? { get set }
    /// A tarefa caiu sozinha e outra vai abrir.
    var onRestart: (() -> Void)? { get set }
    var generation: Int { get }
    var startedAt: Date { get }
    /// O motor tem VAD própria: o silêncio do fim de fala vem dela, não do medidor de volume.
    var hasVAD: Bool { get }
    /// Voz detectada pela VAD (thread principal), no instante do bloco de áudio.
    func setVoiceHandler(_ handler: @escaping (Date) -> Void)

    /// Formato que o motor quer. Chamar uma vez antes de alimentar.
    @MainActor func prepare() async throws -> AVAudioFormat
    @MainActor func start(reason: String) async
    /// Resultados finais de tudo o que já recebeu, sem esperar o motor decidir sozinho.
    @MainActor func finalizeNow() async
    /// Thread de áudio.
    func feed(_ buffer: AVAudioPCMBuffer)
}

extension SpeechEngine {
    var hasVAD: Bool { false }
    func setVoiceHandler(_ handler: @escaping (Date) -> Void) {}
}

extension Recognizer: SpeechEngine {}

enum SpeechEngines {
    static func make(_ config: Config) -> SpeechEngine {
        switch config.stt {
        case "parakeet": return ParakeetRecognizer(minConfidence: config.minConfidence)
        default: return Recognizer()
        }
    }
}
