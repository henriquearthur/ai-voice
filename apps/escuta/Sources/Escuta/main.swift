// Escuta do Jarvis: ouve sempre, transcreve em pt-BR no próprio Mac e, quando a frase começa com
// "Jarvis" (ou "camarada"), entrega o pedido inteiro, numa mensagem só, à sessão do orquestrador no herdr.
// Roda como LaunchAgent (dev.jarvis.escuta) com ícone na barra de menus.
//
// Testes sem microfone:  Escuta --audio fala.aiff --saida /tmp/pedidos.jsonl
import AppKit
import Combine
import SwiftUI

setvbuf(stdout, nil, _IOLBF, 0)
signal(SIGPIPE, SIG_IGN)

let config = Config.load()

/// Ícone na barra de menus (sem Dock). Clicar abre o painel com a onda sonora, estado, pedidos e controles.
final class StatusBar: NSObject {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let popover = NSPopover()
    private let model: Escuta
    private var bag: Set<AnyCancellable> = []
    private var lastSymbol = ""

    init(model: Escuta) {
        self.model = model
        super.init()
        popover.behavior = .transient
        popover.animates = false
        let host = NSHostingController(rootView: PanelView(m: model))
        host.sizingOptions = [.preferredContentSize]
        popover.contentViewController = host
        item.button?.target = self
        item.button?.action = #selector(toggle)
        item.button?.toolTip = "Escuta do Jarvis"
        model.objectWillChange
            .receive(on: RunLoop.main)
            .throttle(for: .milliseconds(200), scheduler: RunLoop.main, latest: true)
            .sink { [weak self] _ in DispatchQueue.main.async { self?.refreshIcon() } }
            .store(in: &bag)
        refreshIcon()
        if CommandLine.arguments.contains("--abrir-painel") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.toggle() }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            let f = self?.item.button?.window?.frame ?? .zero
            logLine("ícone na barra de menus: \(self?.item.isVisible == true ? "visível" : "oculto") em \(Int(f.minX)),\(Int(f.minY)) \(Int(f.width))x\(Int(f.height))")
        }
    }

    private func refreshIcon() {
        let symbol = model.jarvisSpeaking ? "speaker.wave.2.fill" : model.phase.symbol
        guard symbol != lastSymbol else { return }
        lastSymbol = symbol
        let img = NSImage(systemSymbolName: symbol, accessibilityDescription: model.phase.label)
        img?.isTemplate = true
        item.button?.image = img
    }

    @objc private func toggle() {
        guard let button = item.button else { return }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            NSApp.activate(ignoringOtherApps: true)
            // Tamanho certo antes de abrir: senão o painel cresce depois e sobe por cima da barra.
            if let v = popover.contentViewController?.view {
                v.layoutSubtreeIfNeeded()
                popover.contentSize = v.fittingSize
            }
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
            let f = popover.contentViewController?.view.window?.frame ?? .zero
            logLine("painel aberto (\(Int(f.width))x\(Int(f.height)))")
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var model: Escuta?
    var bar: StatusBar?
    func applicationDidFinishLaunching(_ n: Notification) {
        NSApp.setActivationPolicy(.accessory)
        let m = Escuta(config: config)
        model = m
        if !config.headless { bar = StatusBar(model: m) }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
