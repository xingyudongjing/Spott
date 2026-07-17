import Foundation

struct MyActivitiesPagePresentation: Equatable, Sendable {
    let title: String
    let subtitle: String
    let signInTitle: String
    let signInMessage: String
    let signInAction: String
    let emptyTitle: String
    let emptyMessage: String
    let discoverAction: String
    let syncError: String

    init(locale: Locale) {
        title = Self.text("journey.itinerary.title", locale)
        subtitle = Self.text("journey.itinerary.subtitle", locale)
        signInTitle = Self.text("journey.itinerary.sign_in_title", locale)
        signInMessage = Self.text("journey.itinerary.sign_in_message", locale)
        signInAction = Self.text("journey.itinerary.sign_in_action", locale)
        emptyTitle = Self.text("journey.itinerary.empty_title", locale)
        emptyMessage = Self.text("journey.itinerary.empty_message", locale)
        discoverAction = Self.text("journey.itinerary.discover", locale)
        syncError = Self.text("journey.itinerary.sync_error", locale)
    }

    private static func text(
        _ key: String.LocalizationValue,
        _ locale: Locale
    ) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }
}

struct MyActivitySectionPresentation: Equatable, Sendable {
    let title: String
    let emptyTitle: String
    let emptyMessage: String

    init(group: MyActivityGroup, locale: Locale) {
        let titleKey: String.LocalizationValue
        let emptyTitleKey: String.LocalizationValue
        let emptyMessageKey: String.LocalizationValue
        switch group {
        case .pending:
            titleKey = "journey.itinerary.section.pending.title"
            emptyTitleKey = "journey.itinerary.section.pending.empty_title"
            emptyMessageKey = "journey.itinerary.section.pending.empty_message"
        case .waitlist:
            titleKey = "journey.itinerary.section.waitlist.title"
            emptyTitleKey = "journey.itinerary.section.waitlist.empty_title"
            emptyMessageKey = "journey.itinerary.section.waitlist.empty_message"
        case .upcoming:
            titleKey = "journey.itinerary.section.upcoming.title"
            emptyTitleKey = "journey.itinerary.section.upcoming.empty_title"
            emptyMessageKey = "journey.itinerary.section.upcoming.empty_message"
        case .past:
            titleKey = "journey.itinerary.section.past.title"
            emptyTitleKey = "journey.itinerary.section.past.empty_title"
            emptyMessageKey = "journey.itinerary.section.past.empty_message"
        }
        title = CoreJourneyLocalization.text(titleKey, locale: locale)
        emptyTitle = CoreJourneyLocalization.text(emptyTitleKey, locale: locale)
        emptyMessage = CoreJourneyLocalization.text(emptyMessageKey, locale: locale)
    }
}

struct MyActivityRowPresentation: Equatable, Sendable {
    let title: String
    let date: String
    let location: String
    let status: String
    let actionTitle: String?
    let actionSystemImage: String?

    init(item: MyActivityItem, locale: Locale) {
        if let event = item.event {
            title = event.title
            date = CoreJourneyLocalization.dateTime(
                event.startsAt,
                timeZoneIdentifier: event.displayTimeZone,
                locale: locale
            )
            if event.format == .online {
                location = Self.text("journey.fact.online_event", locale)
            } else if let publicArea = event.publicArea?.trimmingCharacters(in: .whitespacesAndNewlines),
                      !publicArea.isEmpty {
                location = publicArea
            } else {
                location = Self.text("journey.fact.location_unavailable", locale)
            }
        } else {
            title = Self.text("journey.itinerary.event_unavailable.title", locale)
            date = Self.text("journey.fact.time_tbd", locale)
            location = Self.text("journey.itinerary.event_unavailable.message", locale)
        }

        status = Self.statusText(item.registration.status, locale: locale)
        switch item.nextAction {
        case .acceptWaitlist:
            actionTitle = Self.text("journey.itinerary.action.accept", locale)
            actionSystemImage = "checkmark.seal.fill"
        case .cancelRegistration:
            actionTitle = Self.text("journey.itinerary.action.cancel", locale)
            actionSystemImage = "xmark.circle"
        case .checkIn:
            actionTitle = Self.text("journey.itinerary.action.check_in", locale)
            actionSystemImage = "qrcode.viewfinder"
        case .correctAttendance:
            actionTitle = Self.text("journey.itinerary.action.correct_attendance", locale)
            actionSystemImage = "checkmark.arrow.trianglehead.counterclockwise"
        case .leaveFeedback:
            actionTitle = Self.text("journey.itinerary.action.feedback", locale)
            actionSystemImage = "heart.text.clipboard"
        case .viewStatus:
            actionTitle = Self.text("journey.itinerary.action.status", locale)
            actionSystemImage = "clock.badge.questionmark"
        case .viewEvent:
            actionTitle = Self.text("journey.itinerary.action.view", locale)
            actionSystemImage = "arrow.right.circle"
        case .none:
            actionTitle = nil
            actionSystemImage = nil
        }
    }

    private static func statusText(_ status: String, locale: Locale) -> String {
        let key: String.LocalizationValue = switch status {
        case "confirmed": "journey.registration.status.confirmed"
        case "pending": "journey.registration.status.pending"
        case "waitlisted": "journey.registration.status.waitlisted"
        case "offered": "journey.registration.status.offered"
        case "checked_in": "journey.registration.status.checked_in"
        case "cancelled": "journey.registration.status.cancelled"
        case "rejected": "journey.registration.status.rejected"
        case "event_cancelled": "journey.registration.status.event_cancelled"
        case "no_show": "journey.registration.status.no_show"
        case "correction_pending": "journey.registration.status.correction_pending"
        case "attendance_disputed": "journey.registration.status.attendance_disputed"
        case "expired": "journey.registration.status.expired"
        case "final": "journey.registration.status.final"
        default: "journey.registration.status.unknown"
        }
        return text(key, locale)
    }

    private static func text(
        _ key: String.LocalizationValue,
        _ locale: Locale
    ) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }
}
