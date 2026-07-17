import Foundation
import SwiftUI
import UIKit

struct RegistrationConfirmationPresentation: Equatable, Sendable {
    let title: String
    let message: String
    let nextStep: String
    let actionTitle: String
    let systemImage: String

    init(kind: RegistrationConfirmationKind, locale: Locale) {
        let titleKey: String.LocalizationValue
        let messageKey: String.LocalizationValue
        let nextStepKey: String.LocalizationValue
        switch kind {
        case .confirmed:
            titleKey = "journey.confirmation.confirmed.title"
            messageKey = "journey.confirmation.confirmed.message"
            nextStepKey = "journey.confirmation.confirmed.next"
            systemImage = "checkmark.seal.fill"
        case .pending:
            titleKey = "journey.confirmation.pending.title"
            messageKey = "journey.confirmation.pending.message"
            nextStepKey = "journey.confirmation.pending.next"
            systemImage = "clock.badge.checkmark.fill"
        case .waitlisted:
            titleKey = "journey.confirmation.waitlisted.title"
            messageKey = "journey.confirmation.waitlisted.message"
            nextStepKey = "journey.confirmation.waitlisted.next"
            systemImage = "person.crop.circle.badge.clock.fill"
        }
        title = CoreJourneyLocalization.text(titleKey, locale: locale)
        message = CoreJourneyLocalization.text(messageKey, locale: locale)
        nextStep = CoreJourneyLocalization.text(nextStepKey, locale: locale)
        actionTitle = CoreJourneyLocalization.text(
            "journey.confirmation.view_itinerary",
            locale: locale
        )
    }
}

struct RegistrationConfirmationView: View {
    private struct CalendarFeedback: Equatable {
        let message: String
        let isError: Bool
    }

    let confirmation: RegistrationConfirmation
    let locale: Locale
    let refreshMessage: String?
    let onViewItinerary: () -> Void
    let onDone: () -> Void

    @State private var isAddingToCalendar = false
    @State private var calendarFeedback: CalendarFeedback?

    init(
        confirmation: RegistrationConfirmation,
        locale: Locale,
        refreshMessage: String? = nil,
        onViewItinerary: @escaping () -> Void,
        onDone: @escaping () -> Void
    ) {
        self.confirmation = confirmation
        self.locale = locale
        self.refreshMessage = refreshMessage
        self.onViewItinerary = onViewItinerary
        self.onDone = onDone
    }

    private var presentation: RegistrationConfirmationPresentation {
        .init(kind: confirmation.kind, locale: locale)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                confirmationHeader

                if let refreshMessage {
                    Label(refreshMessage, systemImage: "arrow.clockwise.circle")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("registration.confirmation.refresh_notice")
                }

                EventFactsView(
                    presentation: EventFactsPresentation(
                        event: confirmation.event,
                        disclosure: locationDisclosure,
                        locale: locale
                    )
                )

                VStack(spacing: 0) {
                    LabeledContent(text("journey.registration.status_label")) {
                        Label(presentation.title, systemImage: presentation.systemImage)
                            .foregroundStyle(statusTint)
                    }
                    .padding(.vertical, 12)

                    Divider()

                    LabeledContent(text("journey.registration.party_size")) {
                        Text(confirmation.registration.partySize, format: .number)
                            .font(.body.monospacedDigit().weight(.semibold))
                    }
                    .padding(.vertical, 12)
                }
                .padding(.horizontal, 16)
                .background(
                    Color(uiColor: .secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 18, style: .continuous)
                )

                Label {
                    Text(presentation.nextStep)
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "arrow.forward.circle.fill")
                        .foregroundStyle(statusTint)
                }
                .font(.subheadline)
                .padding(.horizontal, 4)

                secondaryActions

