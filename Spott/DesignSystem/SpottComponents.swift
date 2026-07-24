import SwiftUI

struct SpottSectionHeader: View {
    let title: String
    let subtitle: String?
    let eyebrow: String?
    let actionTitle: String?
    let action: (() -> Void)?

    init(
        title: String,
        subtitle: String? = nil,
        eyebrow: String? = nil,
        actionTitle: String? = nil,
        action: (() -> Void)? = nil
    ) {
        self.title = title
        self.subtitle = subtitle
        self.eyebrow = eyebrow
        self.actionTitle = actionTitle
        self.action = action
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                if let eyebrow {
                    // Restraint: the eyebrow is decorative metadata, so it reads in
                    // muted ink — not twilight. Accent is reserved for the single
                    // primary action per screen.
                    Text(LocalizedStringKey(eyebrow))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(SpottColor.muted)
                        .tracking(1.6)
                        .textCase(.uppercase)
                        .padding(.bottom, 1)
                }
                Text(LocalizedStringKey(title))
                    .font(.title3.weight(.bold))
                    .lineSpacing(4)
                    .accessibilityAddTraits(.isHeader)
                if let subtitle {
                    Text(LocalizedStringKey(subtitle))
                        .font(.footnote)
                        .foregroundStyle(SpottColor.muted)
                        .lineSpacing(3)
                }
            }
            Spacer(minLength: 0)
            if let actionTitle, let action {
                Button(action: action) {
                    HStack(spacing: 3) {
                        Text(LocalizedStringKey(actionTitle))
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.bold))
                    }
                    .font(.subheadline.weight(.semibold))
                }
                .buttonStyle(.plain)
                // Restraint: a "see all" link is a secondary affordance, not the
                // screen's one accent. Neutral ink + semibold weight + chevron
                // signal tappability without adding another purple hit.
                .foregroundStyle(SpottColor.ink)
            }
        }
    }
}

struct StatTile: View {
    let value: String
    let label: String
    let symbol: String?
    let tint: Color

    // Restraint: the symbol chip defaults to muted ink. Call sites opt into a
    // semantic accent (mint/amber/coral/twilight) by passing an explicit `tint`.
    init(value: String, label: String, symbol: String? = nil, tint: Color = SpottColor.muted) {
        self.value = value
        self.label = label
        self.symbol = symbol
        self.tint = tint
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let symbol {
                Image(systemName: symbol)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(tint)
                    .frame(width: 30, height: 30)
                    .background(tint.opacity(0.14), in: Circle())
            }
            Text(value)
                .font(.system(.title2, design: .rounded, weight: .bold))
                .monospacedDigit()
                .foregroundStyle(SpottColor.ink)
            Text(LocalizedStringKey(label))
                .font(.caption)
                .foregroundStyle(SpottColor.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(
            SpottColor.surface,
            in: RoundedRectangle(cornerRadius: SpottMetric.controlRadius, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: SpottMetric.controlRadius, style: .continuous)
                .strokeBorder(SpottColor.hairline)
        )
        .shadow(color: SpottColor.shadowInk.opacity(0.05), radius: 20, y: 8)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(LocalizedStringKey(label)))
        .accessibilityValue(Text(value))
    }
}

struct AvatarStack: View {
    let names: [String]
    let maxVisible: Int

    init(names: [String], maxVisible: Int = 4) {
        self.names = names
        self.maxVisible = max(maxVisible, 1)
    }

    var body: some View {
        let visible = Array(names.prefix(maxVisible))
        let overflow = names.count - visible.count
        HStack(spacing: -8) {
            ForEach(Array(visible.enumerated()), id: \.offset) { index, name in
                AvatarInitialCircle(name: name)
                    .zIndex(Double(visible.count - index))
            }
            if overflow > 0 {
                Text(verbatim: "+\(overflow)")
                    .font(.system(.caption2, design: .rounded, weight: .bold))
                    .monospacedDigit()
                    .foregroundStyle(SpottColor.muted)
                    .frame(width: 28, height: 28)
                    .background(SpottColor.elevated, in: Circle())
                    .overlay(Circle().stroke(SpottColor.surface, lineWidth: 2))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("共 \(names.count) 位参与者"))
    }
}

private struct AvatarInitialCircle: View {
    let name: String

