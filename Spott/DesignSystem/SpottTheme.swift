import SwiftUI
import UIKit

enum SpottColor {
    // Keep these values in lockstep with packages/design-tokens/src/tokens.json.
    static let canvas = adaptive(light: 0xF7F5F0, dark: 0x0E1014)
    static let surface = adaptive(light: 0xFFFFFF, dark: 0x171A20)
    static let elevated = adaptive(light: 0xFFFFFF, dark: 0x20242C)
    static let ink = adaptive(light: 0x17181C, dark: 0xF7F6F2)
    static let muted = adaptive(light: 0x6F737C, dark: 0xA7ACB7)
    static let twilight = adaptive(light: 0x6E5BE7, dark: 0x9B8CFF)
    static let twilightDeep = adaptive(light: 0x4F3FBD, dark: 0x7564E8)
    static let twilightPale = adaptive(light: 0xEBE7FF, dark: 0x2A2646)
    static let coral = adaptive(light: 0xFF745F, dark: 0xFF866F)
    static let coralPale = adaptive(light: 0xFFE6DF, dark: 0x422823)
    static let mint = adaptive(light: 0x3DBD91, dark: 0x51D4A5)
    static let amber = adaptive(light: 0xD99A2B, dark: 0xF0B84F)
    static let amberDeep = adaptive(light: 0x9A6A12, dark: 0xF6CB74)
    static let amberPale = adaptive(light: 0xFBEED4, dark: 0x3C3120)
    static let danger = adaptive(light: 0xD84B5B, dark: 0xFF6B79)
    static let divider = adaptive(light: 0xE6E2DA, dark: 0x2B3038)
    static let hairline = adaptive(
        light: 0xFFFFFF,
        dark: 0xFFFFFF,
        lightAlpha: 0.72,
        darkAlpha: 0.12
    )
    /// Shadow color that stays dark in both schemes (ink flips to near-white in
    /// dark mode, which would turn drop shadows into glows).
    static let shadowInk = adaptive(
        light: 0x17181C,
        dark: 0x000000
    )

    private static func adaptive(
        light: UInt32,
        dark: UInt32,
        lightAlpha: CGFloat = 1,
        darkAlpha: CGFloat = 1
    ) -> Color {
        Color(uiColor: UIColor { traits in
            if traits.userInterfaceStyle == .dark {
                return uiColor(rgb: dark, alpha: darkAlpha)
            }
            return uiColor(rgb: light, alpha: lightAlpha)
        })
    }

    private static func uiColor(rgb: UInt32, alpha: CGFloat) -> UIColor {
        UIColor(
            red: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: alpha
        )
    }
}

enum SpottMetric {
    // Radii follow the design-token scale 12/18/24/28.
    static let controlRadius: CGFloat = 18
    static let cardRadius: CGFloat = 24
    static let coverRadius: CGFloat = 28
    static let panelRadius: CGFloat = 28
    static let pageInset: CGFloat = 20
}

enum SpottGlassMetrics {
    static let defaultInteractive = false
}

/// - Warning: **Deprecated.** Use `spottProminentActionStyle()` — the canonical
///   primary action — instead of `.buttonStyle(PrimaryButtonStyle())`. This type
///   survives only as a thin compatibility shim so any not-yet-converted call
///   site still renders the native iOS 26 Liquid Glass prominent look (a twilight
///   glass fill, not the old hand-drawn gradient capsule). Conversion agents are
///   removing the remaining call sites; do not add new ones.
struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 50)
            .foregroundStyle(.white)
            .glassEffect(
                .regular.tint(isEnabled ? SpottColor.twilight : nil),
                in: RoundedRectangle(cornerRadius: SpottMetric.controlRadius, style: .continuous)
            )
            .opacity(isEnabled ? 1 : 0.55)
            .scaleEffect(!reduceMotion && configuration.isPressed ? 0.975 : 1)
            .animation(reduceMotion ? nil : .snappy(duration: 0.16), value: configuration.isPressed)
    }
}

struct SurfaceCard<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        content
            .padding(18)
            .background(SpottColor.surface)
            .clipShape(RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous)
                    .strokeBorder(SpottColor.hairline)
            )
            .shadow(color: SpottColor.shadowInk.opacity(0.05), radius: 20, y: 8)
    }
}

extension View {
    func spottGlassPanel<S: InsettableShape>(
        shape: S,
        tint: Color? = nil,
        interactive: Bool = SpottGlassMetrics.defaultInteractive
    ) -> some View {
        glassEffect(.regular.tint(tint).interactive(interactive), in: shape)
            .spottGlassFinish(in: shape)
    }

    /// THE canonical primary action: a native iOS 26 `.glassProminent` button
    /// tinted twilight, clipped to the control-radius rounded rectangle. Use for
    /// the single most important action on a screen (submit, register, create).
    /// Twilight lives here only as a tint — never as a hand-drawn gradient.
    func spottProminentActionStyle() -> some View {
        buttonStyle(.glassProminent)
            .buttonBorderShape(.roundedRectangle(radius: SpottMetric.controlRadius))
            .tint(SpottColor.twilight)
    }

    /// Canonical secondary full-width action: a native iOS 26 `.glass` button on
    /// the same control-radius rounded rectangle, left untinted so it reads as
    /// neutral glass. Use for the lower-priority sibling of a prominent action
    /// (Cancel, Skip, Maybe later) — preserving one accent per screen.
    func spottGlassActionStyle() -> some View {
        buttonStyle(.glass)
            .buttonBorderShape(.roundedRectangle(radius: SpottMetric.controlRadius))
    }
}

struct SpottStateCard: View {
    let icon: String
    let title: String
    let message: String
    var actionTitle: String?
    let action: () -> Void

    var body: some View {
        VStack(spacing: 15) {
            Image(systemName: icon)
                .font(.system(size: 26, weight: .medium))
                .foregroundStyle(SpottColor.twilight)
                .frame(width: 54, height: 54)
                .background(SpottColor.twilight.opacity(0.10), in: Circle())
                .overlay(Circle().strokeBorder(SpottColor.hairline))
            VStack(spacing: 6) {
                Text(LocalizedStringKey(title))
                    .font(.title3.bold())
                    .multilineTextAlignment(.center)
                Text(LocalizedStringKey(message))
                    .font(.subheadline)
                    .foregroundStyle(SpottColor.muted)
                    .multilineTextAlignment(.center)
                    .lineSpacing(3)
            }
            if let actionTitle {
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
        .padding(22)
        .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous)
                .strokeBorder(SpottColor.hairline)
        )
        .shadow(color: SpottColor.shadowInk.opacity(0.05), radius: 20, y: 8)
    }
}

struct SyncBanner: View {
    let banner: SyncBannerState
    var body: some View {
        Label {
            Text(LocalizedStringKey(banner.title))
        } icon: {
            Image(systemName: icon)
        }
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(.regularMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(SpottColor.hairline))
            .shadow(color: SpottColor.shadowInk.opacity(0.08), radius: 10, y: 4)
            .accessibilityLabel(Text(LocalizedStringKey(banner.title)))
    }
    private var icon: String {
        switch banner.tone { case .syncing: "arrow.triangle.2.circlepath"; case .offline: "wifi.slash"; case .success: "checkmark.circle.fill"; case .warning: "exclamationmark.triangle.fill" }
    }
}
