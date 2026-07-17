import Foundation

struct AuthenticationChallengeTarget: Equatable, Sendable {
    private(set) var lockedValue: String?

    mutating func lock(_ value: String) {
        lockedValue = value
    }

    mutating func reset() {
        lockedValue = nil
    }

    func accepts(_ value: String) -> Bool {
        lockedValue == nil || lockedValue == value
    }
}

struct AuthenticationGateOperationAuthority: Equatable, Sendable {
    private var generation = 0

    mutating func begin() -> Int {
        generation &+= 1
        return generation
    }

    mutating func cancel() {
        generation &+= 1
    }

    func isCurrent(_ candidate: Int) -> Bool {
        candidate == generation
    }
}
