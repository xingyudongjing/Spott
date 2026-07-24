import SwiftUI

struct AchievementsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale

    var body: some View {
        AchievementsScreen(service: model.api, locale: locale)
    }
}

private struct AchievementsScreen: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var store: AchievementsStore
    @State private var shareTarget: AchievementShareCard?
    @State private var shareLoadingID: UUID?
    @State private var shareError: UserFacingError?

    private let locale: Locale

    init(service: any AchievementsServing, locale: Locale) {
        _store = State(initialValue: AchievementsStore(service: service))
        self.locale = locale
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                if !store.newlyAwardedCodes.isEmpty {
                    celebrationBanner
                }
                if let error = store.mutationError ?? shareError {
                    Label(error.message, systemImage: "exclamationmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(SpottColor.danger)
                }
                if store.isLoading, store.achievements.isEmpty {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.top, 90)
                } else if let error = store.error, store.achievements.isEmpty {
                    SpottEmptyState(
                        icon: "wifi.exclamationmark",
                        title: text("profile.achievements.error_title"),
                        message: error.message,
                        actionTitle: text("profile.home.retry")
                    ) {
                        Task { await store.load() }
                    }
                    .padding(.top, 60)
                } else if store.visibleAchievements.isEmpty, store.didLoad {
                    SpottEmptyState(
                        icon: "medal",
                        title: text("profile.achievements.empty_title"),
                        message: text("profile.achievements.empty_message")
                    )
                    .padding(.top, 60)
                } else {
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 14) {
                        ForEach(store.visibleAchievements) { achievement in
                            AchievementCard(
                                achievement: achievement,
                                locale: locale,
                                isNew: store.newlyAwardedCodes.contains(achievement.code),
                                isBusy: store.togglingID == achievement.id || shareLoadingID == achievement.id,
                                toggleHidden: {
                                    Task {
                                        await store.setHidden(achievement, hidden: !(achievement.hidden ?? false))
                                    }
                                },
                                share: { share(achievement) }
                            )
                        }
                    }
                }
            }
            .padding(SpottMetric.pageInset)
        }
        .background(SpottScreenBackground())
        .navigationTitle(Text(text("profile.achievements.title")))
        .sensoryFeedback(.success, trigger: store.celebrationTick) { _, tick in tick > 0 }
        .sheet(item: $shareTarget) { card in
            NavigationStack {
                AchievementShareSheet(card: card, locale: locale)
            }
            .presentationDetents([.medium, .large])
        }
        .task { await store.load() }
        .refreshable { await store.load() }
    }

    private var celebrationBanner: some View {
        HStack(spacing: 12) {
            Image(systemName: "medal.fill")
                .font(.title3)
                .foregroundStyle(SpottColor.amber)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(text("profile.achievements.new_title"))
                    .font(.subheadline.weight(.bold))
                    .fontDesign(.rounded)
                Text(newAwardNames)
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
            }
            Spacer()
        }
        .padding(14)
        .spottGlassPanel(
            shape: RoundedRectangle(cornerRadius: SpottMetric.controlRadius, style: .continuous),
            tint: SpottColor.amber.opacity(0.16)
        )
        .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
        .accessibilityElement(children: .combine)
    }

    private var newAwardNames: String {
        store.newlyAwardedCodes
            .sorted()
            .map { AchievementPresentation.name(for: $0, locale: locale) }
            .joined(separator: " · ")
    }

    private func share(_ achievement: Achievement) {
        guard shareLoadingID == nil else { return }
        shareLoadingID = achievement.id
        shareError = nil
        Task { @MainActor in
            defer { shareLoadingID = nil }
            do {
                shareTarget = try await store.shareCard(for: achievement)
            } catch {
                shareError = AppModel.map(error)
            }
        }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        ProfileTabLocalization.text(key, locale: locale)
    }
}

enum AchievementPresentation {
    static let knownCodes: Set<String> = [
        "first_checkin", "city_explorer_5", "first_hosted_event",
        "community_builder", "continuous_participation", "reliable_attendee",
        "friendly_contributor", "continuous_organizer",
    ]

    static func name(for code: String, locale: Locale) -> String {
        guard knownCodes.contains(code) else {
            return code.replacingOccurrences(of: "_", with: " ").capitalized
        }
        return ProfileTabLocalization.text(
            String.LocalizationValue("profile.achievement.\(code).name"),
            locale: locale
        )
    }

    static func detail(for code: String, locale: Locale) -> String? {
        guard knownCodes.contains(code) else { return nil }
        return ProfileTabLocalization.text(
            String.LocalizationValue("profile.achievement.\(code).detail"),
            locale: locale
        )
    }

    static func icon(for code: String, audience: String) -> String {
        switch code {
        case "first_checkin": return "figure.wave"
        case "city_explorer_5": return "map"
        case "first_hosted_event": return "star.circle.fill"
        case "community_builder": return "person.3.fill"
        case "continuous_participation": return "flame.fill"
        case "reliable_attendee": return "checkmark.seal.fill"
        case "friendly_contributor": return "hand.thumbsup.fill"
        case "continuous_organizer": return "calendar.badge.checkmark"
        default: return audience == "host" ? "star.circle.fill" : "medal.fill"
        }
    }
}

