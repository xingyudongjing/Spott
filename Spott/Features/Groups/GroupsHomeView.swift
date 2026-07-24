import SwiftUI

enum GroupDirectoryScope: String, CaseIterable, Identifiable, Sendable {
    case discover
    case mine

    var id: String { rawValue }
    var requiresAuthentication: Bool { self == .mine }
}

struct GroupsHomeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    @State private var groups: [GroupSummary] = []
    @State private var scope = GroupDirectoryScope.discover
    @State private var query = ""
    @State private var loading = false
    @State private var error: UserFacingError?
    @State private var sheet: GroupHomeSheet?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                header
                controls
                if model.session == nil {
                    signedOutCard
                }
                content
            }
            .padding(.horizontal, SpottMetric.pageInset)
            .padding(.top, 18)
            .padding(.bottom, 36)
        }
        .background(SpottScreenBackground())
        .toolbar(.hidden, for: .navigationBar)
        .task(id: loadID) {
            if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                try? await Task.sleep(for: .milliseconds(250))
            }
            guard !Task.isCancelled else { return }
            await load()
        }
        .refreshable { await load() }
        .onChange(of: model.session?.sessionId) { _, sessionID in
            if sessionID == nil, scope.requiresAuthentication {
                scope = .discover
            }
        }
        .sheet(item: $sheet) { destination in
            switch destination {
            case .create:
                CreateGroupView { group in
                    query = ""
                    scope = .mine
                    groups = [group]
                    Task { await load() }
                }
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: text("groups.home.eyebrow"))
                .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                .tracking(1.6)
                .foregroundStyle(SpottColor.coral)
            Text(verbatim: text("groups.home.title"))
                .font(.system(size: 33, weight: .bold, design: .rounded))
                .tracking(-1.1)
                .lineSpacing(-2)
                .accessibilityAddTraits(.isHeader)
            Text(verbatim: text("groups.home.subtitle"))
                .font(.system(size: 14.5, design: .rounded))
                .foregroundStyle(SpottColor.muted)
                .lineSpacing(3)
        }
    }

    private var controls: some View {
        SpottGlassGroup(spacing: 12) {
            VStack(spacing: 12) {
                HStack(spacing: 8) {
                    ForEach(GroupDirectoryScope.allCases) { item in
                        Button {
                            select(item)
                        } label: {
                            Label(scopeTitle(item), systemImage: item == .discover ? "sparkles" : "person.2.fill")
                                .font(.system(size: 13.5, weight: .semibold, design: .rounded))
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .foregroundStyle(scope == item ? SpottColor.twilightDeep : SpottColor.muted)
                                .background(
                                    scope == item ? SpottColor.twilight.opacity(0.13) : Color.clear,
                                    in: Capsule()
                                )
                        }
                        .buttonStyle(.plain)
                    }
                    if model.session != nil {
                        GlassIconButton(
                            systemImage: "plus",
                            accessibilityLabel: text("groups.home.create"),
                            tint: SpottColor.twilight
                        ) {
                            model.requireTrust(for: .joinGroup) { sheet = .create }
                        }
                    }
                }
                .padding(5)
                .spottGlassPanel(shape: Capsule(), interactive: true)

                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(SpottColor.muted)
                    TextField(text("groups.home.search_prompt"), text: $query)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    if !query.isEmpty {
                        Button {
                            query = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(SpottColor.muted)
                                .frame(width: 44, height: 44)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(Text(verbatim: text("groups.home.clear_search")))
                    }
                }
                .padding(.horizontal, 16)
                .frame(minHeight: 52)
                .spottGlassPanel(
                    shape: RoundedRectangle(cornerRadius: SpottMetric.controlRadius, style: .continuous),
                    interactive: true
                )
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if loading, groups.isEmpty {
            VStack(spacing: 16) {
                ForEach(0..<2, id: \.self) { _ in
                    RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous)
                        .fill(SpottColor.surface)
                        .frame(height: 246)
                }
            }
            .spottSkeleton()
        } else if let error, groups.isEmpty {
            SpottEmptyState(
                icon: "wifi.exclamationmark",
                title: text("groups.home.error_title"),
                message: "\(error.message)\n\(GroupsLocalization.format("groups.common.error_code", locale: locale, error.id))",
                actionTitle: text("groups.common.reconnect")
            ) {
                Task { await load() }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 32)
        } else if groups.isEmpty {
            SpottEmptyState(
                icon: query.isEmpty ? "person.3" : "magnifyingglass",
                title: emptyTitle,
                message: emptyMessage,
                actionTitle: scope == .mine ? text("groups.home.empty_mine_action") : nil
            ) {
                scope = .discover
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 32)
        } else {
            if let error {
                GroupErrorBanner(error: error) {
                    self.error = nil
                }
            }
            ForEach(groups) { group in
                NavigationLink(value: AppRoute.group(group.id)) {
                    CommunityCard(group: group)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var signedOutCard: some View {
        GroupContentCard {
            HStack(alignment: .top, spacing: 15) {
                Image(systemName: "person.3.sequence.fill")
                    .font(.system(size: 24, weight: .medium))
                    .foregroundStyle(SpottColor.twilight)
                    .frame(width: 48, height: 48)
                    .background(SpottColor.twilightPale, in: Circle())
                VStack(alignment: .leading, spacing: 8) {
                    Text(verbatim: text("groups.home.signed_out_title"))
                        .font(.system(size: 17, weight: .bold, design: .rounded))
                    Text(verbatim: text("groups.home.signed_out_message"))
                        .font(.system(size: 13.5, design: .rounded))
                        .foregroundStyle(SpottColor.muted)
                        .lineSpacing(3)
                    Button(text("groups.home.signed_out_cta")) {
                        model.presentedGate = .login
                    }
                    .buttonStyle(.glassProminent)
                    .buttonBorderShape(.capsule)
                    .tint(SpottColor.twilight)
                }
            }
        }
    }

    private var loadID: String {
        "\(scope.rawValue)|\(query)|\(model.session?.sessionId.uuidString ?? "guest")"
    }

    private var emptyTitle: String {
        if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return text("groups.home.empty_search_title")
        }
        return scope == .mine ? text("groups.home.empty_mine_title") : text("groups.home.empty_discover_title")
    }

    private var emptyMessage: String {
        if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return text("groups.home.empty_search_message")
        }
        return scope == .mine
            ? text("groups.home.empty_mine_message")
            : text("groups.home.empty_discover_message")
    }

    private func scopeTitle(_ item: GroupDirectoryScope) -> String {
        item == .discover ? text("groups.home.scope_discover") : text("groups.home.scope_mine")
    }

    private func select(_ item: GroupDirectoryScope) {
        guard !item.requiresAuthentication || model.session != nil else {
            model.presentedGate = .login
            return
        }
        scope = item
    }

    private func load() async {
        if scope.requiresAuthentication, model.session == nil {
            scope = .discover
            return
        }
        loading = true
        error = nil
        defer { loading = false }
        do {
            let page: GroupPage
            if scope == .mine {
                page = try await model.api.groups()
            } else {
                page = try await model.api.discoverGroups(
                    region: model.region,
                    query: query.trimmed.nilIfEmpty
                )
            }
            guard !Task.isCancelled else { return }
            if scope == .mine, !query.trimmed.isEmpty {
                let needle = query.trimmed.folding(
                    options: [.caseInsensitive, .diacriticInsensitive],
                    locale: .current
                )
                groups = page.items.filter { group in
                    ([group.name, group.description, group.regionId] + group.tags)
                        .contains { $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current).contains(needle) }
                }
            } else {
                groups = page.items
            }
        } catch is CancellationError {
            return
        } catch {
            self.error = AppModel.map(error)
        }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        GroupsLocalization.text(key, locale: locale)
    }
}

private enum GroupHomeSheet: String, Identifiable {
    case create
    var id: String { rawValue }
}
