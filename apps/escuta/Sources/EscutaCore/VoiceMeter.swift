/// Detector de voz pelo nível do microfone, calibrado sozinho para cada aparelho.
/// Um limiar fixo (-48 dB) servia para o iPhone e deixava surdo um headset mais baixo (HyperX):
/// sem voz detectada, todo silêncio parecia longo e a frase fechava no meio da palavra.
/// Aqui o limiar fica entre o piso de ruído e o nível típico de voz do aparelho atual.
public struct VoiceMeter: Sendable {
    /// Piso de ruído: desce na hora, sobe devagar (0,5 dB/s), para fala contínua não virar "ruído".
    public private(set) var floor: Float = 0
    /// Nível típico de voz: sobe na hora com voz, desce devagar (1 dB/s).
    public private(set) var voice: Float = -120
    public var minMargin: Float = 10
    public var maxMargin: Float = 15
    /// Abaixo disso nunca é voz (silêncio digital, mic mudo).
    public var absoluteMin: Float = -90
    private var started = false

    public init() {}

    /// Microfone trocado: calibra de novo.
    public mutating func reset() { self = VoiceMeter() }

    public var threshold: Float {
        let spread = voice > floor ? (voice - floor) * 0.35 : minMargin
        return max(floor + min(max(spread, minMargin), maxMargin), absoluteMin)
    }

    /// Nível de um bloco (dB RMS) com sua duração; devolve se é voz.
    public mutating func feed(db: Float, seconds: Double) -> Bool {
        let dt = Float(seconds)
        if !started { started = true; floor = db; voice = db + minMargin }
        floor = db < floor ? db : min(db, floor + 0.5 * dt)
        let isVoice = db > threshold
        if isVoice { voice = max(voice, db) } else { voice = max(floor + minMargin, voice - 1 * dt) }
        return isVoice
    }
}
