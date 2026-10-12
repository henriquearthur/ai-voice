import Foundation

/// Porteiro de voz em cima da probabilidade da VAD (Silero), bloco a bloco.
/// Só o que passa por aqui chega ao reconhecedor: ruído sem voz nunca vira texto.
public struct VadGate: Sendable, Equatable {
    public struct Config: Sendable, Equatable {
        /// Probabilidade a partir da qual o bloco abre uma fala.
        public var threshold: Float
        /// Abaixo disto, dentro de uma fala, o bloco conta como silêncio (histerese).
        public var negativeThreshold: Float
        /// Blocos seguidos de silêncio que fecham a fala.
        public var minSilenceChunks: Int
        /// Blocos com voz exigidos para a fala valer; menos que isso é estalo, tosse, porta.
        public var minVoicedChunks: Int

        public init(threshold: Float = 0.5, negativeThreshold: Float = 0.25, minSilenceChunks: Int = 3,
                    minVoicedChunks: Int = 1) {
            self.threshold = threshold
            self.negativeThreshold = negativeThreshold
            self.minSilenceChunks = minSilenceChunks
            self.minVoicedChunks = minVoicedChunks
        }
    }

    public enum Step: Equatable, Sendable {
        /// Fora de fala.
        case silence
        /// Abriu uma fala neste bloco.
        case start
        /// Dentro da fala (voz, ou silêncio curto ainda tolerado).
        case speech
        /// A fala acabou neste bloco. `valid`: teve voz suficiente para ir ao reconhecedor.
        case end(valid: Bool)
    }

    public let config: Config
    public private(set) var speaking = false
    public private(set) var voicedChunks = 0
    private var silentRun = 0

    public init(config: Config = Config()) { self.config = config }

    /// Bloco com voz de verdade (para o medidor de silêncio do fim de fala), não só tolerado.
    public func isVoice(_ p: Float) -> Bool { p >= (speaking ? config.negativeThreshold : config.threshold) }

    public mutating func step(_ p: Float) -> Step {
        if !speaking {
            guard p >= config.threshold else { return .silence }
            speaking = true
            voicedChunks = 1
            silentRun = 0
            return .start
        }
        if p >= config.negativeThreshold {
            silentRun = 0
            voicedChunks += 1
            return .speech
        }
        silentRun += 1
        guard silentRun >= config.minSilenceChunks else { return .speech }
        speaking = false
        let valid = voicedChunks >= config.minVoicedChunks
        voicedChunks = 0
        silentRun = 0
        return .end(valid: valid)
    }
}
