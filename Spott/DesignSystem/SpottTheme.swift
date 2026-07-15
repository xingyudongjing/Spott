import SwiftUI

enum SpottColor {
    static let canvas = Color(red: 0.985, green: 0.982, blue: 0.974)
    static let surface = Color.white
    static let elevated = Color.white
    static let ink = Color(red: 0.075, green: 0.071, blue: 0.092)
    static let muted = Color(red: 0.39, green: 0.39, blue: 0.43)
    static let twilight = Color(red: 0.38, green: 0.30, blue: 0.87)
    static let twilightDeep = Color(red: 0.24, green: 0.18, blue: 0.64)
    static let twilightPale = Color(red: 0.92, green: 0.90, blue: 1.0)
    static let coral = Color(red: 0.98, green: 0.38, blue: 0.31)
    static let coralPale = Color(red: 1.0, green: 0.90, blue: 0.87)
    static let mint = Color(red: 0.10, green: 0.64, blue: 0.48)
    static let amber = Color(red: 0.78, green: 0.52, blue: 0.10)
    static let danger = Color(red: 0.85, green: 0.29, blue: 0.36)
    static let divider = Color(red: 0.13, green: 0.12, blue: 0.16).opacity(0.09)
    static let hairline = Color.white.opacity(0.72)
}

enum SpottMetric {
    static let controlRadius: CGFloat = 16
    static let cardRadius: CGFloat = 22
    static let coverRadius: CGFloat = 28
    static let panelRadius: CGFloat = 32
    static let pageInset: CGFloat = 20
}

enum SpottGlassMetrics {
    static let defaultInteractive = false
}

struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .semibold, design: .rounded))
            .frame(maxWidth: .infinity, minHeight: 56)
            .foregroundStyle(.white)
            .background {
                if isEnabled {
                    LinearGradient(
                        colors: [SpottColor.twilight, SpottColor.twilightDeep],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                } else {
                    Color.secondary.opacity(0.28)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: SpottMetric.controlRadius, style: .continuous))
            .shadow(color: isEnabled ? SpottColor.twilight.opacity(0.22) : .clear, radius: 14, y: 7)
            .scaleEffect(configuration.isPressed ? 0.975 : 1)
            .animation(.snappy(duration: 0.16), value: configuration.isPressed)
    }
}

struct SurfaceCard<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        content
            .padding(18)
            .background(SpottColor.surface)
            .clipShape(RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: SpottMetric.cardRadius).stroke(SpottColor.hairline))
            .shadow(color: SpottColor.ink.opacity(0.055), radius: 20, y: 8)
    }
}

extension View {
    @ViewBuilder
    func spottGlassPanel<S: Shape>(
        shape: S,
        tint: Color? = nil,
        interactive: Bool = SpottGlassMetrics.defaultInteractive
    ) -> some View {
        if #available(iOS 26.0, *) {
            self
                .glassEffect(.regular.tint(tint).interactive(interactive), in: shape)
        } else {
            self
                .background(tint?.opacity(0.82) ?? .clear, in: shape)
                .background(.regularMaterial, in: shape)
        }
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
                .foregroundStyle(SpottColor.muted)
                .frame(width: 54, height: 54)
                .background(Color.black.opacity(0.045), in: Circle())
            VStack(spacing: 6) {
                Text(LocalizedStringKey(title))
                    .font(.system(size: 18, weight: .bold, design: .rounded))
                    .multilineTextAlignment(.center)
                Text(LocalizedStringKey(message))
                    .font(.system(size: 13.5, design: .rounded))
                    .foregroundStyle(SpottColor.muted)
                    .multilineTextAlignment(.center)
                    .lineSpacing(3)
            }
            if let actionTitle {
                Button(action: action) {
                    Text(LocalizedStringKey(actionTitle))
                }
                    .font(.system(size: 13.5, weight: .semibold, design: .rounded))
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 220)
        .padding(22)
        .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: SpottMetric.cardRadius).stroke(SpottColor.divider))
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
            .overlay(Capsule().stroke(SpottColor.divider))
            .accessibilityLabel(Text(LocalizedStringKey(banner.title)))
    }
    private var icon: String {
        switch banner.tone { case .syncing: "arrow.triangle.2.circlepath"; case .offline: "wifi.slash"; case .success: "checkmark.circle.fill"; case .warning: "exclamationmark.triangle.fill" }
    }
}