                if let calendarFeedback {
                    Label(
                        calendarFeedback.message,
                        systemImage: calendarFeedback.isError
                            ? "exclamationmark.triangle.fill"
                            : "checkmark.circle.fill"
                    )
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(calendarFeedback.isError ? SpottColor.danger : SpottColor.mint)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier(
                        calendarFeedback.isError
                            ? "registration.confirmation.calendar_error"
                            : "registration.confirmation.calendar_success"
                    )
                }
            }
            .padding(20)
            .padding(.bottom, 108)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 8) {
                JourneyPrimaryActionButton(
                    title: presentation.actionTitle,
                    systemImage: "list.bullet.rectangle.portrait",
                    isBusy: false,
                    action: onViewItinerary
                )
                .accessibilityIdentifier("registration.confirmation.view_itinerary")
                Button(text("journey.common.done"), action: onDone)
                    .font(.subheadline.weight(.semibold))
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("registration.confirmation.done")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.bar)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("registration.confirmation")
    }

    private var confirmationHeader: some View {
        VStack(alignment: .leading, spacing: 14) {
            Image(systemName: presentation.systemImage)
                .font(.system(size: 42, weight: .semibold))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(statusTint)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 7) {
                Text(presentation.title)
                    .font(.largeTitle.bold())
                    .accessibilityAddTraits(.isHeader)
                Text(presentation.message)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(confirmation.event.title)
                    .font(.title3.weight(.semibold))
                    .padding(.top, 3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var secondaryActions: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                calendarButton
                shareButton
            }
            VStack(spacing: 8) {
                calendarButton
                shareButton
            }
        }
        .labelStyle(.titleAndIcon)
    }

    private var calendarButton: some View {
        Button(action: addToCalendar) {
            HStack(spacing: 8) {
                if isAddingToCalendar {
                    ProgressView()
                } else {
                    Image(systemName: "calendar.badge.plus")
                }
                Text(text("journey.common.add_calendar"))
            }
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.capsule)
        .disabled(confirmation.event.startsAt == nil || isAddingToCalendar)
        .accessibilityIdentifier("registration.confirmation.add_calendar")
    }

    private var shareButton: some View {
        ShareLink(item: shareURL, subject: Text(confirmation.event.title)) {
            Label(text("journey.common.share"), systemImage: "square.and.arrow.up")
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.capsule)
    }

    private var statusTint: Color {
        switch confirmation.kind {
        case .confirmed: SpottColor.mint
        case .pending: SpottColor.amber
        case .waitlisted: SpottColor.twilight
        }
    }

    private var locationDisclosure: EventLocationDisclosure {
        let publicArea = confirmation.event.publicArea?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let exactAddress = confirmation.event.exactAddress?
            .trimmingCharacters(in: .whitespacesAndNewlines)

        if let publicArea, !publicArea.isEmpty,
           let exactAddress, !exactAddress.isEmpty {
            return .exact(
                publicArea: publicArea,
                address: exactAddress,
                coordinate: confirmation.event.coordinate
            )
        }
        if let publicArea, !publicArea.isEmpty {
            return .approximate(publicArea)
        }
        return .unavailable
    }

    private var shareURL: URL {
        URL(string: "https://spott.jp/e/\(confirmation.event.publicSlug)")
            ?? URL(string: "https://spott.jp")!
    }

    private func addToCalendar() {
        guard !isAddingToCalendar,
              let start = confirmation.event.startsAt else { return }
        let event = confirmation.event
        isAddingToCalendar = true
        calendarFeedback = nil
        Task { @MainActor in
            defer { isAddingToCalendar = false }
            let end = event.endsAt ?? start.addingTimeInterval(7_200)
            do {
                try await CalendarIntegration().add(
                    title: event.title,
                    start: start,
                    end: end,
                    notes: "Spott · \(event.publicArea ?? "")\nhttps://spott.jp/e/\(event.publicSlug)"
                )
                let message = text("journey.detail.calendar_added")
                calendarFeedback = .init(message: message, isError: false)
                UIAccessibility.post(notification: .announcement, argument: message)
            } catch {
                let message = (error as? CalendarIntegrationError)?.localizedMessage(locale: locale)
                    ?? text("journey.calendar.write_failed")
                calendarFeedback = .init(message: message, isError: true)
                UIAccessibility.post(notification: .announcement, argument: message)
            }
        }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }
}
