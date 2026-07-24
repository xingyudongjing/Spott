import SwiftUI

/// Spott Liquid Glass kit.
///
/// HIG discipline — glass is for the CONTROL layer only: filter chips, floating
/// buttons, bars, pills, and badges that hover above content. Content itself
/// (event cards, lists, long text) stays on solid or material surfaces such as
/// `SurfaceCard`, so the glass always has real content underneath to refract.
/// Never wrap scrolling content in glass, and never stack glass on glass —
/// adjacent glass shapes belong inside a single `SpottGlassGroup` so they can
/// merge fluidly instead of layering.
///
/// Every glass control carries the same "real glass" finish (beauty bar item 2):
/// a hairline top-light stroke that catches light along the upper edge, and a
/// soft ink shadow that lifts it off the canvas.

/// Hairline top-light + soft lift shadow shared by all glass controls.
private struct SpottGlassFinish<S: InsettableShape>: ViewModifier {
    let shape: S
    /// Shadow tint override (e.g. twilight for selected chips); nil = neutral ink.
    let shadowTint: Color?
    var shadowRadius: CGFloat = 10
    var shadowY: CGFloat = 4

    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        content
            .overlay {
                shape
                    .strokeBorder(
                        LinearGradient(
                            colors: [
                                // Light catches the top edge…
                                Color.white.opacity(colorScheme == .dark ? 0.30 : 0.85),
                                // …and the bottom edge falls into shade.
                                colorScheme == .dark
                                    ? Color.white.opacity(0.03)
                                    : Color.black.opacity(0.05)
                            ],
                            startPoint: .top,
                            endPoint: .bottom
                        ),
                        lineWidth: 1
                    )
                    .allowsHitTesting(false)
            }
            .shadow(
                color: shadowTint?.opacity(0.32)
                    ?? SpottColor.shadowInk.opacity(colorScheme == .dark ? 0.30 : 0.10),
                radius: shadowRadius,
                y: shadowY
            )
    }
}

extension View {
    func spottGlassFinish<S: InsettableShape>(
        in shape: S,
        shadowTint: Color? = nil,
        shadowRadius: CGFloat = 10,
        shadowY: CGFloat = 4
    ) -> some View {
        modifier(SpottGlassFinish(
            shape: shape,
            shadowTint: shadowTint,
            shadowRadius: shadowRadius,
            shadowY: shadowY
        ))
    }
}

struct GlassChip: View {
    let title: String
    let systemImage: String?
    let isSelected: Bool
    let tint: Color
    let action: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(
        title: String,
        systemImage: String? = nil,
        isSelected: Bool = false,
        tint: Color = SpottColor.twilight,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.systemImage = systemImage
        self.isSelected = isSelected
        self.tint = tint
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            // The visual capsule stays compact (~36pt) while the tappable area
            // expands to the 44pt minimum via the outer frame + contentShape.
            HStack(spacing: 6) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.footnote.weight(.semibold))
                }
                Text(LocalizedStringKey(title))
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .foregroundStyle(isSelected ? Color.white : SpottColor.ink)
            .glassEffect(
                isSelected ? .regular.tint(tint).interactive() : .regular.interactive(),
                in: Capsule()
            )
            .spottGlassFinish(in: Capsule(), shadowTint: isSelected ? tint : nil)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .animation(reduceMotion ? nil : SpottMotion.quick, value: isSelected)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

struct GlassIconButton: View {
    let systemImage: String
    let accessibilityLabel: String
    let tint: Color?
    let action: () -> Void

    init(
        systemImage: String,
        accessibilityLabel: String,
        tint: Color? = nil,
        action: @escaping () -> Void
    ) {
        self.systemImage = systemImage
        self.accessibilityLabel = accessibilityLabel
        self.tint = tint
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.body.weight(.semibold))
                .foregroundStyle(tint ?? SpottColor.ink)
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: Circle())
        .spottGlassFinish(in: Circle())
        .accessibilityLabel(Text(LocalizedStringKey(accessibilityLabel)))
    }
}

struct GlassPill: View {
    let text: String
    let systemImage: String?
    let tint: Color?

    init(text: String, systemImage: String? = nil, tint: Color? = nil) {
        self.text = text
        self.systemImage = systemImage
        self.tint = tint
    }

    var body: some View {
        HStack(spacing: 5) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.caption2.weight(.semibold))
            }
            Text(LocalizedStringKey(text))
                .font(.caption.weight(.semibold))
                .lineLimit(1)
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 6)
        .foregroundStyle(tint ?? SpottColor.ink)
        .glassEffect(.regular.tint(tint?.opacity(0.14)), in: Capsule())
        .spottGlassFinish(in: Capsule(), shadowRadius: 6, shadowY: 2)
    }
}

struct SpottGlassGroup<Content: View>: View {
    let spacing: CGFloat
    let content: Content

    init(spacing: CGFloat = 12, @ViewBuilder content: () -> Content) {
        self.spacing = spacing
        self.content = content()
    }

    var body: some View {
        GlassEffectContainer(spacing: spacing) {
            content
        }
    }
}

extension View {
    func glassCard<S: InsettableShape>(
        in shape: S = RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous)
    ) -> some View {
        self
            .padding(16)
            .glassEffect(.regular, in: shape)
            .spottGlassFinish(in: shape, shadowRadius: 16, shadowY: 6)
    }
}

#Preview("Glass kit") {
    ZStack {
        SpottScreenBackground()
        VStack(alignment: .leading, spacing: 24) {
            SpottGlassGroup {
                HStack(spacing: 10) {
                    GlassChip(title: "全部", isSelected: true) {}
                    GlassChip(title: "户外", systemImage: "mountain.2") {}
                    GlassChip(title: "美食", systemImage: "fork.knife") {}
                }
            }
            SpottGlassGroup {
                HStack(spacing: 12) {
                    GlassIconButton(systemImage: "heart", accessibilityLabel: "收藏") {}
                    GlassIconButton(systemImage: "square.and.arrow.up", accessibilityLabel: "分享", tint: SpottColor.twilight) {}
                }
            }
            HStack(spacing: 10) {
                GlassPill(text: "报名中", systemImage: "checkmark.circle.fill", tint: SpottColor.mint)
                GlassPill(text: "候补", tint: SpottColor.amber)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("周末城市漫步")
                    .font(.headline)
                Text("周六 14:00 · 代代木公园")
                    .font(.subheadline)
                    .foregroundStyle(SpottColor.muted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassCard()
        }
        .padding(SpottMetric.pageInset)
    }
}

#Preview("Glass kit · dark") {
    ZStack {
        SpottScreenBackground()
        SpottGlassGroup {
            HStack(spacing: 10) {
                GlassChip(title: "全部", isSelected: true) {}
                GlassChip(title: "音乐", systemImage: "music.note") {}
            }
        }
    }
    .preferredColorScheme(.dark)
}
