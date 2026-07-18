import SwiftUI

struct DiscoveryChromeLayoutPolicy {
    let dynamicTypeSize: DynamicTypeSize

    var usesStackedFilterLabels: Bool { dynamicTypeSize.isAccessibilitySize }
    var usesStackedModeBar: Bool { dynamicTypeSize.isAccessibilitySize }
    var filterLabelLineLimit: Int? { dynamicTypeSize.isAccessibilitySize ? nil : 1 }
    var emphasizesResultCount: Bool { true }
    var listBottomContentMargin: CGFloat {
        dynamicTypeSize.isAccessibilitySize ? 72 : 32
    }
}

struct DiscoveryFilterStrip: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let store: DiscoveryStore

    private struct Category: Identifiable {
        let value: String?
        let title: LocalizedStringKey
        let symbol: String
        var id: String { value ?? "all" }
    }

    private static let categories: [Category] = [
        .init(value: nil, title: "全部", symbol: "square.grid.2x2"),
        .init(value: "family", title: "亲子", symbol: "figure.and.child.holdinghands"),
        .init(value: "outdoor", title: "户外", symbol: "mountain.2"),
        .init(value: "sports", title: "运动", symbol: "figure.run"),
        .init(value: "city-walk", title: "城市探索", symbol: "building.2"),
        .init(value: "food", title: "美食", symbol: "fork.knife"),
        .init(value: "art", title: "文化艺术", symbol: "paintpalette"),
        .init(value: "learning", title: "技能学习", symbol: "book.closed"),
        .init(value: "networking", title: "职业交流", symbol: "person.2")
    ]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            if #available(iOS 26.0, *) {
                GlassEffectContainer(spacing: 8) {
                    FilterOptions(
                        store: store,
                        categories: Self.categories,
                        layoutPolicy: layoutPolicy
                    )
                }
            } else {
                FilterOptions(
                    store: store,
                    categories: Self.categories,
                    layoutPolicy: layoutPolicy
                )
            }
        }
        .contentMargins(.horizontal, 16)
        .contentMargins(.vertical, dynamicTypeSize.isAccessibilitySize ? 12 : 8)
        .fixedSize(horizontal: false, vertical: true)
        .scrollClipDisabled()
        .scrollBounceBehavior(.basedOnSize)
        .background(SpottColor.canvas)
        .accessibilityIdentifier("discovery.filters")
    }

    private var layoutPolicy: DiscoveryChromeLayoutPolicy {
        DiscoveryChromeLayoutPolicy(dynamicTypeSize: dynamicTypeSize)
    }

    private struct FilterOptions: View {
        let store: DiscoveryStore
        let categories: [Category]
        let layoutPolicy: DiscoveryChromeLayoutPolicy

        var body: some View {
            LazyHStack(spacing: 8) {
                ForEach(categories) { category in
                    CategoryButton(
                        title: category.title,
                        symbol: category.symbol,
                        isSelected: store.category == category.value,
                        layoutPolicy: layoutPolicy,
                        action: { select(category.value) }
                    )
                }
                DiscoveryMoreFiltersMenu(store: store, layoutPolicy: layoutPolicy)
            }
        }

        private func select(_ category: String?) {
            guard store.category != category else { return }
            store.category = category
            store.filtersDidChange()
        }
    }
}

private struct CategoryButton: View {
    let title: LocalizedStringKey
    let symbol: String
    let isSelected: Bool
    let layoutPolicy: DiscoveryChromeLayoutPolicy
    let action: () -> Void

    var body: some View {
        if #available(iOS 26.0, *) {
            if isSelected {
                button.buttonStyle(.glassProminent)
            } else {
                button.buttonStyle(.glass)
            }
        } else if isSelected {
            button
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
        } else {
            button
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
        }
    }

    private var button: some View {
        Button(action: action) {
            if layoutPolicy.usesStackedFilterLabels {
                VStack(spacing: 6) {
                    Image(systemName: symbol)
                    Text(title)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .font(.subheadline.weight(.semibold))
                .frame(minWidth: 78, minHeight: 72)
            } else {
                Label(title, systemImage: symbol)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(layoutPolicy.filterLabelLineLimit)
                    .frame(minHeight: 44)
            }
        }
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

private struct DiscoveryMoreFiltersMenu: View {
    let store: DiscoveryStore
    let layoutPolicy: DiscoveryChromeLayoutPolicy

    var body: some View {
        if #available(iOS 26.0, *) {
            menu.buttonStyle(.glass)
        } else {
            menu
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
        }
    }

    private var menu: some View {
        Menu {
            Button(action: toggleAvailability) {
                filterLabel("有空位", selected: store.availableOnly == true)
            }
            Menu("形式") {
                valueButton("全部", selected: store.format == nil) { store.format = nil }
                valueButton("线下", selected: store.format == .inPerson) { store.format = .inPerson }
                valueButton("线上", selected: store.format == .online) { store.format = .online }
                valueButton("混合", selected: store.format == .hybrid) { store.format = .hybrid }
            }
            Menu("语言") {
                valueButton("全部", selected: store.language == nil) { store.language = nil }
                valueButton("简体中文", selected: store.language == .zhHans) { store.language = .zhHans }
                valueButton("日本語", selected: store.language == .ja) { store.language = .ja }
                valueButton("English", selected: store.language == .en) { store.language = .en }
            }
            Menu("费用") {
                valueButton("全部", selected: store.price == nil) { store.price = nil }
                valueButton("免费", selected: store.price == .free) { store.price = .free }
                valueButton("付费", selected: store.price == .paid) { store.price = .paid }
            }
            if store.hasActiveFilters {
                Divider()
                Button("清除筛选", role: .destructive, action: store.clearFilters)
            }
        } label: {
            if layoutPolicy.usesStackedFilterLabels {
                VStack(spacing: 6) {
                    Image(
                        systemName: store.hasActiveFilters
                            ? "line.3.horizontal.decrease.circle.fill"
                            : "line.3.horizontal.decrease.circle"
                    )
                    Text("筛选")
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .font(.subheadline.weight(.semibold))
                .frame(minWidth: 78, minHeight: 72)
            } else {
                Label(
                    "筛选",
                    systemImage: store.hasActiveFilters
                        ? "line.3.horizontal.decrease.circle.fill"
                        : "line.3.horizontal.decrease.circle"
                )
                .font(.subheadline.weight(.semibold))
                .lineLimit(layoutPolicy.filterLabelLineLimit)
                .frame(minHeight: 44)
            }
        }
        .accessibilityIdentifier("discovery.more-filters")
    }

    private func valueButton(
        _ title: LocalizedStringKey,
        selected: Bool,
        update: @escaping () -> Void
    ) -> some View {
        Button {
            update()
            store.filtersDidChange()
        } label: {
            filterLabel(title, selected: selected)
        }
    }

    private func filterLabel(_ title: LocalizedStringKey, selected: Bool) -> some View {
        Label(title, systemImage: selected ? "checkmark" : "circle")
    }

    private func toggleAvailability() {
        store.availableOnly = store.availableOnly == true ? nil : true
        store.filtersDidChange()
    }
}
