import Foundation
import Security

protocol CredentialStoring: Actor {
    func save(session: UserSession) throws
    @discardableResult
    func replace(session: UserSession, expectedSessionID: UUID) throws -> Bool
    func session() throws -> UserSession?
    @discardableResult
    func clear(expectedSessionID: UUID) throws -> Bool
}

actor CredentialVault: CredentialStoring {
    private let service: String
    private let account = "active-session"
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(service: String) {
        self.service = service
        encoder.dateEncodingStrategy = .iso8601
        decoder.dateDecodingStrategy = .iso8601
    }

    func save(session: UserSession) throws {
        try write(session: session)
    }

    @discardableResult
    func replace(session: UserSession, expectedSessionID: UUID) throws -> Bool {
        guard try self.session()?.sessionId == expectedSessionID else { return false }
        try write(session: session)
        return true
    }

    private func write(session: UserSession) throws {
        let data = try encoder.encode(session)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(query as CFDictionary)
        var insert = query
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(insert as CFDictionary, nil)
        guard status == errSecSuccess else { throw VaultError.status(status) }
    }

    func session() throws -> UserSession? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var value: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = value as? Data else { throw VaultError.status(status) }
        do {
            return try decoder.decode(UserSession.self, from: data)
        } catch {
            throw VaultError.invalidSession
        }
    }

    @discardableResult
    func clear(expectedSessionID: UUID) throws -> Bool {
        guard try session()?.sessionId == expectedSessionID else { return false }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw VaultError.status(status) }
        return status == errSecSuccess
    }
}

enum VaultError: Error, Sendable {
    case status(OSStatus)
    case invalidSession
}
