import SwiftUI
import XCTest
@testable import Spott

@MainActor
final class AppRouterTests: XCTestCase {
    private let firstEvent = EventSummary.samples[0]
    private let secondEvent = EventSummary.samples[1]

    func testEveryTabKeepsAnIndependentNavigationPath() {
        let router = AppRouter()

        router.selectedTab = .activities
        router.show(event: firstEvent)
        router.selectedTab = .profile
        router.show(event: secondEvent)

        XCTAssertEqual(router.path(for: .activities), [.event(.init(event: firstEvent))])
        XCTAssertEqual(router.path(for: .profile), [.event(.init(event: secondEvent))])
        XCTAssertTrue(router.path(for: .discovery).isEmpty)
    }

    func testBindingWritesOnlyTheRequestedTabPath() {
        let router = AppRouter()
        let discovery = router.binding(for: .discovery)
        let activities = router.binding(for: .activities)

        discovery.wrappedValue = [.notifications]
        activities.wrappedValue = [.wallet]

        XCTAssertEqual(router.path(for: .discovery), [.notifications])
        XCTAssertEqual(router.path(for: .activities), [.wallet])
        XCTAssertTrue(router.path(for: .groups).isEmpty)
    }

    func testExplicitTabPushSelectsThatTabWithoutDestroyingOtherHistory() {
        let router = AppRouter()
        router.setPath([.notifications], for: .discovery)

        router.show(event: firstEvent, in: .activities)

        XCTAssertEqual(router.selectedTab, .activities)
        XCTAssertEqual(router.path(for: .activities), [.event(.init(event: firstEvent))])
        XCTAssertEqual(router.path(for: .discovery), [.notifications])
    }

    func testTrustedEventDeepLinkSwitchesTabThenAppendsStableReference() async throws {
        let router = AppRouter()
        router.setPath([.wallet], for: .activities)
        let url = try XCTUnwrap(URL(string: "https://spott.jp/e/summer-night?tab=activities"))

        let opened = await router.open(url: url)
        XCTAssertTrue(opened)

        XCTAssertEqual(router.selectedTab, .activities)
        XCTAssertEqual(
            router.path(for: .activities),
            [.wallet, .event(.init(id: nil, slug: "summer-night"))]
        )
    }

    func testMalformedAndExternalURLsDoNotMutateNavigation() async throws {
        let router = AppRouter()
        router.setPath([.notifications], for: .discovery)

        let externalOpened = await router.open(
            url: try XCTUnwrap(URL(string: "https://evil.example/e/private"))
        )
        let malformedOpened = await router.open(
            url: try XCTUnwrap(URL(string: "https://spott.jp/e/%20"))
        )
        XCTAssertFalse(externalOpened)
        XCTAssertFalse(malformedOpened)

        XCTAssertEqual(router.selectedTab, .discovery)
        XCTAssertEqual(router.path(for: .discovery), [.notifications])
    }

    func testDeferredRegistrationResumesExactlyOnceAfterMatchingGate() {
        let router = AppRouter()
        router.selectedTab = .activities
        router.setPath([.wallet, .event(.init(event: firstEvent))], for: .activities)
        let draft = DeferredRegistrationDraft(
            partySize: 3,
            joinWaitlistIfFull: true,
            answers: [UUID(uuidString: "019b0000-0000-7000-8100-000000000077")!: .text("Vegetarian")],
            attendeeNote: "Step-free access"
        )

        router.deferRegistration(
            for: firstEvent,
            action: .register,
            draft: draft,
            requiring: .login
        )

        XCTAssertNil(router.resumeDeferredIntent(after: .phoneVerification))
        let resumed = router.resumeDeferredIntent(after: .login)
        XCTAssertEqual(resumed?.draft, draft)
        XCTAssertEqual(resumed?.sourceTab, .activities)
        XCTAssertEqual(resumed?.sourcePath, [.wallet, .event(.init(event: firstEvent))])
        XCTAssertNil(router.resumeDeferredIntent(after: .login))
    }

    func testGateCancellationLeavesOriginalPathAndClearsIntent() {
        let router = AppRouter()
        router.selectedTab = .profile
        router.setPath([.settings, .event(.init(event: firstEvent))], for: .profile)
        router.deferRegistration(for: firstEvent, action: .joinWaitlist, requiring: .phoneVerification)

        router.cancelDeferredIntent()

        XCTAssertNil(router.deferredRegistrationIntent)
        XCTAssertNil(router.pendingRegistrationPresentation)
        XCTAssertEqual(router.selectedTab, .profile)
        XCTAssertEqual(router.path(for: .profile), [.settings, .event(.init(event: firstEvent))])
    }

    func testLoginCanAdvanceToPhoneGateWithoutLosingTheIntent() {
        let router = AppRouter()
        router.deferRegistration(for: firstEvent, action: .register, requiring: .login)

        router.transitionDeferredIntent(to: .phoneVerification)

        XCTAssertNil(router.resumeDeferredIntent(after: .login))
        XCTAssertNotNil(router.resumeDeferredIntent(after: .phoneVerification))
    }

    func testAccountResetClearsSensitivePathsAndRegistrationIntent() {
        let router = AppRouter()
        router.selectedTab = .profile
        router.setPath([.settings], for: .profile)
        router.deferRegistration(for: firstEvent, action: .register, requiring: .login)

        router.resetSensitiveNavigation()

        XCTAssertEqual(router.selectedTab, .discovery)
        XCTAssertTrue(AppTab.allCases.allSatisfy { router.path(for: $0).isEmpty })
        XCTAssertNil(router.deferredRegistrationIntent)
        XCTAssertNil(router.pendingRegistrationPresentation)
    }
}
