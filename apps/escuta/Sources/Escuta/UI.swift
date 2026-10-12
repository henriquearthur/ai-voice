import Combine
import SwiftUI

extension Phase {
    var tint: Color {
        switch self {
        case .armed, .sent: return .accentColor
        case .working: return .purple
        case .error: return .red
        case .paused, .starting: return .secondary
        case .listening, .hearing: return .green
        }
    }
}

// MARK: Atualização do painel

/// Freio do painel: as mudanças do Escuta viram no máximo ~10 redesenhos por segundo, e só com o painel
/// na tela. O nível do microfone não passa por aqui: ele tem o LevelFeed, observado só pela onda.
final class PanelFeed: ObservableObject {
    private var sub: AnyCancellable?

    func attach(_ m: Escuta) {
        guard sub == nil else { return }
        sub = m.objectWillChange
            .throttle(for: .milliseconds(100), scheduler: RunLoop.main, latest: true)
            .sink { [weak self] _ in self?.objectWillChange.send() }
        objectWillChange.send()
    }

    func detach() { sub = nil }
}

/// Nível do microfone para a onda do painel. Cada buffer de áudio grava num anel pré-alocado (sem
/// alocar e sem publicar); a onda só é publicada com o painel na tela, no máximo 10 vezes por segundo.
/// Antes o nível era @Published no Escuta e cada buffer avisava o modelo inteiro (ícone e painel).
final class LevelFeed: ObservableObject {
    static let count = 56
    @Published private(set) var levels = [Float](repeating: 0, count: LevelFeed.count)
    private var ring = [Float](repeating: 0, count: LevelFeed.count)
    private var head = 0           // próxima posição do anel (a mais antiga)
    private var dirty = false
    private var lastPublish: UInt64 = 0
    private static let interval: UInt64 = 100_000_000   // 100 ms = 10 Hz
    /// Painel na tela. Fechado, nada é publicado.
    var visible = false {
        didSet { if visible && !oldValue { publish() } }
    }

    /// Thread principal, uma vez por buffer de áudio.
    func push(_ level: Float) {
        ring[head] = level
        head = (head + 1) % Self.count
        dirty = true
        guard visible else { return }
        let now = DispatchTime.now().uptimeNanoseconds
        if now &- lastPublish >= Self.interval { publish(at: now) }
    }

    private func publish(at now: UInt64 = DispatchTime.now().uptimeNanoseconds) {
        lastPublish = now
        guard dirty else { return }
        dirty = false
        levels = Array(ring[head...] + ring[..<head])
    }
}

// MARK: Histórico

/// Um item do histórico: um pedido enviado ou uma frase descartada. Cada fala aparece uma vez só.
enum HistoryItem: Identifiable {
    case command(Command)
    case ignored(Heard)

    var id: String {
        switch self {
        case .command(let c): return "c\(c.id)"
        case .ignored(let h): return "h\(h.id.uuidString)"
        }
    }
    var at: Date {
        switch self {
        case .command(let c): return c.at
        case .ignored(let h): return h.at
        }
    }
    var key: String {
        let t: String
        switch self {
        case .command(let c): t = c.text
        case .ignored(let h): t = h.text
        }
        return t.lowercased().filter { $0.isLetter || $0.isNumber }
    }

    /// `heard` guarda toda frase ouvida e `commands` guarda as que viraram pedido: a mesma fala
    /// estava nas duas listas. Aqui o pedido representa a fala; de `heard` só entra o que não foi enviado.
    /// Repetição do mesmo texto em poucos segundos (reconhecedor reiniciado) também sai.
    static func merge(commands: [Command], heard: [Heard], limit: Int) -> [HistoryItem] {
        let all = commands.map(HistoryItem.command)
            + heard.filter { ($0.command ?? "").isEmpty }.map(HistoryItem.ignored)
        var out: [HistoryItem] = []
        for item in all.sorted(by: { $0.at > $1.at }) {
            let k = item.key
            if k.isEmpty { continue }
            if out.contains(where: { $0.key == k && abs($0.at.timeIntervalSince(item.at)) < 10 }) { continue }
            out.append(item)
            if out.count == limit { break }
        }
        return out
    }
}

// MARK: Componentes

