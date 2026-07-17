import Foundation

final class AuthenticationExpirationBoundary: @unchecked Sendable {
    typealias Handler = @Sendable (UUID) async -> Void

    private let lock = NSLock()
    private var handler: Handler?

    func setHandler(_ handler: @escaping Handler) {
        lock.withLock { self.handler = handler }
    }

    func expire(sessionID: UUID) async {
        let handler: Handler? = lock.withLock { self.handler }
        await handler?(sessionID)
    }
}
