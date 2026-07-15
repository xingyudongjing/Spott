import CryptoKit
import Foundation
import Security

enum AppleSignInNonce {
    static let allowedCharacters = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")

    static func generate(length: Int = 32) throws -> String {
        guard length > 0 else { throw NonceError.invalidLength }

        var result = String()
        result.reserveCapacity(length)

        while result.count < length {
            var randomByte: UInt8 = 0
            let status = SecRandomCopyBytes(kSecRandomDefault, 1, &randomByte)
            guard status == errSecSuccess else { throw NonceError.randomGenerationFailed(status) }

            if randomByte < allowedCharacters.count {
                result.append(allowedCharacters[Int(randomByte)])
            }
        }
        return result
    }

    static func sha256(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    enum NonceError: Error, Sendable {
        case invalidLength
        case randomGenerationFailed(OSStatus)
    }
}
