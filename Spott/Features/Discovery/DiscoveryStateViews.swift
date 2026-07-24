import SwiftUI

struct DiscoveryRefreshBanner: View {
    @Environment(\.locale) private var locale
    let phase: DiscoveryPhase
    let error: UserFacingError
    let retry: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: phase == .offline ? "wifi.slash" : "exclamationmark.triangle")
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: DiscoveryHomeLocalization.text(
                    phase == .offline
                        ? "discovery.state.offline"
                        : "discovery.state.update_failed",
                    locale: locale
                ))
                .font(.subheadline.weight(.semibold))
                Text(verbatim: error.message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 4)
            Button(
                DiscoveryHomeLocalization.text("discovery.state.retry", locale: locale),
                action: retry
            )
            .buttonStyle(.glass)
            .buttonBorderShape(.capsule)
            .frame(minHeight: 44)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(.bar)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("discovery.refresh-error")
    }
}

struct DiscoveryEmptyState: View {
    @Environment(\.locale) private var locale
    let store: DiscoveryStore
    let applyWeekendPreset: () -> Void
    let onClearNearMe: () -> Void

    var body: some View {
        ScrollView {
            if store.hasActiveFilters || !store.searchText.trimmed.isEmpty {
                filteredEmpty
            } else {
                regionalEmpty
            }
        }
        .background(SpottScreenBackground())
        .accessibilityIdentifier("discovery.empty")
    }

    private var regionalEmpty: some View {
        SpottEmptyState(
            icon: "calendar.badge.plus",
            title: DiscoveryHomeLocalization.text("discovery.state.empty.title", locale: locale),
            message: DiscoveryHomeLocalization.text(
                "discovery.state.empty.message", locale: locale
            ),
            actionTitle: DiscoveryHomeLocalization.text(
                "discovery.state.empty.reload", locale: locale
            )
        ) {
            reload()
        }
        .padding(.top, 64)
    }

    private var filteredEmpty: some View {
        VStack(spacing: 16) {
            SpottEmptyState(
                icon: "line.3.horizontal.decrease",
                title: DiscoveryHomeLocalization.text(
                    "discovery.state.results_empty.title", locale: locale
                ),
                message: DiscoveryHomeLocalization.text(
                    "discovery.state.empty.message", locale: locale
                )
            )
            HStack(spacing: 12) {
                Button {
                    onClearNearMe()
                    store.clearFilters()
                } label: {
                    Text(verbatim: DiscoveryHomeLocalization.text(
                        "discovery.state.results_empty.clear", locale: locale
                    ))
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 6)
                    .frame(minHeight: 44)
                }
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.capsule)
                .tint(SpottColor.twilight)

                Button(action: applyWeekendPreset) {
                    Text(verbatim: DiscoveryHomeLocalization.text(
                        "discovery.state.results_empty.weekend", locale: locale
                    ))
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 6)
                    .frame(minHeight: 44)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.capsule)
                .tint(SpottColor.ink)
            }
        }
        .padding(.top, 64)
    }

    private func reload() {
        Task { await store.refresh() }
    }
}

struct DiscoveryErrorState: View {
    @Environment(\.locale) private var locale
    let store: DiscoveryStore

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                SpottEmptyState(
                    icon: "wifi.exclamationmark",
                    title: DiscoveryHomeLocalization.text(
                        "discovery.state.error.title", locale: locale
                    ),
                    message: errorMessage,
                    actionTitle: DiscoveryHomeLocalization.text(
                        "discovery.state.error.retry", locale: locale
                    )
                ) {
                    reload()
                }
            }
            .padding(.top, 64)
        }
        .background(SpottScreenBackground())
        .accessibilityIdentifier("discovery.error")
    }

    private var errorMessage: String {
        guard let error = store.fatalError else {
            return DiscoveryHomeLocalization.text("discovery.state.error.title", locale: locale)
        }
        let code = DiscoveryHomeLocalization.format(
            "discovery.state.error.code", locale: locale, error.id
        )
        return "\(error.message)\n\(code)"
    }

    private func reload() {
        Task { await store.refresh() }
    }
}

struct DiscoverySkeleton: View {
    @Environment(\.locale) private var locale
    let showsModules: Bool

    init(showsModules: Bool = true) {
        self.showsModules = showsModules
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                RoundedRectangle(cornerRadius: 6)
                    .fill(Color.secondary.opacity(0.12))
                    .frame(width: 180, height: 14)
                    .padding(.horizontal, 16)
                if showsModules {
                    DiscoveryFeedSkeleton()
                }
                VStack(spacing: 16) {
                    DiscoveryCardSkeleton()
                    DiscoveryCardSkeleton()
                }
                .padding(.horizontal, 16)
            }
            .padding(.top, 8)
            .spottSkeleton()
        }
        .scrollDisabled(true)
        .background(SpottScreenBackground())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: DiscoveryHomeLocalization.text(
            "discovery.state.loading", locale: locale
        )))
        .accessibilityIdentifier("discovery.loading")
    }
}

struct DiscoveryFeedSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(Color.secondary.opacity(0.12))
                .frame(height: 420)
                .padding(.horizontal, 16)
            HStack(spacing: 12) {
                ForEach(0 ..< 2, id: \.self) { _ in
                    VStack(alignment: .leading, spacing: 8) {
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(Color.secondary.opacity(0.12))
                            .frame(width: 240, height: 132)
                        RoundedRectangle(cornerRadius: 4)
                            .fill(Color.secondary.opacity(0.12))
                            .frame(width: 120, height: 12)
                        RoundedRectangle(cornerRadius: 5)
                            .fill(Color.secondary.opacity(0.12))
                            .frame(width: 200, height: 16)
                    }
                }
            }
            .padding(.horizontal, 16)
        }
        .accessibilityHidden(true)
    }
}

private struct DiscoveryCardSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            RoundedRectangle(cornerRadius: 0)
                .fill(Color.secondary.opacity(0.12))
                .aspectRatio(16 / 9, contentMode: .fit)
            VStack(alignment: .leading, spacing: 8) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(Color.secondary.opacity(0.12))
                    .frame(width: 140, height: 11)
                RoundedRectangle(cornerRadius: 5)
                    .fill(Color.secondary.opacity(0.12))
                    .frame(height: 18)
                RoundedRectangle(cornerRadius: 4)
                    .fill(Color.secondary.opacity(0.12))
                    .frame(width: 180, height: 12)
            }
            .padding(12)
        }
        .background(SpottColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}
