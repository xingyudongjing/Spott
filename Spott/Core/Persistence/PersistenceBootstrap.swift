import Foundation

protocol AuthenticatedOwnerProviding: Actor {
    func authenticatedOwnerScope() async throws -> String?
}
/// Read-only Keychain adapter used before persistence bootstrap. It deliberately
/// returns only the normalized user ID and never exposes either session token.
actor KeychainAuthenticatedOwnerProvider: AuthenticatedOwnerProviding {
    private let credentials: any CredentialStoring

    init(credentials: any CredentialStoring) {
        self.credentials = credentials
    }

    func authenticatedOwnerScope() async throws -> String? {
        guard let session = try await credentials.session() else { return nil }
        return session.user.id.uuidString.lowercased()
    }
}
