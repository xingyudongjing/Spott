import SwiftUI

struct ProfileHomeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale

    var body: some View {
        Group {
            if model.session == nil {
                // Container B (spec §7B): the signed-out Profile tab IS the
                // fullscreen auth surface — SPOTT wordmark, benefit rows and the
                // inline fullscreen AuthFormView (official Apple button first),
                // not a hero that bounces into the medium gate sheet.
                AuthWelcomeView()
                    .toolbar(.hidden, for: .navigationBar)
                    .accessibilityIdentifier("profile.signed-out-auth")
            } else {
                ProfileHomeScreen(service: model.api, locale: locale)
            }
        }
        .id(model.session?.sessionId)
    }
}

private struct ProfileHomeScreen: View {
    @Environment(AppModel.self) private var model
    @State private var store: ProfileStore
    @State private var signOutConfirmation = false
    @State private var editingProfile = false

    private let locale: Locale

    init(service: any ProfileHomeServing, locale: Locale) {
        _store = State(initialValue: ProfileStore(service: service))
        self.locale = locale
    }

    var body: some View {
        List {
            Section {
                identityHeader
                    .heroRow()
                statsRow
                    .heroRow()
            }
            if let error = store.error {
                Section {
                    SpottEmptyState(
                        icon: "wifi.exclamationmark",
                        title: text("profile.home.error_title"),
                        message: error.message,
                        actionTitle: text("profile.home.retry")
                    ) {
                        Task { await store.load(isSignedIn: model.session != nil) }
                    }
                    .heroRow()
                }
            }
            destinationSection
            trustSection
            Section {
                signOutButton
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(SpottScreenBackground())
        .toolbar(.hidden, for: .navigationBar)
        .task(id: model.session?.sessionId) {
            await store.load(isSignedIn: model.session != nil)
        }
        .refreshable {
            await store.load(isSignedIn: model.session != nil)
        }
        .confirmationDialog(
            text("profile.signout.confirm_title"),
            isPresented: $signOutConfirmation,
            titleVisibility: .visible
        ) {
            Button(text("profile.signout.confirm_action"), role: .destructive) {
                model.signOut()
            }
            Button(text("profile.signout.confirm_cancel"), role: .cancel) {}
        }
        .sheet(isPresented: $editingProfile) {
            NavigationStack {
                EditProfileView()
            }
        }
    }

    private var identityHeader: some View {
        HStack(alignment: .top, spacing: 15) {
            avatar
            VStack(alignment: .leading, spacing: 7) {
                Text(displayName)
                    .font(.title2.bold())
                    .fontDesign(.rounded)
                    .lineLimit(1)
                if let handle = model.session?.user.publicHandle, !handle.isEmpty {
                    Text(verbatim: "@\(handle)")
                        .font(.footnote)
                        .foregroundStyle(SpottColor.muted)
                        .lineLimit(1)
                }
                phoneBadge
                    .padding(.top, 2)
            }
            Spacer(minLength: 8)
            Button {
                editingProfile = true
            } label: {
                Image(systemName: "pencil")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(SpottColor.ink)
                    .frame(width: 44, height: 44)
                    .spottGlassPanel(shape: Circle(), interactive: true)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(text("profile.home.edit_profile"))
            .accessibilityIdentifier("profile.edit")
        }
        .padding(18)
        .background(
            SpottColor.surface,
            in: RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous)
                .strokeBorder(SpottColor.hairline)
        )
        .shadow(color: SpottColor.shadowInk.opacity(0.05), radius: 20, y: 8)
    }

    private var avatar: some View {
        ZStack {
            Circle()
                .fill(
                    LinearGradient(
                        colors: [SpottColor.twilightDeep, SpottColor.twilight],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
            if let url = store.profile?.avatarURL {
                AsyncImage(url: url) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    initialLetter
                }
                .clipShape(Circle())
            } else {
                initialLetter
            }
        }
        .frame(width: 66, height: 66)
        .overlay(
            Circle().strokeBorder(SpottColor.surface, lineWidth: 2)
        )
        .shadow(color: SpottColor.shadowInk.opacity(0.12), radius: 6, y: 3)
        .accessibilityHidden(true)
    }

    private var initialLetter: some View {
        Text(String(displayName.prefix(1)).uppercased())
            .font(.title.bold())
            .fontDesign(.rounded)
            .foregroundStyle(.white)
    }

    private var displayName: String {
        if let nickname = store.profile?.nickname, !nickname.isEmpty { return nickname }
        return model.session?.user.publicHandle ?? "Spott"
    }

    @ViewBuilder
    private var phoneBadge: some View {
        if model.session?.user.phoneVerified == true {
            GlassPill(
                text: text("profile.home.phone_verified"),
                systemImage: "checkmark.seal.fill",
                tint: SpottColor.mint
            )
        } else {
            GlassChip(
                title: text("profile.home.phone_unverified"),
                systemImage: "exclamationmark.shield",
                tint: SpottColor.amber
            ) {
                model.presentedGate = .phoneVerification
            }
        }
    }

    @ViewBuilder
    private var statsRow: some View {
        if store.error == nil {
            HStack(spacing: 10) {
                StatTile(
                    value: store.wallet.map { "\($0.totalBalance)" } ?? "—",
                    label: text("profile.stats.points"),
                    symbol: "sparkles",
                    tint: SpottColor.amber
                )
                StatTile(
                    value: store.achievementCount.map { "\($0)" } ?? "—",
                    label: text("profile.stats.achievements"),
                    symbol: "medal",
                    tint: SpottColor.coral
                )
            }
            .spottSkeleton(store.isLoading)
        }
    }

    private var destinationSection: some View {
        Section {
            NavigationLink(value: AppRoute.itinerary) {
                ProfileRow(
                    icon: "calendar",
                    title: text("profile.itinerary.title"),
                    subtitle: text("profile.itinerary.subtitle")
                )
            }
            .accessibilityIdentifier("profile.itinerary")
            NavigationLink {
                FavoritesView()
            } label: {
                ProfileRow(
                    icon: "heart",
                    title: text("profile.row.favorites"),
                    subtitle: text("profile.row.favorites_subtitle")
                )
            }
            .accessibilityIdentifier("profile.favorites")
            NavigationLink(value: AppRoute.wallet) {
                ProfileRow(
                    icon: "circle.hexagongrid",
                    title: text("profile.row.wallet"),
                    subtitle: text("profile.row.wallet_subtitle")
                )
            }
            .accessibilityIdentifier("profile.wallet")
            NavigationLink(value: AppRoute.notifications) {
                ProfileRow(
                    icon: "bell",
                    title: text("profile.row.notifications"),
                    subtitle: text("profile.row.notifications_subtitle")
                )
            }
            .accessibilityIdentifier("profile.notifications")
            NavigationLink {
                AchievementsView()
            } label: {
                ProfileRow(
                    icon: "medal",
                    title: text("profile.row.achievements"),
                    subtitle: text("profile.row.achievements_subtitle")
                )
            }
            .accessibilityIdentifier("profile.achievements")
            NavigationLink(value: AppRoute.hostStudio) {
                ProfileRow(
                    icon: "rectangle.3.group",
                    title: text("profile.row.host_studio"),
                    subtitle: text("profile.row.host_studio_subtitle")
                )
            }
            .accessibilityIdentifier("profile.host-studio")
        } header: {
            Text(text("profile.section.mine"))
        }
    }

    private var trustSection: some View {
        Section {
            NavigationLink {
                SafetyCenterView()
            } label: {
                ProfileRow(
                    icon: "shield",
                    title: text("profile.row.safety"),
                    subtitle: text("profile.row.safety_subtitle")
                )
            }
            .accessibilityIdentifier("profile.safety")
            NavigationLink(value: AppRoute.settings) {
                ProfileRow(
                    icon: "gearshape",
                    title: text("profile.row.settings"),
                    subtitle: text("profile.row.settings_subtitle")
                )
            }
            .accessibilityIdentifier("profile.settings")
        } header: {
            Text(text("profile.section.trust"))
        }
    }

    private var signOutButton: some View {
        Button(role: .destructive) {
            signOutConfirmation = true
        } label: {
            Text(text("profile.signout.action"))
                .font(.body)
                .frame(maxWidth: .infinity)
        }
        .foregroundStyle(SpottColor.danger)
        .accessibilityIdentifier("profile.sign-out")
    }

    private func text(_ key: String.LocalizationValue) -> String {
        ProfileTabLocalization.text(key, locale: locale)
    }
}

private struct ProfileRow: View {
    let icon: String
    let title: String
    let subtitle: String

    var body: some View {
        HStack(spacing: 13) {
            Image(systemName: icon)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(SpottColor.ink)
                .frame(width: 34, height: 34)
                .background(SpottColor.muted.opacity(0.12), in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
            }
        }
        .foregroundStyle(SpottColor.ink)
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

private extension View {
    /// A custom hero row that sits in the top grouped section without the
    /// system cell chrome — clear background, no separators, edge-to-edge so
    /// the card supplies its own surface. Keeps the profile hero on a system
    /// grouped background while the menu rows below use native cells.
    func heroRow() -> some View {
        listRowInsets(EdgeInsets(top: 6, leading: SpottMetric.pageInset, bottom: 6, trailing: SpottMetric.pageInset))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
    }
}
