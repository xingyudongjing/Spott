import MapKit
import SwiftUI

struct DiscoveryView: View {
    @Environment(AppModel.self) private var model
    @State private var mapMode = false

    var body: some View {
        Group {
            switch model.eventState {
            case .initial, .loading:
                DiscoverySkeleton()
            case .empty:
                ContentUnavailableView(
                    "这个地区还没有活动",
                    systemImage: "map",
                    description: Text("可以切换地区、放宽筛选，或成为第一个开局的人。")
                )
            case .error(let error):
                ContentUnavailableView {
                    Label("暂时无法加载", systemImage: "wifi.exclamationmark")
                } description: {
                    Text("\(error.message)\n错误编号：\(error.id)")
                } actions: {
                    Button("重新连接") { Task { await model.bootstrap() } }
                        .buttonStyle(.borderedProminent)
                }
            case .content(let events), .offlineContent(let events):
                if mapMode { EventMapView(events: events) }
                else { EventFeed(events: events) }
            }
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) {
            DiscoveryTopBar(mapMode: $mapMode)
        }
    }
}

private struct DiscoveryTopBar: View {
    @Environment(AppModel.self) private var model
    @Binding var mapMode: Bool

    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: 12) {
                topBarContent
            }
        } else {
            topBarContent
        }
    }

    private var topBarContent: some View {
        @Bindable var model = model
        return VStack(spacing: 12) {
            HStack(spacing: 12) {
                Text("spott")
                    .font(.system(size: 22, weight: .bold, design: .rounded))
                    .tracking(-0.8)
                Spacer()
                Menu {
                    regionButton("东京", value: "tokyo")
                    regionButton("神奈川", value: "kanagawa")
                    regionButton("大阪", value: "osaka")
                    regionButton("京都", value: "kyoto")
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "location.fill")
                            .font(.system(size: 11, weight: .semibold))
                        Text(LocalizedStringKey(regionTitle))
                            .font(.system(size: 13, weight: .semibold, design: .rounded))
                        Image(systemName: "chevron.down")
                            .font(.system(size: 8, weight: .bold))
                    }
                    .foregroundStyle(SpottColor.ink)
                    .padding(.horizontal, 13)
                    .frame(height: 38)
                    .spottGlassPanel(shape: Capsule())
                }
                topButton(
                    icon: mapMode ? "rectangle.grid.1x2" : "map",
                    accessibilityLabel: mapMode ? "显示列表" : "显示地图"
                ) { mapMode.toggle() }
                topButton(icon: "bell", accessibilityLabel: "通知") {
                    model.router.push(.notifications)
                }
            }
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(SpottColor.muted)
                TextField("搜索活动、地区或兴趣", text: $model.searchText)
                    .font(.system(size: 15, weight: .medium, design: .rounded))
                    .submitLabel(.search)
                    .onSubmit { Task { await model.refresh() } }
                if !model.searchText.isEmpty {
                    Button { model.searchText = ""; Task { await model.refresh() } } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(SpottColor.muted)
                    }
                }
            }
            .padding(.horizontal, 15)
            .frame(height: 48)
            .spottGlassPanel(shape: RoundedRectangle(cornerRadius: 17, style: .continuous))
        }
        .padding(.horizontal, SpottMetric.pageInset)
        .padding(.top, 8)
        .padding(.bottom, 12)
        .background(SpottColor.canvas)
        .accessibilityIdentifier("discovery.glass.header")
    }

    private func topButton(
        icon: String,
        accessibilityLabel: LocalizedStringKey,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(SpottColor.ink)
                .frame(width: 38, height: 38)
                .spottGlassPanel(shape: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
    }

    private func regionButton(_ title: String, value: String) -> some View {
        Button {
            model.region = value
            Task { await model.refresh() }
        } label: {
            Text(LocalizedStringKey(title))
        }
    }

    private var regionTitle: String {
        ["tokyo": "东京", "kanagawa": "神奈川", "osaka": "大阪", "kyoto": "京都"][model.region] ?? "日本"
    }
}

private struct EventFeed: View {
    @Environment(AppModel.self) private var model
    let events: [EventSummary]
    @State private var selectedCategory: String?

