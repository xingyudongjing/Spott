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

    func testCustomSchemeGroupAndShareLinksUseTheSameStrictParser() throws {
        let router = AppRouter()

        XCTAssertEqual(
            router.route(
                url: try XCTUnwrap(URL(string: "spott://g/tokyo-weekend"))
            ),
            .requiresResolution(.group(identifier: "tokyo-weekend", targetTab: .groups))
        )
        XCTAssertEqual(
            router.route(
                url: try XCTUnwrap(URL(string: "spott://s/share_code-42"))
            ),
            .requiresResolution(.share(code: "share_code-42"))
        )
        XCTAssertTrue(router.path(for: .groups).isEmpty)
    }

    func testDeepLinksRejectExtraSegmentsAndEncodedSeparators() throws {
        let router = AppRouter()

        XCTAssertEqual(
            router.route(
                url: try XCTUnwrap(URL(string: "https://spott.jp/g/tokyo-weekend/extra"))
            ),
            .rejected
        )
        XCTAssertEqual(
            router.route(
                url: try XCTUnwrap(URL(string: "https://spott.jp/e/private%2Fsegment"))
            ),
            .rejected
        )
        for rawURL in [
            "https://spott.jp/e/%2Fprivate",
            "https://spott.jp/e/private%2f",
            "https://spott.jp/e//private"
        ] {
            XCTAssertEqual(
                router.route(url: try XCTUnwrap(URL(string: rawURL))),
                .rejected,
                "encoded or empty path segments must never be normalized into a trusted route"
            )
        }
        XCTAssertEqual(
            router.route(
                url: try XCTUnwrap(URL(string: "spott://s/%20"))
            ),
            .rejected
        )
        XCTAssertTrue(AppTab.allCases.allSatisfy { router.path(for: $0).isEmpty })
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

    func testPendingRegistrationPresentationCanOnlyBeTakenFromItsSourceTab() {
        let router = AppRouter()
        router.selectedTab = .activities
        router.setPath([.event(.init(event: firstEvent))], for: .activities)
        router.setPath([.event(.init(event: firstEvent))], for: .profile)
        router.deferRegistration(for: firstEvent, action: .register, requiring: .login)

        XCTAssertNotNil(router.resumeDeferredIntent(after: .login))

        XCTAssertNil(
            router.takeRegistrationPresentation(
                for: .init(event: firstEvent),
                in: .profile
            )
        )
        XCTAssertNotNil(router.pendingRegistrationPresentation)
        XCTAssertNotNil(
            router.takeRegistrationPresentation(
                for: .init(event: firstEvent),
                in: .activities
            )
        )
        XCTAssertNil(router.pendingRegistrationPresentation)
    }

    func testItineraryNavigationPreservesTheRegistrationToFocusUntilConsumed() {
        let router = AppRouter()
        let registrationID = UUID(
            uuidString: "019b0000-0000-7000-8100-000000000088"
        )!
        router.setPath([.event(.init(event: firstEvent))], for: .activities)
        router.setPath([.settings], for: .profile)

        router.showItinerary(registrationID: registrationID)

        XCTAssertEqual(router.selectedTab, .activities)
        XCTAssertTrue(router.path(for: .activities).isEmpty)
        XCTAssertEqual(router.path(for: .profile), [.settings])
        XCTAssertEqual(router.pendingItineraryRegistrationID, registrationID)
        XCTAssertFalse(router.completeItineraryFocus(UUID()))
        XCTAssertEqual(router.pendingItineraryRegistrationID, registrationID)
        XCTAssertTrue(router.completeItineraryFocus(registrationID))
        XCTAssertNil(router.pendingItineraryRegistrationID)
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
        XCTAssertNil(router.pendingItineraryRegistrationID)
    }

    func testPushDeepLinkExtractsServerDecidedURL() throws {
        let userInfo: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "t", "body": "b"]],
            "spott": ["type": "event.cancelled", "deepLink": "spott://e/tokyo-picnic"],
        ]
        let url = try XCTUnwrap(pushDeepLink(from: userInfo))
        XCTAssertEqual(url, URL(string: "spott://e/tokyo-picnic"))

        // A tapped notification deep link routes through the same validated router path.
        let router = AppRouter()
        XCTAssertEqual(router.route(url: url), .opened)
        XCTAssertEqual(router.selectedTab, .discovery)
        XCTAssertEqual(router.path(for: .discovery), [.event(.init(id: nil, slug: "tokyo-picnic"))])
    }

    func testPushDeepLinkIgnoresPayloadsWithoutADeepLink() {
        XCTAssertNil(pushDeepLink(from: ["spott": ["type": "moderation.decided"]]))
        XCTAssertNil(pushDeepLink(from: ["aps": ["alert": "hi"]]))
        XCTAssertNil(pushDeepLink(from: ["spott": ["deepLink": ""]]))
    }

    func testPushDeepLinkBufferReturnsAndClears() {
        _ = PushDeepLinkBuffer.take()
        let url = URL(string: "spott://g/hikers")!
        PushDeepLinkBuffer.store(url)
        XCTAssertEqual(PushDeepLinkBuffer.take(), url)
        XCTAssertNil(PushDeepLinkBuffer.take())
    }
}
