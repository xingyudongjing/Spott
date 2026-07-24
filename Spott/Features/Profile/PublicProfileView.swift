import SwiftUI

struct PublicProfileView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    let identifier: String
    @State private var profile: PublicUserProfile?
    @State private var loading = true
    @State private var following = false
    @State private var busy = false
    @State private var error: UserFacingError?
    @State private var reportTarget: SafetyReportTarget?
    @State private var blockConfirmation = false
    @State private var hostedEvents: [PublicHostedEvent] = []
    @State private var eventsCursor: String?
    @State private var eventsHaveMore = false
    @State private var loadingMoreEvents = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if loading {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 120)
                } else if let profile {
                    profileHeader(profile)
                    SurfaceCard {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(text("profile.public.about"))
                                .font(.headline)
                                .fontDesign(.rounded)
                            Text(profile.bio.isEmpty ? text("profile.public.no_bio") : profile.bio)
                                .font(.body)
                                .foregroundStyle(profile.bio.isEmpty ? SpottColor.muted : SpottColor.ink)
                                .lineSpacing(5)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        Label(regionTitle(profile.regionId), systemImage: "mappin.and.ellipse")
                        Label(languageTitle(profile.contentLanguages), systemImage: "character.bubble")
                        Label(text("profile.public.privacy_note"), systemImage: "lock.shield")
                    }
                    .font(.subheadline)
                    .foregroundStyle(SpottColor.muted)

                    hostedEventsSection

                    if let error {
                        Label("\(error.message)（\(error.id)）", systemImage: "exclamationmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(SpottColor.danger)
                    }
                } else {
                    SpottEmptyState(
                        icon: "person.crop.circle.badge.questionmark",
                        title: text("profile.public.error_title"),
                        message: error?.message ?? text("profile.public.error_message"),
                        actionTitle: text("profile.home.retry")
                    ) { Task { await load() } }
                    .padding(.top, 60)
                }
            }
            .padding(SpottMetric.pageInset)
        }
        .background(SpottScreenBackground())
        .navigationTitle(profile?.nickname ?? text("profile.public.title"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let profile, model.session?.user.id != profile.userId {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            reportTarget = .init(type: .user, targetID: profile.userId, displayName: profile.nickname)
                        } label: {
                            Label(text("profile.public.report"), systemImage: "exclamationmark.bubble")
                        }
                        Button(role: .destructive) { blockConfirmation = true } label: {
                            Label(text("profile.public.block"), systemImage: "person.slash")
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .accessibilityLabel(text("profile.public.more_actions"))
                }
            }
        }
        .sheet(item: $reportTarget) { target in
            NavigationStack { SafetyReportView(target: target) }
        }
        .alert(text("profile.public.block_confirm_title"), isPresented: $blockConfirmation) {
            Button(text("profile.public.block_confirm_action"), role: .destructive) { block() }
            Button(text("profile.common.cancel"), role: .cancel) { }
        } message: {
            Text(text("profile.public.block_confirm_message"))
        }
        .task(id: identifier) { await load() }
        .refreshable { await load() }
    }

    @ViewBuilder
    private var hostedEventsSection: some View {
        if !hostedEvents.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                SpottSectionHeader(title: text("profile.public.hosted_events"))
                ForEach(hostedEvents) { event in
                    Button { open(event) } label: {
                        HStack(spacing: 13) {
                            EventCoverView(url: event.coverURL, category: "default", cornerRadius: 15)
                                .frame(width: 76, height: 68)

                            VStack(alignment: .leading, spacing: 5) {
                                Text(event.title)
                                    .font(.subheadline.weight(.bold))
                                    .fontDesign(.rounded)
                                    .foregroundStyle(SpottColor.ink)
                                    .lineLimit(2)
                                    .multilineTextAlignment(.leading)
                                Text("\(event.startsAt.formatted(date: .abbreviated, time: .shortened)) · \(event.publicArea)")
                                    .font(.caption)
                                    .foregroundStyle(SpottColor.muted)
                                    .lineLimit(1)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(SpottColor.muted)
                                .accessibilityHidden(true)
                        }
                        .padding(10)
                        .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: 19, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 19, style: .continuous).stroke(SpottColor.hairline))
                        .contentShape(RoundedRectangle(cornerRadius: 19, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .spottPressable()
                    .accessibilityElement(children: .combine)
                }
                if eventsHaveMore {
                    Button {
                        Task { await loadMoreEvents() }
                    } label: {
                        HStack {
                            if loadingMoreEvents { ProgressView() }
                            Text(text("profile.public.more_events"))
                        }
                        .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.glass)
                    .tint(SpottColor.twilight)
                    .disabled(loadingMoreEvents)
                }
            }
        }
    }

    private func profileHeader(_ profile: PublicUserProfile) -> some View {
        VStack(spacing: 17) {
            ZStack {
                Circle()
                    .fill(
                        LinearGradient(
                            colors: [SpottColor.twilightDeep, SpottColor.twilight],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .frame(width: 86, height: 86)
                if let avatarURL = profile.avatarURL {
                    AsyncImage(url: avatarURL) { image in
                        image.resizable().scaledToFill()
                    } placeholder: {
                        initialLetter(profile)
                    }
                    .frame(width: 82, height: 82)
                    .clipShape(Circle())
                } else {
                    initialLetter(profile)
                }
            }
            .accessibilityHidden(true)
            VStack(spacing: 5) {
                Text(profile.nickname)
                    .font(.title2.bold())
                    .fontDesign(.rounded)
                Text(verbatim: "@\(profile.publicHandle)")
                    .font(.subheadline)
                    .foregroundStyle(SpottColor.muted)
                Text(
                    ProfileTabLocalization.format(
                        "profile.public.followers",
                        locale: locale,
                        max(0, profile.followerCount + (following ? 1 : 0) - (profile.viewerFollowing ? 1 : 0))
                    )
                )
                .font(.caption.weight(.semibold))
                .foregroundStyle(SpottColor.muted)
            }
            if model.session?.user.id == profile.userId {
                NavigationLink(text("profile.public.edit")) { EditProfileView() }
                    .buttonStyle(.glass)
                    .tint(SpottColor.twilight)
            } else {
                Button(action: toggleFollow) {
                    Label(
                        following ? text("profile.public.following") : text("profile.public.follow"),
                        systemImage: following ? "checkmark" : "plus"
                    )
                    .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.glassProminent)
                .tint(following ? SpottColor.muted : SpottColor.twilight)
                .disabled(busy)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(22)
        .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: SpottMetric.coverRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: SpottMetric.coverRadius, style: .continuous)
                .stroke(SpottColor.hairline)
        )
    }

    private func initialLetter(_ profile: PublicUserProfile) -> some View {
        Text(String(profile.nickname.prefix(1)))
            .font(.title.bold())
            .fontDesign(.rounded)
            .foregroundStyle(.white)
    }

    private func load() async {
        loading = true
        do {
            async let profileRequest = model.api.publicProfile(identifier: identifier)
            async let eventRequest = model.api.publicProfileEvents(identifier: identifier)
            let value = try await profileRequest
            profile = value
            following = value.viewerFollowing
            if let page = try? await eventRequest {
                hostedEvents = page.items
                eventsCursor = page.nextCursor
                eventsHaveMore = page.hasMore
            }
            error = nil
        } catch {
            profile = nil
            self.error = AppModel.map(error)
        }
        loading = false
    }

    private func loadMoreEvents() async {
        guard eventsHaveMore, let eventsCursor else { return }
        loadingMoreEvents = true
        defer { loadingMoreEvents = false }
        do {
            let page = try await model.api.publicProfileEvents(
                identifier: identifier,
                cursor: eventsCursor
            )
            let known = Set(hostedEvents.map(\.id))
            hostedEvents.append(contentsOf: page.items.filter { !known.contains($0.id) })
            self.eventsCursor = page.nextCursor
            eventsHaveMore = page.hasMore
        } catch {
            self.error = AppModel.map(error)
        }
    }

    private func open(_ publicEvent: PublicHostedEvent) {
        Task { @MainActor in
            do {
                let event = try await model.api.event(identifier: publicEvent.publicSlug)
                model.show(event: event)
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }

    private func toggleFollow() {
        guard model.session != nil else {
            model.presentedGate = .login
            return
        }
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do {
                let result = try await model.api.setProfileFollow(identifier: identifier, following: !following)
                following = result.following
                error = nil
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }

    private func block() {
        guard let profile else { return }
        guard model.session != nil else {
            model.presentedGate = .login
            return
        }
        Task { @MainActor in
            do {
                _ = try await model.api.setUserBlocked(profile.userId, blocked: true, reason: "profile")
                following = false
                model.banner = .init(
                    title: ProfileTabLocalization.format(
                        "profile.public.blocked_banner",
                        locale: locale,
                        profile.publicHandle
                    ),
                    tone: .success
                )
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }

    private func regionTitle(_ region: String?) -> String {
        let known = ["tokyo", "kanagawa", "osaka", "kyoto", "nationwide"]
        guard let region, known.contains(region) else {
            return text("profile.region.unknown")
        }
        return ProfileTabLocalization.text(
            String.LocalizationValue("profile.region.\(region)"),
            locale: locale
        )
    }

    private func languageTitle(_ languages: [String]) -> String {
        let values = languages.map { code in
            switch code {
            case "zh-Hans": text("profile.language.zh")
            case "ja": text("profile.language.ja")
            case "en": text("profile.language.en")
            default: code
            }
        }
        return values.isEmpty ? text("profile.public.no_languages") : values.joined(separator: " · ")
    }

    private func text(_ key: String.LocalizationValue) -> String {
        ProfileTabLocalization.text(key, locale: locale)
    }
}