    private let categories: [(String?, String, String)] = [
        (nil, "全部", "circle.grid.2x2"),
        ("family", "亲子", "figure.and.child.holdinghands"),
        ("outdoor", "户外", "mountain.2"),
        ("sports", "运动", "figure.run"),
        ("city-walk", "城市探索", "building.2"),
        ("food", "美食", "fork.knife"),
        ("games", "游戏", "dice"),
        ("art", "文化艺术", "paintpalette"),
        ("learning", "技能学习", "book.closed"),
        ("networking", "职业交流", "person.2.wave.2")
    ]

    private var filtered: [EventSummary] {
        guard let selectedCategory else { return events }
        return events.filter { event in
            event.tags.contains(selectedCategory) ||
            (selectedCategory == "outdoor" && event.tags.contains("water")) ||
            (selectedCategory == "art" && event.tags.contains("music"))
        }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 28) {
                HeroIntro()
                categoryStrip
                eventSection
                hostInvitation
            }
            .padding(.horizontal, SpottMetric.pageInset)
            .padding(.top, 16)
            .padding(.bottom, 32)
        }
        .refreshable { await model.refresh() }
    }

    private var categoryStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 9) {
                ForEach(categories, id: \.1) { value, title, icon in
                    Button {
                        withAnimation(.snappy) { selectedCategory = value }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: icon).font(.system(size: 12, weight: .semibold))
                            Text(LocalizedStringKey(title)).font(.system(size: 13, weight: .semibold, design: .rounded))
                        }
                        .foregroundStyle(selectedCategory == value ? Color.white : SpottColor.muted)
                        .padding(.horizontal, 13)
                        .frame(height: 35)
                        .spottGlassPanel(
                            shape: Capsule(),
                            tint: selectedCategory == value ? SpottColor.twilight : nil
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .contentMargins(.horizontal, 0)
    }

    private var eventSection: some View {
        VStack(alignment: .leading, spacing: 15) {
            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("THIS WEEKEND")
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .tracking(1.4)
                        .foregroundStyle(SpottColor.coral)
                    Text(LocalizedStringKey(selectedCategory == nil ? "本周值得出门" : "为你筛选的活动"))
                        .font(.system(size: 24, weight: .bold, design: .rounded))
                }
                Spacer()
                Text("\(filtered.count) 个活动")
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .foregroundStyle(SpottColor.muted)
            }
            if filtered.isEmpty {
                ContentUnavailableView(
                    "这组筛选还没有活动",
                    systemImage: "sparkles",
                    description: Text("换一个分类，或者发起你真正想参加的活动。")
                )
                .frame(maxWidth: .infinity, minHeight: 230)
                .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: SpottMetric.cardRadius))
            } else {
                ForEach(filtered) { event in
                    Button { model.show(event: event) } label: {
                        EventCardView(event: event)
                    }
                    .buttonStyle(SpottCardButtonStyle())
                }
            }
        }
    }

    private var hostInvitation: some View {
        Button { model.router.selectedTab = .create } label: {
            HStack(spacing: 14) {
                ZStack {
                    Circle().fill(SpottColor.twilightPale).frame(width: 46, height: 46)
                    Image(systemName: "plus").font(.system(size: 17, weight: .bold)).foregroundStyle(SpottColor.twilight)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text("想参加的活动还不存在？")
                        .font(.system(size: 16, weight: .semibold, design: .rounded))
                    Text("从一个标题开始，创建你想见到的现场")
                        .font(.system(size: 12.5, weight: .regular, design: .rounded))
                        .foregroundStyle(SpottColor.muted)
                }
                Spacer()
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(SpottColor.twilight)
            }
            .padding(18)
            .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: SpottMetric.cardRadius).stroke(Color.white))
        }
        .buttonStyle(.plain)
    }
}