struct LevelMeter: View {
    @ObservedObject var feed: LevelFeed
    let tint: Color
    var body: some View {
        Canvas { ctx, size in
            let bars = feed.levels.suffix(40)
            let n = bars.count
            guard n > 0 else { return }
            let gap: CGFloat = 2
            let w = (size.width - gap * CGFloat(n - 1)) / CGFloat(n)
            for (i, l) in bars.enumerated() {
                let h = max(2, CGFloat(l) * size.height)
                let r = CGRect(x: CGFloat(i) * (w + gap), y: (size.height - h) / 2, width: w, height: h)
                ctx.fill(Path(roundedRect: r, cornerRadius: w / 2), with: .color(tint.opacity(0.3 + Double(l) * 0.7)))
            }
        }
        .frame(height: 28)
        .accessibilityLabel("Nível do microfone")
    }
}

struct DeviceRow: View {
    let icon: String
    let title: String
    let value: String
    let ok: Bool?
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon).frame(width: 16).foregroundStyle(.secondary)
            Text(title).foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Text(value).lineLimit(1).truncationMode(.middle)
            if let ok {
                Image(systemName: ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                    .foregroundStyle(ok ? .green : .orange)
                    .imageScale(.small)
            }
        }
        .font(.caption)
    }
}

struct CommandRow: View {
    let c: Command
    var badge: (String, String, Color) {
        switch c.state {
        case "entregue": return ("Entregue a \(c.target ?? "?")", "checkmark.circle.fill", .green)
        case "falhou": return ("Falhou", "xmark.octagon.fill", .red)
        case "recebido": return ("Claude trabalhando", "ellipsis.bubble.fill", .purple)
        case "respondido": return ("Respondido pela Echo", "speaker.wave.2.fill", .green)
        default: return ("Enviado", "paperplane.fill", .accentColor)
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Label(badge.0, systemImage: badge.1)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(badge.2)
                    .lineLimit(1)
                Spacer(minLength: 6)
                Text(c.at, style: .time).font(.caption.monospacedDigit()).foregroundStyle(.tertiary)
            }
            Text(c.text)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            if let r = c.reply {
                Text(r)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if c.speechMs != nil || c.deliverMs != nil {
                HStack(spacing: 10) {
                    if let s = c.speechMs { Text("fala→texto \(s) ms") }
                    if let d = c.deliverMs { Text("entrega \(d) ms") }
                    if let m = c.mode { Text(m) }
                }
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 8)
    }
}

struct IgnoredRow: View {
    let h: Heard
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "minus.circle").foregroundStyle(.tertiary).imageScale(.small)
            Text(h.text)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            Spacer(minLength: 6)
            Text(h.at, style: .time).font(.caption.monospacedDigit()).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 6)
        .help("Descartada: ruído, curta demais ou sem confiança.")
    }
}

// MARK: Painel

struct PanelView: View {
    let m: Escuta
    @StateObject private var feed = PanelFeed()

    init(m: Escuta) { self.m = m }

    private var speaking: Bool { m.jarvisSpeaking && m.phase != .paused }

