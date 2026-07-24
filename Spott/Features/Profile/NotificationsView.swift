import SwiftUI

struct NotificationsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale

    var body: some View {
        NotificationsScreen(service: model.api, locale: locale)
    }
}

private struct NotificationsScreen: View {
    @Environment(AppModel.self) private var model
    @State private var store: NotificationsStore

    private let locale: Locale

    init(service: any NotificationsServing, locale: Locale) {
        _store = State(initialValue: NotificationsStore(service: service))
        self.locale = locale
    }

    var body: some View {
        Group {
            if store.isLoading, store.items.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = store.error, store.items.isEmpty {
                SpottEmptyState(
                    icon: "wifi.exclamationmark",
                    title: text("profile.notifications.error_title"),
                    message: error.message,
                    actionTitle: text("profile.home.retry")
                ) {
                    Task { await store.load() }
                }
                .padding(SpottMetric.pageInset)
            } else if store.items.isEmpty, store.didLoad {
                SpottEmptyState(
                    icon: "bell.slash",
                    title: text("profile.notifications.empty_title"),
                    message: text("profile.notifications.empty_message")
                )
                .padding(SpottMetric.pageInset)
            } else {
                notificationList
            }
        }
        .background(SpottScreenBackground())
        .navigationTitle(Text(text("profile.notifications.title")))
        .task { await store.load() }
        .refreshable { await store.load() }
    }

    private var notificationList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10, pinnedViews: []) {
                ForEach(store.sections) { section in
                    Text(ProfileTabLocalization.day(section.day, locale: locale))
                        .font(.footnote.weight(.semibold))
                        .fontDesign(.rounded)
                        .foregroundStyle(SpottColor.muted)
                        .padding(.top, 10)
                        .padding(.leading, 4)
                        .accessibilityAddTraits(.isHeader)
                    SurfaceCard {
                        VStack(spacing: 0) {
                            ForEach(section.items) { item in
                                Button {
                                    open(item)
                                } label: {
                                    NotificationRow(item: item, locale: locale)
                                }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("notification.\(item.id.uuidString.lowercased())")
                                if item.id != section.items.last?.id {
                                    Divider().padding(.leading, 50)
                                }
                            }
                        }
                    }
                }
            }
            .padding(SpottMetric.pageInset)
        }
    }

    private func open(_ item: NotificationItem) {
        store.markRead(item)
        guard let resourceType = item.resourceType,
              let publicID = item.resourcePublicId, !publicID.isEmpty else { return }
        switch resourceType {
        case "event":
            model.router.push(.event(.init(id: nil, slug: publicID)))
        case "group":
            if let id = UUID(uuidString: publicID) {
                model.router.push(.group(id))
            }
        case "registration":
            model.router.showItinerary(registrationID: UUID(uuidString: publicID))
        default:
            break
        }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        ProfileTabLocalization.text(key, locale: locale)
    }
}

private struct NotificationRow: View {
    let item: NotificationItem
    let locale: Locale

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: NotificationPresentation.icon(for: item.type))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(item.readAt == nil ? SpottColor.twilight : SpottColor.muted)
                .frame(width: 38, height: 38)
                .background(
                    (item.readAt == nil ? SpottColor.twilightPale : SpottColor.divider).opacity(0.55),
                    in: Circle()
                )
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(NotificationPresentation.title(for: item.type, locale: locale))
                    .font(.subheadline.weight(item.readAt == nil ? .semibold : .regular))
                    .foregroundStyle(SpottColor.ink)
                    .multilineTextAlignment(.leading)
                Text(ProfileTabLocalization.relative(item.createdAt, locale: locale))
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
            }
            Spacer(minLength: 0)
            if item.readAt == nil {
                Circle()
                    .fill(SpottColor.twilight)
                    .frame(width: 8, height: 8)
                    .padding(.top, 6)
                    .accessibilityLabel(
                        ProfileTabLocalization.text("profile.notifications.unread", locale: locale)
                    )
            }
        }
        .padding(.vertical, 10)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

enum NotificationPresentation {
    static func icon(for type: String) -> String {
        switch normalized(type) {
        case "waitlist.offered": "hourglass"
        case "registration.hold_expired": "hourglass.tophalf.filled"
        case "registration.changed": "person.crop.circle.badge.checkmark"
        case "event.reminder": "alarm"
        case "event.cancelled": "calendar.badge.exclamationmark"
        case "event.key_fields_changed": "calendar.badge.clock"
        case "event.reviewed": "checkmark.shield"
        case "event.removed": "xmark.circle"
        case "event.host_announcement": "megaphone.fill"
        case "group.announcement": "megaphone"
        case "group.dissolution_scheduled": "person.2.slash"
        case "achievements.awarded": "medal"
        case "moderation.decided": "shield.lefthalf.filled"
        case "account.restricted": "exclamationmark.shield"
        case "safety.case": "shield"
        default: "bell"
        }
    }

    static func title(for type: String, locale: Locale) -> String {
        let normalized = normalized(type)
        guard knownTypes.contains(normalized) else {
            return ProfileTabLocalization.text("profile.notifications.generic", locale: locale)
        }
        let key = "profile.notification.\(normalized.replacingOccurrences(of: ".", with: "_"))"
        return ProfileTabLocalization.text(String.LocalizationValue(key), locale: locale)
    }

    static let knownTypes: Set<String> = [
        "waitlist.offered", "registration.hold_expired", "registration.changed",
        "event.reminder", "event.cancelled", "event.key_fields_changed",
        "event.reviewed", "event.removed", "event.host_announcement",
        "group.announcement",
        "group.dissolution_scheduled", "achievements.awarded",
        "moderation.decided", "account.restricted", "safety.case",
    ]

    private static func normalized(_ type: String) -> String {
        type.hasPrefix("event.reminder") ? "event.reminder" : type
    }
}
