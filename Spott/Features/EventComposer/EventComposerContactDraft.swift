import Foundation

enum EventComposerContactError: Error, Equatable, Sendable {
    case missing
    case invalid
    case authorizedContactUnavailable
}

enum EventComposerContactRecoveryState: Equatable, Sendable {
    case blank
    case ready
    case failed
}

struct EventComposerContactDraft: Equatable, Sendable {
    private(set) var kind: OrganizerContact.Kind = .email
    private(set) var label = ""
    private(set) var value = ""
    private(set) var recoveryState: EventComposerContactRecoveryState = .blank
    private(set) var isDirty = false

    mutating func updateKind(_ kind: OrganizerContact.Kind) {
        self.kind = kind
        isDirty = true
    }

    mutating func updateLabel(_ label: String) {
        self.label = label
        isDirty = true
    }

    mutating func updateValue(_ value: String) {
        self.value = value
        isDirty = true
    }

    func contactForDraftSave() -> OrganizerContact? {
        guard recoveryState != .failed else { return nil }
        return try? normalizedContact()
    }

    func contactForSubmission() throws -> OrganizerContact {
        guard recoveryState != .failed else {
            throw EventComposerContactError.authorizedContactUnavailable
        }
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw EventComposerContactError.missing
        }
        do {
            return try normalizedContact()
        } catch {
            throw EventComposerContactError.invalid
        }
    }

    @discardableResult
    mutating func reconcileAuthorizedResponse(
        _ event: EventSummary,
        expectedContact: Bool
    ) -> Bool {
        guard let contact = event.organizerContact else {
            if expectedContact
                || event.status != "draft"
                || recoveryState == .ready
                || recoveryState == .failed
            {
                recoveryState = .failed
                return false
            }
            return true
        }

        if expectedContact {
            guard let expected = try? normalizedContact(), expected == contact else {
                recoveryState = .failed
                return false
            }
        }

        if !isDirty {
            kind = contact.kind
            label = contact.label ?? ""
            value = contact.value
        }
        recoveryState = .ready
        return true
    }

    private func normalizedContact() throws -> OrganizerContact {
        let trimmedValue = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedValue = kind == .email
            ? trimmedValue.lowercased()
            : trimmedValue
        let trimmedLabel = label.trimmingCharacters(in: .whitespacesAndNewlines)
        return try OrganizerContact(
            kind: kind,
            label: trimmedLabel.isEmpty ? nil : trimmedLabel,
            value: normalizedValue
        )
    }
}

struct EventComposerContactCopy: Equatable, Sendable {
    let title: String
    let subtitle: String
    let kindTitle: String
    let labelTitle: String
    let labelPlaceholder: String
    let valueTitle: String
    let privacyMessage: String
    let missingMessage: String
    let invalidMessage: String
    let recoveryFailedMessage: String
    let retryTitle: String
    let syncingTitle: String

    private let emailTitle: String
    private let lineTitle: String
    private let websiteTitle: String
    private let emailPlaceholder: String
    private let linePlaceholder: String
    private let websitePlaceholder: String

    init(locale: Locale) {
        func text(_ key: String.LocalizationValue) -> String {
            CoreJourneyLocalization.text(key, locale: locale)
        }

        title = text("journey.composer.contact.title")
        subtitle = text("journey.composer.contact.subtitle")
        kindTitle = text("journey.composer.contact.kind")
        labelTitle = text("journey.composer.contact.label")
        labelPlaceholder = text("journey.composer.contact.label_placeholder")
        valueTitle = text("journey.composer.contact.value")
        privacyMessage = text("journey.composer.contact.privacy")
        missingMessage = text("journey.composer.contact.missing")
        invalidMessage = text("journey.composer.contact.invalid")
        recoveryFailedMessage = text("journey.composer.contact.restore_failed")
        retryTitle = text("journey.composer.contact.retry")
        syncingTitle = text("journey.composer.contact.syncing")
        emailTitle = text("journey.contact.kind.email")
        lineTitle = text("journey.contact.kind.line")
        websiteTitle = text("journey.contact.kind.website")
        emailPlaceholder = text("journey.composer.contact.email_placeholder")
        linePlaceholder = text("journey.composer.contact.line_placeholder")
        websitePlaceholder = text("journey.composer.contact.website_placeholder")
    }

    func title(for kind: OrganizerContact.Kind) -> String {
        switch kind {
        case .email: emailTitle
        case .line: lineTitle
        case .website: websiteTitle
        }
    }

    func placeholder(for kind: OrganizerContact.Kind) -> String {
        switch kind {
        case .email: emailPlaceholder
        case .line: linePlaceholder
        case .website: websitePlaceholder
        }
    }
}