    private var stateTitle: String {
        if speaking { return "Jarvis falando" }
        switch m.phase {
        case .starting: return "Iniciando"
        case .listening: return "Ouvindo"
        case .hearing: return "Ouvindo você"
        case .armed: return "Pode falar"
        case .sent: return "Pedido enviado"
        case .working: return "Claude trabalhando"
        case .paused: return "Escuta pausada"
        case .error: return "Erro"
        }
    }
    private var stateSymbol: String { speaking ? "speaker.wave.2.fill" : m.phase.symbol }
    private var stateTint: Color { speaking ? .orange : m.phase.tint }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            meterCard
            alerts
            if !m.waiting.isEmpty { waitingSection }
            historySection
            devices
            Divider()
            footer
        }
        .padding(16)
        .frame(width: 360)
        .onAppear { feed.attach(m); m.levelFeed.visible = true }
        .onDisappear { feed.detach(); m.levelFeed.visible = false }
    }

    // Estado, microfone e janela do Jarvis.
    private var header: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle().fill(stateTint.opacity(0.16)).frame(width: 38, height: 38)
                Image(systemName: stateSymbol)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(stateTint)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(stateTitle).font(.headline)
                Label(m.micName, systemImage: m.phase == .paused ? "mic.slash" : "mic")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 8)
            if let until = m.armedUntil, until > Date() {
                TimelineView(.periodic(from: .now, by: 0.5)) { _ in
                    let left = max(0, until.timeIntervalSinceNow)
                    Gauge(value: left, in: 0...max(m.config.armedWindow, left)) { EmptyView() } currentValueLabel: {
                        Text("\(Int(left.rounded(.up)))").font(.caption.monospacedDigit())
                    }
                    .gaugeStyle(.accessoryCircularCapacity)
                    .tint(.accentColor)
                    .scaleEffect(0.65)
                    .frame(width: 32, height: 32)
                    .help("Janela para falar sem dizer “Jarvis”")
                }
            } else if let w = m.lastWakeAt, Date().timeIntervalSince(w) < 4 {
                Image(systemName: "checkmark.seal.fill").foregroundStyle(Color.accentColor).font(.title3)
            }
        }
    }

    // Nível de áudio e o que está sendo transcrito agora.
    private var meterCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            LevelMeter(feed: m.levelFeed, tint: m.phase == .paused ? .secondary : stateTint)
                .opacity(m.phase == .paused ? 0.4 : 1)
            Group {
                if !m.partial.isEmpty {
                    Text(m.partial).foregroundStyle(.primary)
                } else if speaking {
                    Text("A voz do Jarvis não é transcrita.").foregroundStyle(.secondary)
                } else if m.phase == .paused {
                    Text("Microfone fechado.").foregroundStyle(.secondary)
                } else {
                    Text("Diga “Jarvis” e o pedido.").foregroundStyle(.secondary)
                }
            }
            .font(.callout)
            .lineLimit(2)
            .frame(maxWidth: .infinity, minHeight: 36, alignment: .topLeading)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(.quaternary.opacity(0.45)))
    }

    @ViewBuilder private var alerts: some View {
        if let e = m.errorText {
            Label(e, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.red).font(.callout)
                .fixedSize(horizontal: false, vertical: true)
        } else if m.silentFor > 0 && m.phase != .paused {
            Label("Sem áudio do microfone há \(m.silentFor) s", systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange).font(.callout)
        }
    }

    private var waitingSection: some View {
        section("Esperando você") {
            ForEach(m.waiting) { w in
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: w.blocked ? "hand.raised.fill" : "questionmark.bubble.fill")
                        .foregroundStyle(.orange)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(w.who).font(.callout.weight(.semibold))
                        Text(w.reason).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                    Spacer()
                    Button("Sim") { m.answer(w, yes: true) }.buttonStyle(.borderedProminent).controlSize(.small)
                    Button("Não") { m.answer(w, yes: false) }.controlSize(.small)
                }
            }
            Text("Ou diga “Jarvis, sim” ou “Jarvis, grokbot não”.").font(.caption).foregroundStyle(.tertiary)
        }
    }

    private var historySection: some View {
        let items = HistoryItem.merge(commands: m.commands, heard: m.heard, limit: 6)
        return section("Histórico") {
            if items.isEmpty {
                Text("Nada ainda. Fale perto do Mac.").foregroundStyle(.secondary).font(.callout)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
                            if i > 0 { Divider() }
                            switch item {
                            case .command(let c): CommandRow(c: c)
                            case .ignored(let h): IgnoredRow(h: h)
                            }
                        }
                    }
                }
                .frame(maxHeight: 240)
            }
        }
    }

    private var devices: some View {
        VStack(spacing: 6) {
            if let n = m.airpodsName {
                DeviceRow(icon: "airpodspro", title: n,
                          value: m.airpodsRate >= 44100 ? "\(Int(m.airpodsRate / 1000)) kHz · estéreo" : "\(Int(m.airpodsRate / 1000)) kHz · modo chamada",
                          ok: m.airpodsRate >= 44100)
            }
            DeviceRow(icon: "text.bubble", title: "Reconhecimento", value: m.recognizerState, ok: m.recognizerState == "ok")
            Text(m.diag)
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.tertiary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var footer: some View {
        HStack {
            Button { m.togglePause() } label: {
                Label(m.isPaused ? "Retomar" : "Pausar", systemImage: m.isPaused ? "play.fill" : "pause.fill")
            }
            Button { m.restart(reason: "botão Reiniciar") } label: { Label("Reiniciar", systemImage: "arrow.clockwise") }
            Spacer()
            Button("Sair") { m.quit() }.keyboardShortcut("q")
        }
        .controlSize(.regular)
    }

    private func section<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
            content()
        }
    }
}