    var body: some View {
        Text(initial)
            .font(.caption.weight(.bold))
            .foregroundStyle(.white)
            .frame(width: 28, height: 28)
            .background(seedColor.gradient, in: Circle())
            .overlay(Circle().stroke(SpottColor.surface, lineWidth: 2))
    }

    private var initial: String {
        guard let first = name.trimmingCharacters(in: .whitespacesAndNewlines).first else {
            return "·"
        }
        return String(first).uppercased()
    }

    private var seedColor: Color {
        let palette = [
            SpottColor.twilight,
            SpottColor.coral,
            SpottColor.mint,
            SpottColor.amber,
            SpottColor.twilightDeep
        ]
        let seed = name.unicodeScalars.reduce(7) { ($0 &* 31 &+ Int($1.value)) & 0xFFFF }
        return palette[seed % palette.count]
    }
}

struct CapacityRing: View {
    let confirmed: Int
    let capacity: Int
    let size: CGFloat

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(confirmed: Int, capacity: Int, size: CGFloat = 40) {
        self.confirmed = confirmed
        self.capacity = capacity
        self.size = size
    }

    private var fraction: Double {
        guard capacity > 0 else { return 0 }
        return min(Double(confirmed) / Double(capacity), 1)
    }

    private var tint: Color {
        if fraction >= 1 {
            SpottColor.coral
        } else if fraction >= 0.8 {
            SpottColor.amber
        } else {
            SpottColor.mint
        }
    }

    @State private var hasDrawnOn = false

    private var drawnFraction: Double {
        reduceMotion || hasDrawnOn ? fraction : 0
    }

    var body: some View {
        ZStack {
            Circle()
                .stroke(SpottColor.divider, lineWidth: 4)
            Circle()
                .trim(from: 0, to: drawnFraction)
                // Restraint: the ring is a single semantic tint (mint → amber →
                // coral as it fills) with no twilight blended in. One signal, one
                // color per fill state.
                .stroke(
                    tint,
                    style: StrokeStyle(lineWidth: 4, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))
            Text(verbatim: "\(confirmed)")
                .font(.system(.caption2, design: .rounded, weight: .bold))
                .monospacedDigit()
                .minimumScaleFactor(0.6)
                .foregroundStyle(SpottColor.ink)
        }
        .frame(width: size, height: size)
        .animation(reduceMotion ? nil : SpottMotion.standard, value: fraction)
        .onAppear {
            guard !hasDrawnOn else { return }
            if reduceMotion {
                hasDrawnOn = true
            } else {
                withAnimation(.smooth(duration: 0.6).delay(0.08)) {
                    hasDrawnOn = true
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("已确认 \(confirmed) 人，容量 \(capacity) 人"))
    }
}

struct PromotedBadge: View {
    init() {}

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "sparkles")
                .font(.caption2.weight(.semibold))
            Text("推广")
                .font(.caption2.weight(.semibold))
        }
        .foregroundStyle(SpottColor.amberDeep)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        // Restraint: a status badge is not the floating control layer — a flat
        // pale fill with a hairline, no glass and no shadow. Decoration recedes.
        .background(SpottColor.amberPale, in: Capsule())
        .overlay(Capsule().strokeBorder(SpottColor.hairline))
        .accessibilityLabel(Text("推广内容"))
    }
}

struct StreakFlame: View {
    let days: Int

    init(days: Int) {
        self.days = days
    }

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "flame.fill")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(
                    LinearGradient(
                        colors: [SpottColor.amber, SpottColor.coral],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
            Text(verbatim: "\(days)")
                .font(.system(.subheadline, design: .rounded, weight: .heavy))
                .monospacedDigit()
                .foregroundStyle(SpottColor.coral)
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 6)
        // Restraint: flat pale fill + hairline, no glass and no shadow. The warm
        // flame is the only accent; the container stays quiet.
        .background(SpottColor.coralPale, in: Capsule())
        .overlay(Capsule().strokeBorder(SpottColor.hairline))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("连续签到 \(days) 天"))
    }
}

struct SpottSkeleton: ViewModifier {
    let isActive: Bool
    @State private var phase: CGFloat = -0.6
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme

    init(isActive: Bool = true) {
        self.isActive = isActive
    }

