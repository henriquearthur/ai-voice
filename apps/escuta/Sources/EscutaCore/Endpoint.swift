import Foundation

/// Quando uma fala acabou. Tempos em segundos.
public struct EndpointConfig: Sendable, Equatable {
    /// Silêncio que encerra uma frase com cara de completa.
    public var silence: Double
    /// Silêncio exigido quando a frase termina aberta ("e", "que", "pra", vírgula...).
    public var openSilence: Double
    /// Texto mudou há menos que isto: o reconhecedor ainda está revisando, espera.
    public var settle: Double
    /// Depois de pedir os resultados finais, espera no máximo isto pelo trecho ainda em revisão.
    public var finalizeWait: Double
    /// Fala que não para nunca (TV ligada, por exemplo): fecha mesmo assim.
    public var maxUtterance: Double

    public init(silence: Double = 1.3, openSilence: Double = 2.5, settle: Double = 0.4,
                finalizeWait: Double = 1.5, maxUtterance: Double = 120) {
        self.silence = silence
        self.openSilence = openSilence
        self.settle = settle
        self.finalizeWait = finalizeWait
        self.maxUtterance = maxUtterance
    }
}

public enum EndpointDecision: Equatable, Sendable {
    case wait
    /// Pedir ao reconhecedor os resultados finais do que já ouviu (sem esperar ele decidir sozinho).
    case finalize
    case close(String)
}

public enum Endpoint {
    /// Palavras que, no fim da frase, indicam que o pensamento continua.
    public static let openWords: Set<String> = [
        "e", "que", "pra", "pro", "para", "mas", "porque", "por", "pois", "ou", "nem", "então", "entao", "aí", "ai",
        "tipo", "quando", "se", "como", "onde", "qual", "quais", "quem", "com", "sem", "de", "do", "da", "dos", "das",
        "no", "na", "nos", "nas", "em", "o", "a", "os", "as", "um", "uma", "uns", "umas", "ao", "aos", "à", "às",
        "pelo", "pela", "sobre", "até", "ate", "também", "tambem", "enquanto", "caso", "meu", "minha", "seu", "sua",
        "tá", "não", "nao", "hum", "ahn", "éh", "jarvis", "camarada",
    ]

    /// A frase termina aberta: conectivo no fim, vírgula, dois-pontos, travessão ou reticências.
    /// Ponto final não fecha (o reconhecedor pontua cedo); "?" e "!" fecham.
    public static func endsOpen(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let last = t.last else { return false }
        if t.hasSuffix("...") || ",;:-–—…".contains(last) { return true }
        if "?!".contains(last) { return false }
        // Sem tirar acentos: "é" fecha a frase, "e" deixa aberta.
        let words = t.lowercased()
            .components(separatedBy: CharacterSet.letters.inverted)
            .filter { !$0.isEmpty }
        guard let w = words.last else { return false }
        return openWords.contains(w)
    }

    /// A fala tem ao menos uma letra; só "." ou vazio vem de ruído e é descartada.
    public static func hasLetters(_ text: String) -> Bool {
        text.contains { $0.isLetter }
    }

    /// Fala que provavelmente continua: não termina em . ? ! ou termina aberta (palavra aberta, vírgula).
    /// Com VAD, fica retida até a janela de junção passar, para a próxima fala colar nela.
    public static func shouldHold(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let last = t.last else { return false }
        return endsOpen(t) || !".?!".contains(last)
    }

    /// A nova fala começa a menos de `window` s da anterior retida: as duas viram uma só.
    public static func shouldMerge(previous: String, gap: Double, window: Double) -> Bool {
        shouldHold(previous) && gap >= 0 && gap < window
    }

    /// - Parameters:
    ///   - text: tudo o que foi ouvido nesta fala até agora (finais + trecho em revisão).
    ///   - volatile: o último trecho ainda não teve resultado final.
    ///   - silence: segundos sem voz no microfone.
    ///   - sinceText: segundos desde a última mudança no texto.
    ///   - sinceFinalize: segundos desde que os finais foram pedidos depois desta pausa; nil se ainda não foram.
    ///   - elapsed: segundos desde o começo da fala.
    public static func decide(text: String, volatile: Bool, silence: Double, sinceText: Double, sinceFinalize: Double?,
                              elapsed: Double, config c: EndpointConfig) -> EndpointDecision {
        if elapsed >= c.maxUtterance { return .close("limite de \(Int(c.maxUtterance)) s") }
        if silence < c.silence || sinceText < c.settle { return .wait }
        guard let f = sinceFinalize else { return .finalize }
        if volatile && f < c.finalizeWait { return .wait }
        let open = endsOpen(text)
        if open && silence < c.openSilence { return .wait }
        return .close(open ? "silêncio após frase aberta" : "silêncio")
    }
}
