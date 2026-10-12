import AppKit
import ServiceManagement
import WebKit

/// Casca nativa do dashboard: janela com WKWebView, ícone na barra de menus, abrir no login e atalho global.
/// Fechar a janela só a esconde (o app sai do Dock e fica na barra de menus); ⌘Q encerra de verdade.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private let server = Server()
    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusItem: NSStatusItem!
    private var hotKey: HotKey?
    private var connecting = false

    private static let retryURL = URL(string: "jarvis-app://tentar-de-novo")!
    private static let zoomKey = "pageZoom"
    private static let loginConfiguredKey = "loginItemConfigured"

    // MARK: Ciclo de vida

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = buildMainMenu()
        buildWindow()
        buildStatusItem()
        configureLoginItemOnFirstRun()
        hotKey = HotKey { [weak self] in self?.toggleWindow() }
        showWindow()
        connect()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        hideWindow()
        return false
    }

    // MARK: Janela

    private func buildWindow() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.applicationNameForUserAgent = "JarvisDesktop/1.0"
        config.preferences.isElementFullscreenEnabled = true

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsMagnification = true
        let zoom = UserDefaults.standard.double(forKey: Self.zoomKey)
        if zoom > 0 { webView.pageZoom = zoom }

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Jarvis"
        window.minSize = NSSize(width: 720, height: 480)
        window.contentView = webView
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.center()
        window.setFrameAutosaveName("JarvisMain")
    }

    @objc func showWindow() {
        NSApp.setActivationPolicy(.regular)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    private func hideWindow() {
        window.orderOut(nil)
        NSApp.setActivationPolicy(.accessory)
    }

    @objc func toggleWindow() {
        if window.isVisible && NSApp.isActive && window.isKeyWindow { hideWindow() } else { showWindow() }
    }

    // MARK: Servidor

    /// Confere (e se preciso sobe) o servidor e carrega o dashboard; enquanto isso mostra uma tela de espera.
    private func connect() {
        guard !connecting else { return }
        connecting = true
        let server = server
        Task.detached { server.ensureAllAgents() }
        Task { @MainActor in
            defer { connecting = false }
            if await server.isUp() {
                load()
                return
            }
            // Máquina nova: sem o LaunchAgent do dashboard, prepara o mínimo e abre o onboarding.
            if !server.dashboardInstalled {
                showStatusPage(
                    title: "Preparando o Jarvis pela primeira vez…",
                    detail: "Instalando o Bun se faltar, as dependências e o dashboard. Leva alguns minutos; "
                        + "o log fica em ~/.local/share/jarvis/onboarding/primeira-execucao.log.",
                    retry: false)
                let result = await server.bootstrap()
                if !result.ok {
                    showStatusPage(title: "Não deu para preparar o Jarvis", detail: result.tail, retry: true)
                    return
                }
            }
            showStatusPage(title: "Ligando o Jarvis…", detail: "Subindo o servidor do dashboard pelo launchd.", retry: false)
            if await server.ensureUp() {
                load()
            } else {
                showStatusPage(
                    title: "O servidor do Jarvis não respondeu",
                    detail: "Nada em \(server.url.absoluteString). Veja ~/.local/share/jarvis/dashboard/logs/server.err.log "
                        + "ou reinstale com apps/dashboard/scripts/install-launchagent.sh.",
                    retry: true)
            }
        }
    }

    /// Abre o dashboard; na primeira execução (sem config concluída), direto no onboarding.
    private func load() {
        webView.load(URLRequest(url: server.isConfigured ? server.url : server.onboardingURL))
    }

    /// Configurações: refaz o onboarding (dependências, modelos, módulos e segredos).
    @objc func openSettings() {
        showWindow()
        webView.load(URLRequest(url: server.settingsURL))
    }

    @objc func reload() {
        if webView.url?.host == server.url.host { webView.reload() } else { connect() }
    }

    @objc func restartServer() {
        showStatusPage(title: "Reiniciando o servidor…", detail: "kickstart -k \(Server.label)", retry: false)
        Task { @MainActor in
            if await server.restart() { load() } else { connect() }
        }
    }

    private func showStatusPage(title: String, detail: String, retry: Bool) {
        let button = retry ? "<p><a href=\"\(Self.retryURL.absoluteString)\">Tentar de novo</a></p>" : "<div class=spin></div>"
        let html = """
        <!doctype html><html lang=pt-BR><meta charset=utf-8><style>
        :root{color-scheme:light dark;--bg:#f4f5fa;--fg:#1f2547;--mute:#5b6178;--acc:#d0542b}
        @media (prefers-color-scheme:dark){:root{--bg:#0a0e1f;--fg:#f2f4fa;--mute:#9aa0b8}}
        body{margin:0;height:100vh;display:grid;place-content:center;text-align:center;background:var(--bg);color:var(--fg);
        font:15px/1.5 -apple-system,system-ui;padding:0 32px}
        h1{font-size:20px;font-weight:600;margin:0 0 8px}p{color:var(--mute);margin:0 auto 16px;max-width:520px}
        a{display:inline-block;padding:8px 18px;border-radius:8px;background:var(--acc);color:#fff;text-decoration:none}
        .spin{width:22px;height:22px;margin:8px auto;border:3px solid var(--mute);border-top-color:var(--acc);border-radius:50%;
        animation:r .8s linear infinite}@keyframes r{to{transform:rotate(1turn)}}
        </style><h1>\(escape(title))</h1><p>\(escape(detail))</p>\(button)</html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    private func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
    }

    // MARK: WKNavigationDelegate / WKUIDelegate

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.allow) }
        if url == Self.retryURL {
            decisionHandler(.cancel)
            connect()
            return
        }
        // Links para fora do dashboard abrem no navegador padrão; iframes embutidos seguem normais.
        let external = ["http", "https"].contains(url.scheme ?? "") && url.host != server.url.host
        if external && action.targetFrame?.isMainFrame == true {
            decisionHandler(.cancel)
            NSWorkspace.shared.open(url)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        connect()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        connect()
    }

    /// target=_blank e window.open: abre no navegador padrão.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancelar")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    // MARK: Zoom

    @objc func zoomIn() { setZoom(webView.pageZoom * 1.1) }
    @objc func zoomOut() { setZoom(webView.pageZoom / 1.1) }
    @objc func zoomReset() { setZoom(1) }

    private func setZoom(_ value: Double) {
        webView.pageZoom = min(max(value, 0.5), 3)
        UserDefaults.standard.set(webView.pageZoom, forKey: Self.zoomKey)
    }

    // MARK: Abrir no login

    private func configureLoginItemOnFirstRun() {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: Self.loginConfiguredKey) else { return }
        if SMAppService.mainApp.status != .enabled { try? SMAppService.mainApp.register() }
        defaults.set(true, forKey: Self.loginConfiguredKey)
    }

    @objc func toggleLoginItem() {
        let service = SMAppService.mainApp
        do {
            if service.status == .enabled { try service.unregister() } else { try service.register() }
        } catch {
            NSAlert(error: error).runModal()
        }
    }

    // MARK: Menus

    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let image = NSImage(systemSymbolName: "waveform", accessibilityDescription: "Jarvis")
        image?.isTemplate = true
        statusItem.button?.image = image
        statusItem.button?.toolTip = "Jarvis"

        let menu = NSMenu()
        menu.addItem(item("Abrir o Jarvis", #selector(showWindow), "j", [.control, .option]))
        menu.addItem(item("Recarregar", #selector(reload)))
        menu.addItem(item("Configurações…", #selector(openSettings), ","))
        menu.addItem(item("Reiniciar o servidor", #selector(restartServer)))
        menu.addItem(.separator())
        menu.addItem(item("Abrir no login", #selector(toggleLoginItem)))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Encerrar o Jarvis", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        statusItem.menu = menu
    }

    private func buildMainMenu() -> NSMenu {
        let main = NSMenu()

        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "Sobre o Jarvis",
                                   action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""))
        appMenu.addItem(.separator())
        appMenu.addItem(item("Configurações…", #selector(openSettings), ","))
        appMenu.addItem(item("Abrir no login", #selector(toggleLoginItem)))
        appMenu.addItem(item("Reiniciar o servidor", #selector(restartServer)))
        appMenu.addItem(.separator())
        appMenu.addItem(NSMenuItem(title: "Ocultar o Jarvis", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"))
        let others = NSMenuItem(title: "Ocultar os outros", action: #selector(NSApplication.hideOtherApplications(_:)),
                                keyEquivalent: "h")
        others.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(others)
        appMenu.addItem(.separator())
        appMenu.addItem(NSMenuItem(title: "Encerrar o Jarvis", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        main.addItem(submenu("Jarvis", appMenu))

        let edit = NSMenu(title: "Editar")
        edit.addItem(NSMenuItem(title: "Desfazer", action: Selector(("undo:")), keyEquivalent: "z"))
        let redo = NSMenuItem(title: "Refazer", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(redo)
        edit.addItem(.separator())
        edit.addItem(NSMenuItem(title: "Recortar", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        edit.addItem(NSMenuItem(title: "Copiar", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        edit.addItem(NSMenuItem(title: "Colar", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        edit.addItem(NSMenuItem(title: "Selecionar tudo", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        main.addItem(submenu("Editar", edit))

        let view = NSMenu(title: "Visualizar")
        view.addItem(item("Recarregar", #selector(reload), "r"))
        view.addItem(.separator())
        view.addItem(item("Tamanho real", #selector(zoomReset), "0"))
        view.addItem(item("Aumentar", #selector(zoomIn), "+"))
        view.addItem(item("Diminuir", #selector(zoomOut), "-"))
        view.addItem(.separator())
        let fullScreen = NSMenuItem(title: "Tela cheia", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        view.addItem(fullScreen)
        main.addItem(submenu("Visualizar", view))

        let windowMenu = NSMenu(title: "Janela")
        windowMenu.addItem(NSMenuItem(title: "Minimizar", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"))
        windowMenu.addItem(NSMenuItem(title: "Fechar", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
        main.addItem(submenu("Janela", windowMenu))
        NSApp.windowsMenu = windowMenu

        return main
    }

    private func item(_ title: String, _ action: Selector, _ key: String = "",
                      _ modifiers: NSEvent.ModifierFlags = .command) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = modifiers
        item.target = self
        return item
    }

    private func submenu(_ title: String, _ menu: NSMenu) -> NSMenuItem {
        menu.title = title
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.submenu = menu
        return item
    }
}

extension AppDelegate: NSMenuItemValidation {
    /// Marca "Abrir no login" conforme o estado real no macOS (o usuário pode mudar em Ajustes > Geral > Itens de Início).
    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(toggleLoginItem) {
            item.state = SMAppService.mainApp.status == .enabled ? .on : .off
        }
        return true
    }
}
