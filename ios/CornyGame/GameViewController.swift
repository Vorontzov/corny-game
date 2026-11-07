import AVFoundation
import UIKit
import WebKit

@MainActor
final class GameViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private(set) var gameView: WKWebView!
    private let store = StoreController()
    private var bridge: StoreMessageHandler!
    private var documentLoaded = false
    private var suspended = false
    private let failurePanel = UIStackView()
    private let failureText = UILabel()

    private var webDirectory: URL {
        Bundle.main.bundleURL.appendingPathComponent("Web", isDirectory: true)
    }

    private var entryURL: URL {
        webDirectory.appendingPathComponent("index.html")
    }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        UIDevice.current.userInterfaceIdiom == .pad ? .all : .allButUpsideDown
    }

    override func loadView() {
        let root = UIView()
        root.backgroundColor = UIColor(red: 0.07, green: 0.16, blue: 0.12, alpha: 1)
        view = root

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        bridge = StoreMessageHandler(owner: self)
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "cornyStore")
        configuration.userContentController.addUserScript(WKUserScript(
            source: "Object.defineProperty(window, 'cornyNativeApp', { value: true });",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))

        gameView = WKWebView(frame: .zero, configuration: configuration)
        gameView.translatesAutoresizingMaskIntoConstraints = false
        gameView.navigationDelegate = self
        gameView.uiDelegate = self
        gameView.isOpaque = false
        gameView.backgroundColor = .clear
        gameView.scrollView.backgroundColor = .clear
        gameView.scrollView.contentInsetAdjustmentBehavior = .never
        gameView.scrollView.bounces = false
        gameView.allowsBackForwardNavigationGestures = false
        gameView.allowsLinkPreview = false
        #if DEBUG
        if #available(iOS 16.4, *) { gameView.isInspectable = true }
        #endif
        root.addSubview(gameView)
        NSLayoutConstraint.activate([
            gameView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            gameView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            gameView.topAnchor.constraint(equalTo: root.topAnchor),
            gameView.bottomAnchor.constraint(equalTo: root.bottomAnchor)
        ])

        configureFailurePanel()
        store.onChange = { [weak self] in self?.notifyStoreChanged() }
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(audioInterrupted(_:)),
            name: AVAudioSession.interruptionNotification,
            object: nil
        )
        openGame()
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    private func configureFailurePanel() {
        failurePanel.axis = .vertical
        failurePanel.spacing = 20
        failurePanel.alignment = .center
        failurePanel.translatesAutoresizingMaskIntoConstraints = false
        failurePanel.isHidden = true
        failureText.numberOfLines = 0
        failureText.textAlignment = .center
        failureText.textColor = .white
        failureText.font = .preferredFont(forTextStyle: .body)
        failureText.adjustsFontForContentSizeCategory = true
        let reload = UIButton(type: .system)
        reload.setTitle("Reload game", for: .normal)
        reload.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        reload.tintColor = .systemYellow
        reload.addTarget(self, action: #selector(openGame), for: .touchUpInside)
        failurePanel.addArrangedSubview(failureText)
        failurePanel.addArrangedSubview(reload)
        view.addSubview(failurePanel)
        NSLayoutConstraint.activate([
            failurePanel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            failurePanel.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            failurePanel.leadingAnchor.constraint(greaterThanOrEqualTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            failurePanel.trailingAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            failurePanel.widthAnchor.constraint(lessThanOrEqualToConstant: 440)
        ])
    }

    @objc private func openGame() {
        guard FileManager.default.fileExists(atPath: entryURL.path) else {
            showFailure("The game files could not be opened. Please try updating Corny Game.")
            return
        }
        documentLoaded = false
        failurePanel.isHidden = true
        gameView.isHidden = false
        gameView.loadFileURL(entryURL, allowingReadAccessTo: webDirectory)
    }

    private func showFailure(_ message: String) {
        documentLoaded = false
        gameView.isHidden = true
        failureText.text = message
        failurePanel.isHidden = false
        UIAccessibility.post(notification: .screenChanged, argument: failureText)
    }

    private func isBundledURL(_ url: URL?) -> Bool {
        guard let url, url.isFileURL else { return false }
        let path = url.standardizedFileURL.resolvingSymlinksInPath().path
        let root = webDirectory.standardizedFileURL.resolvingSymlinksInPath().path + "/"
        return path.hasPrefix(root)
    }

    fileprivate func acceptsStoreMessage(_ message: WKScriptMessage) -> Bool {
        message.frameInfo.isMainFrame && message.webView === gameView &&
            isBundledURL(message.frameInfo.request.url) && isBundledURL(gameView.url)
    }

    fileprivate func handleStoreMessage(_ body: [String: Any]) async throws -> [String: Any] {
        try await store.handle(body)
    }

    private func notifyStoreChanged() {
        guard documentLoaded else { return }
        gameView.evaluateJavaScript("window.dispatchEvent(new Event('corny-store-changed'))", completionHandler: nil)
    }

    func suspendGame() {
        guard isViewLoaded else { return }
        suspended = true
        gameView.evaluateJavaScript("window.dispatchEvent(new Event('corny-app-background'))", completionHandler: nil)
        gameView.setAllMediaPlaybackSuspended(true, completionHandler: nil)
    }

    func activateGame() {
        guard isViewLoaded else { return }
        suspended = false
        gameView.setAllMediaPlaybackSuspended(false, completionHandler: nil)
        gameView.evaluateJavaScript("window.dispatchEvent(new Event('corny-app-active'))", completionHandler: nil)
    }

    @objc private func audioInterrupted(_ notification: Notification) {
        guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .began { suspendGame() }
        else if view.window?.windowScene?.activationState == .foregroundActive { activateGame() }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard isBundledURL(webView.url) else { return }
        documentLoaded = true
        failurePanel.isHidden = true
        notifyStoreChanged()
        if suspended { suspendGame() }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if navigationAction.targetFrame?.isMainFrame == true && isBundledURL(navigationAction.request.url) {
            decisionHandler(.allow)
            return
        }
        if navigationAction.navigationType == .linkActivated,
           let url = navigationAction.request.url, url.scheme?.lowercased() == "https" {
            UIApplication.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if navigationAction.navigationType == .linkActivated,
           let url = navigationAction.request.url, url.scheme?.lowercased() == "https" {
            UIApplication.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled {
            showFailure("The game could not open. Reload it to try again.")
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        self.webView(webView, didFail: navigation, withError: error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        showFailure("The game stopped running. Reload to return to your saved worlds.")
    }
}

@MainActor
private final class StoreMessageHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var owner: GameViewController?

    init(owner: GameViewController) {
        self.owner = owner
        super.init()
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard let owner, owner.acceptsStoreMessage(message), let body = message.body as? [String: Any] else {
            replyHandler(nil, "Purchases are available only inside Corny Game.")
            return
        }
        Task { @MainActor in
            do { replyHandler(try await owner.handleStoreMessage(body), nil) }
            catch { replyHandler(nil, error.localizedDescription) }
        }
    }
}