private struct AchievementCard: View {
    let achievement: Achievement
    let locale: Locale
    let isNew: Bool
    let isBusy: Bool
    let toggleHidden: () -> Void
    let share: () -> Void

    private var hidden: Bool { achievement.hidden ?? false }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: AchievementPresentation.icon(for: achievement.code, audience: achievement.audience))
                    .font(.title2)
                    .foregroundStyle(isNew ? SpottColor.amber : SpottColor.coral)
                    .accessibilityHidden(true)
                Spacer()
                if isBusy {
                    ProgressView().controlSize(.small)
                } else {
                    menu
                }
            }
            Text(AchievementPresentation.name(for: achievement.code, locale: locale))
                .font(.subheadline.weight(.bold))
                .fontDesign(.rounded)
                .multilineTextAlignment(.leading)
            if let detail = AchievementPresentation.detail(for: achievement.code, locale: locale) {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
                    .multilineTextAlignment(.leading)
            }
            Spacer(minLength: 0)
            HStack(spacing: 6) {
                Text(achievement.awardedAt.formatted(date: .abbreviated, time: .omitted))
                    .font(.caption2)
                    .foregroundStyle(SpottColor.muted)
                Spacer()
                if hidden {
                    Label(
                        ProfileTabLocalization.text("profile.achievements.hidden_tag", locale: locale),
                        systemImage: "eye.slash"
                    )
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(SpottColor.muted)
                    .labelStyle(.titleAndIcon)
                }
            }
        }
        .frame(maxWidth: .infinity, minHeight: 150, alignment: .topLeading)
        .padding(16)
        .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous)
                .stroke(isNew ? SpottColor.amber.opacity(0.7) : SpottColor.hairline, lineWidth: isNew ? 1.5 : 1)
        )
        .opacity(hidden ? 0.62 : 1)
        .accessibilityElement(children: .combine)
    }

    private var menu: some View {
        Menu {
            Button(action: share) {
                Label(
                    ProfileTabLocalization.text("profile.achievements.share", locale: locale),
                    systemImage: "square.and.arrow.up"
                )
            }
            Button(action: toggleHidden) {
                Label(
                    ProfileTabLocalization.text(
                        hidden ? "profile.achievements.unhide" : "profile.achievements.hide",
                        locale: locale
                    ),
                    systemImage: hidden ? "eye" : "eye.slash"
                )
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.caption.weight(.bold))
                .foregroundStyle(SpottColor.muted)
                .frame(width: 32, height: 32)
                .contentShape(Circle())
        }
        .accessibilityLabel(
            ProfileTabLocalization.text("profile.achievements.actions", locale: locale)
        )
    }
}

extension AchievementShareCard: Identifiable {
    var id: URL { link }
}

private struct AchievementShareSheet: View {
    @Environment(\.dismiss) private var dismiss
    let card: AchievementShareCard
    let locale: Locale

    var body: some View {
        VStack(spacing: 20) {
            VStack(spacing: 14) {
                Image(systemName: AchievementPresentation.icon(
                    for: card.achievement.code,
                    audience: card.achievement.audience
                ))
                .font(.largeTitle)
                .foregroundStyle(SpottColor.coral)
                .accessibilityHidden(true)
                Text(AchievementPresentation.name(for: card.achievement.code, locale: locale))
                    .font(.title3.bold())
                    .fontDesign(.rounded)
                    .multilineTextAlignment(.center)
                Text(card.nickname)
                    .font(.subheadline.weight(.semibold))
                Text(
                    ProfileTabLocalization.format(
                        "profile.achievements.awarded_on",
                        locale: locale,
                        card.achievement.awardedAt.formatted(date: .abbreviated, time: .omitted)
                    )
                )
                .font(.caption)
                .foregroundStyle(SpottColor.muted)
                Text(card.brand)
                    .font(.caption2.weight(.bold))
                    .fontDesign(.rounded)
                    .tracking(1.4)
                    .foregroundStyle(SpottColor.coral)
            }
            .frame(maxWidth: .infinity)
            .padding(26)
            .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: SpottMetric.coverRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: SpottMetric.coverRadius, style: .continuous)
                    .stroke(SpottColor.hairline)
            )

            ShareLink(item: card.link) {
                Label(
                    ProfileTabLocalization.text("profile.achievements.share", locale: locale),
                    systemImage: "square.and.arrow.up"
                )
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
            }
            .spottProminentActionStyle()
            Spacer()
        }
        .padding(SpottMetric.pageInset)
        .background(SpottScreenBackground())
        .navigationTitle(
            Text(ProfileTabLocalization.text("profile.achievements.share_title", locale: locale))
        )
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(ProfileTabLocalization.text("profile.common.close", locale: locale)) { dismiss() }
            }
        }
    }
}
