import Testing
@testable import Spott

struct AuthenticationGatePolicyTests {
    @Test func aChallengeLocksTheExactDestinationUntilTheUserExplicitlyChangesIt() {
        var target = AuthenticationChallengeTarget()

        target.lock("first@example.com")

        #expect(target.lockedValue == "first@example.com")
        #expect(target.accepts("first@example.com"))
        #expect(!target.accepts("second@example.com"))

        target.reset()
        #expect(target.lockedValue == nil)
        #expect(target.accepts("second@example.com"))
    }

    @Test func cancellingOrStartingAnotherOperationInvalidatesEveryLateResult() {
        var authority = AuthenticationGateOperationAuthority()
        let first = authority.begin()
        #expect(authority.isCurrent(first))

        authority.cancel()
        #expect(!authority.isCurrent(first))

        let second = authority.begin()
        let third = authority.begin()
        #expect(!authority.isCurrent(second))
        #expect(authority.isCurrent(third))
    }
}
