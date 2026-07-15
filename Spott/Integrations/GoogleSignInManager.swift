import GoogleSignIn
import UIKit

@MainActor
final class GoogleSignInManager {
    enum SignInError: Error, Equatable {
        case notConfigured
        case presentationUnavailable
        case missingIdentityToken
        case cancelled
        case providerFailed
    }

    static let shared = GoogleSignInManager()

    private let configuration: GoogleOAuthConfiguration?

    init(bundle: Bundle = .main) {
        configuration = try? GoogleOAuthConfiguration(bundle: bundle)
    }

    var isConfigured: Bool { configuration != nil }

    func signIn() async throws -> String {
        guard let configuration else { throw SignInError.notConfigured }
        guard let presenter = UIApplication.shared.spottTopViewController else {
            throw SignInError.presentationUnavailable
        }

        GIDSignIn.sharedInstance.configuration = GIDConfiguration(
            clientID: configuration.clientID,
            serverClientID: configuration.serverClientID
        )

        return try await withCheckedThrowingContinuation { continuation in
            GIDSignIn.sharedInstance.signIn(withPresenting: presenter) { result, error in
                if let error = error as NSError? {
                    if error.domain == kGIDSignInErrorDomain, error.code == -5 {
                        continuation.resume(throwing: SignInError.cancelled)
                    } else {
                        continuation.resume(throwing: SignInError.providerFailed)
                    }
                    return
                }
                guard let token = result?.user.idToken?.tokenString, !token.isEmpty else {
                    continuation.resume(throwing: SignInError.missingIdentityToken)
                    return
                }
                continuation.resume(returning: token)
            }
        }
    }

    func handle(_ url: URL) -> Bool {
        GIDSignIn.sharedInstance.handle(url)
    }

    func signOut() {
        GIDSignIn.sharedInstance.signOut()
    }
}

@MainActor
private extension UIApplication {
    var spottTopViewController: UIViewController? {
        let keyWindow = connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)
        return keyWindow?.rootViewController?.spottVisibleViewController
    }
}

@MainActor
private extension UIViewController {
    var spottVisibleViewController: UIViewController {
        if let presentedViewController {
            return presentedViewController.spottVisibleViewController
        }
        if let navigation = self as? UINavigationController {
            return navigation.visibleViewController?.spottVisibleViewController ?? navigation
        }
        if let tab = self as? UITabBarController {
            return tab.selectedViewController?.spottVisibleViewController ?? tab
        }
        return self
    }
}
