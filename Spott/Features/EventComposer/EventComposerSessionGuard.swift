import Foundation

struct EventComposerSessionIdentity: Hashable, Sendable {
    let sessionID: UUID
    let userID: UUID
}

struct EventComposerRequestContext: Hashable, Sendable {
    let identity: EventComposerSessionIdentity
    let generation: UInt64
}

enum EventComposerSessionPresentation {
    static func canRenderSensitiveDraft(
        boundIdentity: EventComposerSessionIdentity?,
        currentIdentity: EventComposerSessionIdentity?
    ) -> Bool {
        guard let boundIdentity, let currentIdentity else { return false }
        return boundIdentity == currentIdentity
    }

    static func canAcceptResponse(
        _ context: EventComposerRequestContext,
        boundIdentity: EventComposerSessionIdentity?,
        currentIdentity: EventComposerSessionIdentity?,
        currentGeneration: UInt64
    ) -> Bool {
        context.identity == boundIdentity
            && context.identity == currentIdentity
            && context.generation == currentGeneration
    }
}

enum EventComposerDraftResponsePolicy {
    static func accepts(
        _ event: EventSummary,
        expectedID: UUID?,
        expectedOrganizerID: UUID
    ) -> Bool {
        event.organizerId == expectedOrganizerID
            && (expectedID == nil || event.id == expectedID)
    }
}

enum EventComposerOptionalResponsePolicy {
    static func canContinue<Response>(
        after response: Response?,
        context: EventComposerRequestContext,
        boundIdentity: EventComposerSessionIdentity?,
        currentIdentity: EventComposerSessionIdentity?,
        currentGeneration: UInt64
    ) -> Bool {
        _ = response
        return EventComposerSessionPresentation.canAcceptResponse(
            context,
            boundIdentity: boundIdentity,
            currentIdentity: currentIdentity,
            currentGeneration: currentGeneration
        )
    }
}

enum EventComposerContactUITestFixture {
    static var isEnabled: Bool {
#if DEBUG
        ProcessInfo.processInfo.arguments.contains(
            "-spott-ui-test-composer-contact"
        )
#else
        false
#endif
    }

    static let identity = EventComposerSessionIdentity(
        sessionID: UUID(
            uuidString: "019b0000-0000-7000-8100-000000000051"
        )!,
        userID: UUID(
            uuidString: "019b0000-0000-7000-8100-000000000052"
        )!
    )
}