private struct HeroIntro: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            Text("TOKYO · JULY 15")
                .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                .tracking(1.7)
                .foregroundStyle(SpottColor.coral)
            Text("去见一座城市\n真正有趣的那面。")
                .font(.system(size: 33, weight: .bold, design: .rounded))
                .tracking(-1.2)
                .foregroundStyle(SpottColor.ink)
                .lineSpacing(-3)
            Text("由在地的人认真发起，也为第一次参加的人留好位置。")
                .font(.system(size: 15, weight: .regular, design: .rounded))
                .foregroundStyle(SpottColor.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct EventCardView: View {
    let event: EventSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .top) {
                cover
                    .frame(height: 184)
                    .clipped()
                HStack {
                    dateBadge
                    Spacer()
                    Text(verbatim: event.priceLabel)
                        .font(.system(size: 12, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 11)
                        .frame(height: 31)
                        .background(.black.opacity(0.34), in: Capsule())
                        .background(.ultraThinMaterial, in: Capsule())
                }
                .padding(14)
            }
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(verbatim: event.title)
                        .font(.system(size: 19, weight: .bold, design: .rounded))
                        .tracking(-0.5)
                        .foregroundStyle(SpottColor.ink)
                        .lineLimit(2)
                    HStack(spacing: 6) {
                        Image(systemName: "location")
                        Text(verbatim: event.publicArea ?? "")
                        Text("·")
                        if let time = event.startsAt?.formatted(date: .omitted, time: .shortened) {
                            Text(verbatim: time)
                        } else {
                            Text("时间待定")
                        }
                    }
                    .font(.system(size: 12.5, weight: .medium, design: .rounded))
                    .foregroundStyle(SpottColor.muted)
                    .lineLimit(1)
                }
                HStack(spacing: 8) {
                    tagPill(event.tags.first ?? "other")
                    if let extra = event.tags.dropFirst().first { tagPill(extra) }
                    Spacer()
                    HStack(spacing: 5) {
                        Circle().fill(event.remaining > 2 ? SpottColor.mint : SpottColor.amber).frame(width: 6, height: 6)
                        if event.remaining > 0 {
                            Text("余 \(event.remaining)")
                        } else {
                            Text("候补中")
                        }
                    }
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                    .foregroundStyle(event.remaining > 2 ? SpottColor.mint : SpottColor.amber)
                }
            }
            .padding(17)
        }
        .background(SpottColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: SpottMetric.coverRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: SpottMetric.coverRadius, style: .continuous).stroke(Color.white.opacity(0.9)))
        .shadow(color: SpottColor.ink.opacity(0.045), radius: 16, y: 7)
        .accessibilityElement(children: .combine)
        .accessibilityHint("打开活动详情")
    }

    @ViewBuilder private var cover: some View {
        if let url = event.coverURL {
            AsyncImage(url: url) { phase in
                if let image = phase.image { image.resizable().scaledToFill() }
                else { SpottCoverArtwork(tags: event.tags) }
            }
        } else {
            SpottCoverArtwork(tags: event.tags)
        }
    }

    private var dateBadge: some View {
        VStack(spacing: 0) {
            if let startsAt = event.startsAt {
                Text(verbatim: startsAt.formatted(.dateTime.month(.abbreviated)))
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .textCase(.uppercase)
                Text(verbatim: startsAt.formatted(.dateTime.day()))
                    .font(.system(size: 20, weight: .bold, design: .rounded))
            } else {
                Text("时间待定")
                    .font(.system(size: 9, weight: .bold, design: .rounded))
                    .multilineTextAlignment(.center)
            }
        }
        .foregroundStyle(SpottColor.ink)
        .frame(width: 48, height: 48)
        .background(.white.opacity(0.88), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    @ViewBuilder private func tagPill(_ value: String) -> some View {
        Group {
            if let key = localizedTagKey(value) {
                Text(key)
            } else {
                Text(verbatim: value)
            }
        }
        .font(.system(size: 11, weight: .semibold, design: .rounded))
        .foregroundStyle(SpottColor.muted)
        .padding(.horizontal, 9)
        .frame(height: 27)
        .background(SpottColor.canvas, in: Capsule())
    }

    private func localizedTagKey(_ value: String) -> LocalizedStringKey? {
        switch value {
        case "city-walk", "walk": "城市探索"
        case "music": "音乐"
        case "outdoor": "户外"
        case "sports": "运动"
        case "family": "亲子"
        case "food": "美食"
        case "games": "游戏"
        case "art": "文化艺术"
        case "learning": "技能学习"
        case "language": "语言交换"
        case "networking": "职业交流"
        default: nil
        }
    }
}

private struct SpottCoverArtwork: View {
    let tags: [String]
    private var category: String { tags.first ?? "other" }

    var body: some View {
        ZStack {
            LinearGradient(colors: palette, startPoint: .topLeading, endPoint: .bottomTrailing)
            Circle()
                .fill(Color.white.opacity(0.16))
                .frame(width: 220, height: 220)
                .blur(radius: 1)
                .offset(x: 130, y: -75)
            RoundedRectangle(cornerRadius: 80, style: .continuous)
                .fill(Color.black.opacity(0.10))
                .frame(width: 250, height: 80)
                .rotationEffect(.degrees(-28))
                .offset(x: -105, y: 90)
            VStack(spacing: 8) {
                Image(systemName: symbol)
                    .font(.system(size: 31, weight: .light))
                if let labelKey {
                    Text(labelKey)
                        .textCase(.uppercase)
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .tracking(2.2)
                } else {
                    Text(verbatim: "SPOTT")
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .tracking(2.2)
                }
            }
            .foregroundStyle(.white.opacity(0.90))
        }
        .drawingGroup()
        .accessibilityHidden(true)
    }

    private var palette: [Color] {
        switch category {
        case "music": [Color(red: 0.19, green: 0.12, blue: 0.35), Color(red: 0.82, green: 0.32, blue: 0.42)]
        case "outdoor", "sports", "water": [Color(red: 0.06, green: 0.32, blue: 0.34), Color(red: 0.18, green: 0.61, blue: 0.52)]
        case "food": [Color(red: 0.43, green: 0.20, blue: 0.11), Color(red: 0.91, green: 0.52, blue: 0.28)]
        case "art": [Color(red: 0.23, green: 0.16, blue: 0.47), Color(red: 0.62, green: 0.38, blue: 0.87)]
        default: [Color(red: 0.10, green: 0.26, blue: 0.36), Color(red: 0.36, green: 0.29, blue: 0.82)]
        }
    }

    private var symbol: String {
        ["music": "waveform", "outdoor": "mountain.2", "sports": "figure.run", "water": "water.waves", "food": "fork.knife", "art": "paintpalette", "city-walk": "building.2"][category] ?? "sparkles"
    }

    private var labelKey: LocalizedStringKey? {
        switch category {
        case "music": "音乐"
        case "outdoor": "户外"
        case "sports": "运动"
        case "water": "涉水"
        case "food": "美食"
        case "art": "文化艺术"
        case "city-walk": "城市探索"
        default: nil
        }
    }
}

private struct SpottCardButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .opacity(configuration.isPressed ? 0.94 : 1)
            .animation(.snappy(duration: 0.18), value: configuration.isPressed)
    }
}

