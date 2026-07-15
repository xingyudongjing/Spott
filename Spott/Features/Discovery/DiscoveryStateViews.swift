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
        List(0 ..< 5, id: \.self) { _ in
            DiscoverySkeletonRow()
        }
        .listStyle(.plain)
        .accessibilityLabel("正在加载活动")
        .accessibilityIdentifier("discovery.loading")
    }
}

private struct DiscoverySkeletonRow: View {
    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            RoundedRectangle(cornerRadius: 14)
                .fill(Color.secondary.opacity(0.12))
                .frame(width: 112, height: 112)
            VStack(alignment: .leading, spacing: 10) {
                RoundedRectangle(cornerRadius: 4).frame(width: 92, height: 11)
                RoundedRectangle(cornerRadius: 5).frame(height: 18)
                RoundedRectangle(cornerRadius: 4).frame(maxWidth: 170).frame(height: 12)
                RoundedRectangle(cornerRadius: 4).frame(maxWidth: 130).frame(height: 12)
            }
            .foregroundStyle(Color.secondary.opacity(0.12))
        }
        .redacted(reason: .placeholder)
        .listRowInsets(.init(top: 12, leading: 16, bottom: 12, trailing: 16))
    }
}
