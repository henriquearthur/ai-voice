import Foundation

/// Palavra de ativação: "Jarvis" (e as variações que a transcrição pt-BR gera) ou "camarada".
public enum Wake {
    public static let variants = ["jarvis", "jarvys", "jarbas", "jarves", "jarvi", "djarvis", "jervis", "jarviz", "camarada"]

    /// Primeira ocorrência de uma variação no começo de uma palavra; o intervalo cobre a palavra inteira.
    public static func find(_ text: String) -> Range<String.Index>? {
        let lower = text.lowercased()
        // lowercased() pode mudar o tamanho em casos exóticos; aí não arrisca índices.
        guard lower.count == text.count else { return nil }
        for v in variants {
            var from = lower.startIndex
            while let r = lower.range(of: v, options: [.diacriticInsensitive], range: from..<lower.endIndex) {
                let beforeOK = r.lowerBound == lower.startIndex || !lower[lower.index(before: r.lowerBound)].isLetter
                if beforeOK {
                    let lo = text.index(text.startIndex, offsetBy: lower.distance(from: lower.startIndex, to: r.lowerBound))
                    var hi = text.index(lo, offsetBy: lower.distance(from: r.lowerBound, to: r.upperBound))
                    while hi < text.endIndex, text[hi].isLetter { hi = text.index(after: hi) }
                    return lo..<hi
                }
                from = r.upperBound
            }
        }
        return nil
    }

    /// "Jarvis" vale no começo da frase ou logo depois de ponto, interrogação ou exclamação
    /// (a fala do Fernando colada em outra). No meio de uma frase não conta. Devolve a última ocorrência válida.
    public static func leading(_ text: String) -> Range<String.Index>? {
        var best: Range<String.Index>?
        var cursor = text.startIndex
        while cursor < text.endIndex {
            guard let lead = text[cursor...].firstIndex(where: { !$0.isWhitespace && !$0.isPunctuation }) else { break }
            let sub = String(text[lead...])
            if let r = find(sub), r.lowerBound == sub.startIndex {
                let lo = text.index(lead, offsetBy: sub.distance(from: sub.startIndex, to: r.lowerBound))
                let hi = text.index(lead, offsetBy: sub.distance(from: sub.startIndex, to: r.upperBound))
                best = lo..<hi
            }
            guard let stop = text[lead...].firstIndex(where: { ".?!".contains($0) }) else { break }
            cursor = text.index(after: stop)
        }
        return best
    }

    /// O pedido depois da palavra de ativação, sem pontuação nas pontas. nil se não houver ativação.
    public static func command(in text: String) -> (wake: Range<String.Index>, rest: String)? {
        guard let r = leading(text) else { return nil }
        return (r, String(text[r.upperBound...]).trimmingCharacters(in: edgeStrip))
    }

    /// A primeira palavra parece "Jarvis" ou "camarada" (Jardes, Jarbas, Jarvas...)?
    public static func looksLikeWake(_ word: String) -> Bool {
        let w = word.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil).lowercased()
        if variants.contains(w) { return true }
        return w.hasPrefix("jar") && (4...8).contains(w.count) || w.hasPrefix("djar") || w == "camarada"
    }

    /// O intervalo da palavra de ativação no começo da frase, se houver.
    public static func prefix(_ text: String) -> Range<String.Index>? {
        guard let r = text.firstRange(of: #/[\p{L}]+/#), text[..<r.lowerBound].allSatisfy({ !$0.isLetter && !$0.isNumber }),
              looksLikeWake(String(text[r])) else { return nil }
        return r
    }

    /// A frase sem a palavra de ativação no começo e sem pontuação nas pontas.
    public static func stripPrefix(_ text: String) -> String {
        let t = prefix(text).map { String(text[$0.upperBound...]) } ?? text
        return t.trimmingCharacters(in: edgeStrip)
    }

    public static let edgeStrip = CharacterSet.whitespacesAndNewlines.union(.punctuationCharacters)
}
