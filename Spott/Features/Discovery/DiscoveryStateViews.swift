import SwiftUI

struct DiscoveryRefreshBanner: View {
    let phase: DiscoveryPhase
    let error: UserFacingError
    let retry: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: phase == .offline ? "wifi.slash" : "exclamationmark.triangle")
            VStack(alignment: .leading, spacing: 2) {
                Text(phase == .offline ? "正在显示已保存的活动" : "更新失败")
                    .font(.subheadline.weight(.semibold))
                Text(verbatim: error.message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 4)
            Button("重试", action: retry)
                .buttonStyle(.bordered)
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
    let store: DiscoveryStore

    var body: some View {
        ContentUnavailableView {
            Label("这个地区还没有活动", systemImage: "calendar.badge.plus")
        } description: {
            Text("可以切换地区、放宽筛选，或成为第一个开局的人。")
        } actions: {
            if store.hasActiveFilters {
                Button("清除筛选", action: store.clearFilters)
                    .buttonStyle(.borderedProminent)
            } else {
                Button("重新加载", action: reload)
                    .buttonStyle(.borderedProminent)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("discovery.empty")
    }

    private func reload() {
        Task { await store.refresh() }
    }
}

struct DiscoveryErrorState: View {
    let store: DiscoveryStore

    var body: some View {
        ContentUnavailableView {
            Label("暂时无法加载", systemImage: "wifi.exclamationmark")
        } description: {
            if let error = store.fatalError {
                Text("\(error.message)\n错误编号：\(error.id)")
            }
        } actions: {
            Button("重新连接", action: reload)
                .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("discovery.error")
    }

    private func reload() {
        Task { await store.refresh() }
    }
}

struct DiscoverySkeleton: View {
    var body: some View {
        ScrollView {
            LazyVStack(spacing: 16) {
                DiscoveryFeaturedSkeletonCard()

                ForEach(0 ..< 3, id: \.self) { _ in
                    DiscoveryCompactSkeletonCard()
                }
            }
            .padding(.horizontal, SpottMetric.pageInset)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .background(SpottColor.canvas)
        .allowsHitTesting(false)
        .accessibilityLabel("正在加载活动")
        .accessibilityIdentifier("discovery.loading")
    }
}

private struct DiscoveryFeaturedSkeletonCard: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            RoundedRectangle(cornerRadius: 0)
                .fill(placeholderColor)
                .aspectRatio(16 / 9, contentMode: .fit)

            VStack(alignment: .leading, spacing: 13) {
                placeholderLine(width: 230, height: 24, cornerRadius: 7)
                placeholderLine(width: 188)
                HStack(spacing: 14) {
                    placeholderLine(width: 94)
                    placeholderLine(width: 106)
                }
                HStack(spacing: 10) {
                    Circle()
                        .fill(placeholderColor)
                        .frame(width: 34, height: 34)
                    VStack(alignment: .leading, spacing: 5) {
                        placeholderLine(width: 104, height: 11)
                        placeholderLine(width: 76, height: 9)
                    }
                }
                HStack(spacing: 7) {
                    placeholderCapsule(width: 70)
                    placeholderCapsule(width: 84)
                    placeholderCapsule(width: 62)
                }
            }
            .padding(18)
        }
        .background(SpottColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous)
                .stroke(SpottColor.hairline)
        }
        .redacted(reason: .placeholder)
    }
}

private struct DiscoveryCompactSkeletonCard: View {
    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(placeholderColor)
                .frame(width: 112, height: 168)

            VStack(alignment: .leading, spacing: 8) {
                placeholderLine(width: 92, height: 11)
                placeholderLine(height: 18, cornerRadius: 5)
                placeholderLine(width: 170)
                placeholderLine(width: 130)
                placeholderLine(width: 156)
                Divider()
                HStack(spacing: 8) {
                    Circle()
                        .fill(placeholderColor)
                        .frame(width: 28, height: 28)
                    placeholderLine(width: 112, height: 11)
                }
                HStack(spacing: 6) {
                    placeholderCapsule(width: 62)
                    placeholderCapsule(width: 72)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(14)
        .background(SpottColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous)
                .stroke(SpottColor.hairline)
        }
        .redacted(reason: .placeholder)
    }
}

private let placeholderColor = Color.secondary.opacity(0.12)

private func placeholderLine(
    width: CGFloat? = nil,
    height: CGFloat = 12,
    cornerRadius: CGFloat = 4
) -> some View {
    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        .fill(placeholderColor)
        .frame(maxWidth: width ?? .infinity)
        .frame(height: height)
}

private func placeholderCapsule(width: CGFloat) -> some View {
    Capsule()
        .fill(placeholderColor)
        .frame(width: width, height: 24)
}