    @ViewBuilder
    func body(content: Content) -> some View {
        if isActive {
            content
                .redacted(reason: .placeholder)
                .overlay {
                    if !reduceMotion {
                        GeometryReader { proxy in
                            LinearGradient(
                                colors: [
                                    .clear,
                                    .white.opacity(colorScheme == .dark ? 0.10 : 0.28),
                                    .clear
                                ],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                            .frame(width: proxy.size.width * 0.55)
                            .offset(x: phase * proxy.size.width)
                        }
                        .mask(content.redacted(reason: .placeholder))
                        .allowsHitTesting(false)
                    }
                }
                .onAppear {
                    guard !reduceMotion else { return }
                    withAnimation(.linear(duration: 1.6).repeatForever(autoreverses: false)) {
                        phase = 1
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text("正在加载"))
        } else {
            content
        }
    }
}

extension View {
    func spottSkeleton(_ isActive: Bool = true) -> some View {
        modifier(SpottSkeleton(isActive: isActive))
    }
}

struct SpottEmptyState: View {
    let icon: String
    let title: String
    let message: String
    let actionTitle: String?
    let action: (() -> Void)?

    init(
        icon: String,
        title: String,
        message: String,
        actionTitle: String? = nil,
        action: (() -> Void)? = nil
    ) {
        self.icon = icon
        self.title = title
        self.message = message
        self.actionTitle = actionTitle
        self.action = action
    }

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: icon)
                .font(.system(size: 27, weight: .medium))
                .foregroundStyle(SpottColor.twilight)
                .frame(width: 58, height: 58)
                .glassEffect(.regular.tint(SpottColor.twilightPale.opacity(0.45)), in: Circle())
                .spottGlassFinish(in: Circle(), shadowRadius: 12, shadowY: 5)
            VStack(spacing: 6) {
                Text(LocalizedStringKey(title))
                    .font(.title3.bold())
                    .multilineTextAlignment(.center)
                    .accessibilityAddTraits(.isHeader)
                Text(LocalizedStringKey(message))
                    .font(.subheadline)
                    .foregroundStyle(SpottColor.muted)
                    .multilineTextAlignment(.center)
                    .lineSpacing(3)
            }
            if let actionTitle, let action {
                Button(action: action) {
                    Text(LocalizedStringKey(actionTitle))
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 6)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.capsule)
                .tint(SpottColor.twilight)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 220)
        .padding(24)
    }
}

#Preview("Components") {
    ScrollView {
        VStack(alignment: .leading, spacing: 24) {
            SpottSectionHeader(
                title: "本周热门",
                subtitle: "根据你的兴趣推荐",
                actionTitle: "查看全部",
                action: {}
            )
            HStack(spacing: 12) {
                StatTile(value: "128", label: "已参加活动", symbol: "calendar.badge.checkmark")
                StatTile(value: "96%", label: "出席率", symbol: "chart.line.uptrend.xyaxis", tint: SpottColor.mint)
            }
            HStack(spacing: 16) {
                AvatarStack(names: ["田中", "佐藤", "山田", "铃木", "高桥", "伊藤"])
                CapacityRing(confirmed: 17, capacity: 20)
                PromotedBadge()
                StreakFlame(days: 12)
            }
            SurfaceCard {
                VStack(alignment: .leading, spacing: 8) {
                    Text("加载中的活动标题")
                        .font(.headline)
                    Text("这里是活动的详细描述文本，用于骨架屏演示。")
                        .font(.subheadline)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .spottSkeleton()
            SpottEmptyState(
                icon: "calendar.badge.plus",
                title: "还没有活动",
                message: "发布你的第一个活动，让附近的人找到你。",
                actionTitle: "创建活动",
                action: {}
            )
        }
        .padding(SpottMetric.pageInset)
    }
    .background(SpottScreenBackground())
}

#Preview("Components · dark") {
    VStack(spacing: 20) {
        HStack(spacing: 16) {
            CapacityRing(confirmed: 20, capacity: 20)
            PromotedBadge()
            StreakFlame(days: 3)
        }
        SpottEmptyState(
            icon: "wifi.slash",
            title: "暂时离线",
            message: "网络恢复后会自动刷新。"
        )
    }
    .padding(SpottMetric.pageInset)
    .background(SpottScreenBackground())
    .preferredColorScheme(.dark)
}