private struct EventMapView: View {
    let events: [EventSummary]
    @State private var position: MapCameraPosition = .region(.init(center: .init(latitude: 35.6812, longitude: 139.7671), span: .init(latitudeDelta: 0.18, longitudeDelta: 0.18)))

    var body: some View {
        Map(position: $position) {
            ForEach(Array(events.enumerated()), id: \.element.id) { index, event in
                Annotation(event.title, coordinate: coordinate(for: index)) {
                    marker(for: event)
                }
            }
        }
        .mapControls { MapCompass(); MapScaleView() }
    }

    private func coordinate(for index: Int) -> CLLocationCoordinate2D {
        CLLocationCoordinate2D(
            latitude: 35.6812 + Double(index) * 0.025,
            longitude: 139.7671 - Double(index) * 0.035
        )
    }

    private func marker(for event: EventSummary) -> some View {
        VStack(spacing: 2) {
            remainingLabel(for: event)
                .font(.system(size: 11, weight: .bold, design: .rounded))
            Circle()
                .fill(.white)
                .frame(width: 5, height: 5)
        }
        .frame(width: 48, height: 48)
        .background(SpottColor.twilight, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .foregroundStyle(.white)
        .shadow(color: SpottColor.ink.opacity(0.18), radius: 8, y: 4)
    }

    @ViewBuilder
    private func remainingLabel(for event: EventSummary) -> some View {
        if event.remaining > 0 {
            Text(verbatim: event.remaining.formatted())
        } else {
            Text("候补")
        }
    }
}

private struct DiscoverySkeleton: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.10)).frame(width: 260, height: 82)
                ForEach(0..<3, id: \.self) { _ in
                    RoundedRectangle(cornerRadius: SpottMetric.coverRadius)
                        .fill(SpottColor.surface)
                        .frame(height: 330)
                        .overlay(LinearGradient(colors: [.clear, Color.secondary.opacity(0.06), .clear], startPoint: .leading, endPoint: .trailing))
                }
            }
            .padding(SpottMetric.pageInset)
        }
        .accessibilityLabel("正在加载活动")
    }
}
