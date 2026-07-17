import Foundation
import SwiftUI

struct EventDetailActionPresentation: Equatable, Sendable {
    let kind: EventCTAState.Kind
    let title: String
    let supportingText: String
    let systemImage: String
    let isDisabled: Bool

    init(state: EventCTAState, locale: Locale) {
        kind = state.kind
        isDisabled = state.disabled
        let titleKey: String.LocalizationValue
        let supportingKey: String.LocalizationValue
        switch state.kind {
        case .eventUnavailable:
            titleKey = "journey.cta.event_unavailable.title"
            supportingKey = "journey.cta.event_unavailable.support"
        case .acceptWaitlist:
            titleKey = "journey.cta.accept_waitlist.title"
            supportingKey = "journey.cta.accept_waitlist.support"
        case .viewItinerary:
            titleKey = "journey.cta.view_itinerary.title"
            supportingKey = "journey.cta.view_itinerary.support"
        case .viewPending:
            titleKey = "journey.cta.view_pending.title"
            supportingKey = "journey.cta.view_pending.support"
        case .viewWaitlist:
            titleKey = "journey.cta.view_waitlist.title"
            supportingKey = "journey.cta.view_waitlist.support"
        case .continueLogin:
            titleKey = "journey.cta.continue_login.title"
            supportingKey = "journey.cta.continue_login.support"
        case .continuePhoneVerification:
            titleKey = "journey.cta.continue_phone.title"
            supportingKey = "journey.cta.continue_phone.support"
        case .registrationClosed:
            titleKey = "journey.cta.registration_closed.title"
            supportingKey = "journey.cta.registration_closed.support"
        case .joinWaitlist:
            titleKey = "journey.cta.join_waitlist.title"
            supportingKey = "journey.cta.join_waitlist.support"
        case .fullClosed:
            titleKey = "journey.cta.full_closed.title"
            supportingKey = "journey.cta.full_closed.support"
        case .apply:
            titleKey = "journey.cta.apply.title"
            supportingKey = "journey.cta.apply.support"
        case .register:
            titleKey = "journey.cta.register.title"
            supportingKey = "journey.cta.register.support"
        }
        title = CoreJourneyLocalization.text(titleKey, locale: locale)
        supportingText = CoreJourneyLocalization.text(supportingKey, locale: locale)
        systemImage = Self.systemImage(for: state.kind)
    }

    private static func systemImage(for kind: EventCTAState.Kind) -> String {
        switch kind {
        case .eventUnavailable, .registrationClosed, .fullClosed:
            "calendar.badge.exclamationmark"
        case .acceptWaitlist:
            "checkmark.seal.fill"
        case .viewItinerary, .viewPending, .viewWaitlist:
            "calendar.badge.clock"
        case .continueLogin:
            "person.crop.circle.badge.checkmark"
        case .continuePhoneVerification:
            "phone.badge.checkmark"
        case .joinWaitlist:
            "person.crop.circle.badge.plus"
        case .apply:
            "doc.text.fill"
        case .register:
            "ticket.fill"
        }
    }
}

struct EventActionBar: View {
    let presentation: EventDetailActionPresentation
    let isBusy: Bool
    let action: () -> Void

    var body: some View {
        actionSurface
            .background(
                Color(uiColor: .secondarySystemGroupedBackground).opacity(0.96),
                in: RoundedRectangle(cornerRadius: 24, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .stroke(Color.primary.opacity(0.08), lineWidth: 0.5)
            }
        .padding(.horizontal, 12)
        .padding(.bottom, 5)
    }

    private var actionSurface: some View {
        ViewThatFits(in: .horizontal) {
            horizontalActionSurface
            verticalActionSurface
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
    }

    private var horizontalActionSurface: some View {
        HStack(spacing: 14) {
            supportingText
            .frame(maxWidth: .infinity, alignment: .leading)

            EventPrimaryActionButton(
                presentation: presentation,
                isBusy: isBusy,
                fillsWidth: false,
                action: action
            )
        }
    }

    private var verticalActionSurface: some View {
        VStack(alignment: .leading, spacing: 10) {
            supportingText
            EventPrimaryActionButton(
                presentation: presentation,
                isBusy: isBusy,
                fillsWidth: true,
                action: action
            )
        }
    }

    private var supportingText: some View {
        Text(presentation.supportingText)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct EventPrimaryActionButton: View {
    let presentation: EventDetailActionPresentation
    let isBusy: Bool
    let fillsWidth: Bool
    let action: () -> Void

    var body: some View {
        Group {
            if #available(iOS 26.0, *) {
                button.buttonStyle(.glassProminent)
            } else {
                button
                    .buttonStyle(.borderedProminent)
                    .tint(SpottColor.twilight)
            }
        }
        .disabled(presentation.isDisabled || isBusy)
        .accessibilityIdentifier("event.action.\(presentation.kind.rawValue)")
    }

    private var button: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                if isBusy {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: presentation.systemImage)
                }
                Text(presentation.title)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
            }
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: fillsWidth ? .infinity : nil, minHeight: 44)
        }
        .buttonBorderShape(.capsule)
    }
}
