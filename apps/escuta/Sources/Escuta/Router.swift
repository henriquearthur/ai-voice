import Foundation

// Entrega o pedido inteiro, numa mensagem só, à sessão do orquestrador no herdr.
// Exceções: um agente chamado pelo nome no começo da frase, "sim"/"não" para quem está pedindo
// aprovação, e a resposta a uma pergunta feita por voz (asks.jsonl).

struct HerdrAgent {
    let pane: String; let title: String; let cwd: String; let status: String; let seq: Int
    var focused = false; var name = ""
    var short: String { name.isEmpty ? URL(fileURLWithPath: cwd).lastPathComponent : name }
}

struct WaitItem: Identifiable, Equatable {
    var id: String { pane }
    let pane: String
    let who: String
    let reason: String
    let blocked: Bool
}

final class Router {
    static let asksURL = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".local/share/jarvis/asks.jsonl")
    static let yes: Set<String> = ["sim", "pode", "pode sim", "sim pode", "pode rodar", "pode ir", "vai", "manda", "manda ver",
                                   "ok", "beleza", "aprovado", "aprovo", "claro", "sim claro", "positivo", "pode seguir", "segue",
                                   "sim pode rodar", "pode rodar sim", "pode mandar", "sim manda"]
    static let no: Set<String> = ["nao", "nao pode", "negativo", "cancela", "para", "nem pensar", "nao nao", "nao obrigado"]
    static let filler: Set<String> = ["para", "pro", "pra", "o", "a", "ao", "do", "da", "de"]
    static let prefix = "[voz do Fernando] "

    let config: Config
    let q = DispatchQueue(label: "escuta.router")
    private(set) var agents: [HerdrAgent] = []
    private var answered: [String: Double] = [:]

    init(config: Config) { self.config = config }

    struct Ask { let ts: Double; let pane: String; let question: String }
    struct Result { let pane: String; let who: String; let mode: String; let ok: Bool; let detail: String; let ms: Int }

    @discardableResult
    func herdr(_ args: [String]) -> (Int32, String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: config.herdr)
        p.arguments = args
        let out = Pipe()
        p.standardOutput = out; p.standardError = out
        do { try p.run() } catch { return (-1, "\(error)") }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (p.terminationStatus, String(data: data, encoding: .utf8) ?? "")
    }

    func refresh() {
        if config.outputFile != nil { return }
        let (code, s) = herdr(["agent", "list"])
        guard code == 0, let d = s.data(using: .utf8),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let r = o["result"] as? [String: Any], let list = r["agents"] as? [[String: Any]] else { return }
        agents = list.compactMap { a in
            guard let pane = a["pane_id"] as? String else { return nil }
            return HerdrAgent(pane: pane, title: (a["terminal_title_stripped"] as? String) ?? "", cwd: (a["cwd"] as? String) ?? "",
                              status: (a["agent_status"] as? String) ?? "", seq: (a["state_change_seq"] as? Int) ?? 0,
                              focused: (a["focused"] as? Bool) ?? false, name: (a["name"] as? String) ?? "")
        }
    }

    func pendingAsks() -> [Ask] {
        guard let s = try? String(contentsOf: Router.asksURL, encoding: .utf8) else { return [] }
        var latest: [String: Ask] = [:]
        for line in s.split(separator: "\n") {
            guard let d = line.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  let pane = o["pane"] as? String, !pane.isEmpty, let ts = (o["ts"] as? NSNumber)?.doubleValue else { continue }
            if (latest[pane]?.ts ?? 0) < ts { latest[pane] = Ask(ts: ts, pane: pane, question: (o["question"] as? String) ?? "") }
        }
        let now = Date().timeIntervalSince1970
        return latest.values.filter { now - $0.ts < 3600 && (answered[$0.pane] ?? 0) < $0.ts }.sorted { $0.ts > $1.ts }
    }

    func waiting() -> [WaitItem] {
        var items = agents.filter { $0.status == "blocked" }.sorted { $0.seq > $1.seq }
            .map { WaitItem(pane: $0.pane, who: $0.short, reason: "pedindo aprovação no terminal", blocked: true) }
        for a in pendingAsks() where !items.contains(where: { $0.pane == a.pane }) {
            items.append(WaitItem(pane: a.pane, who: agent(a.pane)?.short ?? a.pane, reason: a.question, blocked: false))
        }
        return items
    }

    func agent(_ pane: String) -> HerdrAgent? { agents.first { $0.pane == pane } }

    /// O orquestrador: pelo id do painel; se o herdr renumerou, pelo nome do agente.
    var orchestrator: HerdrAgent? {
        agent(config.pane) ?? agents.first { $0.name.lowercased() == config.orchestratorName.lowercased() }
    }

    static func norm(_ s: String) -> [String] {
        s.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil).lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
    }

    func keywords(_ a: HerdrAgent) -> Set<String> {
        let base = Router.norm(URL(fileURLWithPath: a.cwd).lastPathComponent)
        var k = Set(base.filter { $0.count >= 4 && !["code", "claude", "claudecode"].contains($0) })
        k.insert(base.joined())
        if a.short.contains("grok") { k.formUnion(["grok", "grokbot", "groque", "brokbot", "brockbot", "grockbot", "grokbote"]) }
        return k
    }

    /// Decide o alvo e entrega. Roda na fila do roteador.
    func route(_ text: String) -> Result {
        let t0 = Date()
        if let file = config.outputFile { return writeToFile(file, text: text, t0: t0) }
        refresh()
        let words = Router.norm(text)
        let orch = orchestrator
        var target: HerdrAgent?
        var used = Set<String>()
        // Outro agente chamado pelo nome do herdr ou da pasta nas primeiras palavras.
        // O orquestrador (mesma pasta do ai-voice) não entra aqui: ele é o padrão.
        for a in agents where a.pane != orch?.pane && target == nil {
            if !a.name.isEmpty, words.prefix(4).contains(a.name.lowercased()) { target = a; used.insert(a.name.lowercased()); break }
            if a.cwd != orch?.cwd, let hit = words.prefix(4).first(where: { keywords(a).contains($0) }) { target = a; used.insert(hit) }
        }
        let rest = words.filter { !used.contains($0) && !Router.filler.contains($0) }.joined(separator: " ")
        let isYes = Router.yes.contains(rest), isNo = Router.no.contains(rest)
        if target == nil {
            if isYes || isNo, let b = agents.filter({ $0.status == "blocked" }).max(by: { $0.seq < $1.seq }) {
                target = b
            } else if let ask = pendingAsks().first, let a = agent(ask.pane) {
                target = a
            } else {
                target = orch
            }
        }
        guard let t = target else {
            // Lista do herdr indisponível: tenta o painel configurado assim mesmo.
            let (code, out) = steer(config.pane, Router.prefix + text)
            return Result(pane: config.pane, who: "orquestrador", mode: "steer (sem lista)", ok: code == 0,
                          detail: code == 0 ? "" : out, ms: ms(t0))
        }
        return deliver(to: t, text: text, isYes: isYes, isNo: isNo, t0: t0)
    }

    /// Estado atual do agente direto do herdr (a lista pode ter alguns segundos).
    func liveStatus(_ pane: String) -> String? {
        let (code, s) = herdr(["agent", "get", pane])
        guard code == 0, let d = s.data(using: .utf8),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let r = o["result"] as? [String: Any], let a = r["agent"] as? [String: Any] else { return nil }
        return a["agent_status"] as? String
    }

    /// Digita o texto e confirma com Ctrl+Enter: com turno em andamento o Claude Code recebe como steer
    /// (entra no meio do turno, sem fila); ocioso, envia normalmente.
    /// `agent prompt` não serve aqui porque sempre confirma com Enter, que enfileira durante o turno.
    func steer(_ pane: String, _ message: String) -> (Int32, String) {
        let (c1, o1) = herdr(["pane", "send-text", pane, message])
        guard c1 == 0 else { return (c1, o1) }
        return herdr(["agent", "send-keys", pane, "ctrl+enter"])
    }

    func deliver(to t: HerdrAgent, text: String, isYes: Bool, isNo: Bool, t0: Date = Date()) -> Result {
        if let file = config.outputFile { return writeToFile(file, text: text, t0: t0) }
        var mode: String
        var code: Int32
        var out: String
        let status = liveStatus(t.pane) ?? t.status
        if status == "blocked" && (isYes || isNo) {
            // Diálogo de permissão aberto e a frase é só "sim"/"não": aperta a tecla, sem texto.
            let key = isYes ? "Enter" : "esc"
            mode = isYes ? "aprovou (Enter)" : "recusou (Esc)"
            (code, out) = herdr(["agent", "send-keys", t.pane, key])
            emit(["type": "aprovacao", "acao": isYes ? "enter" : "esc", "pane": t.pane, "who": t.short, "text": text,
                  "ok": code == 0, "ms": ms(t0)])
        } else {
            if status == "blocked" { herdr(["agent", "send-keys", t.pane, "esc"]); Thread.sleep(forTimeInterval: 0.3) }
            mode = "steer"
            (code, out) = steer(t.pane, Router.prefix + text)
        }
        answered[t.pane] = Date().timeIntervalSince1970
        return Result(pane: t.pane, who: t.short, mode: mode, ok: code == 0, detail: code == 0 ? "" : out, ms: ms(t0))
    }

    private func writeToFile(_ path: String, text: String, t0: Date) -> Result {
        let o: [String: Any] = ["ts": ISO8601DateFormatter().string(from: Date()), "pane": config.pane, "message": Router.prefix + text]
        guard let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]) else {
            return Result(pane: "", who: "arquivo", mode: "arquivo", ok: false, detail: "json", ms: ms(t0))
        }
        let line = d + Data("\n".utf8)
        if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
        guard let h = FileHandle(forWritingAtPath: path) else {
            return Result(pane: "", who: "arquivo", mode: "arquivo", ok: false, detail: "não abriu \(path)", ms: ms(t0))
        }
        h.seekToEndOfFile(); h.write(line); h.closeFile()
        return Result(pane: path, who: "arquivo", mode: "arquivo", ok: true, detail: "", ms: ms(t0))
    }

    private func ms(_ t0: Date) -> Int { Int(Date().timeIntervalSince(t0) * 1000) }
}
