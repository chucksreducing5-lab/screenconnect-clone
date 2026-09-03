import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }

        connectionOptions.urlContexts.first.map(applyJoinLink)

        let window = UIWindow(windowScene: windowScene)
        let viewController = ViewController()
        viewController.view.backgroundColor = .systemBackground
        window.rootViewController = UINavigationController(rootViewController: viewController)
        self.window = window
        window.makeKeyAndVisible()
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        URLContexts.first.map(applyJoinLink)
    }

    private func applyJoinLink(_ context: UIOpenURLContext) {
        let url = context.url
        guard url.host == "join" else { return }
        let defaults = UserDefaults(suiteName: "group.top.helpsupport.remotesupport")
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        for (key, name) in [("server", "serverUrl"), ("sessionId", "sessionId"), ("token", "token")] {
            if let value = items.first(where: { $0.name == key })?.value, !value.isEmpty {
                defaults?.set(value, forKey: name)
            }
        }
        defaults?.synchronize()
    }
}
