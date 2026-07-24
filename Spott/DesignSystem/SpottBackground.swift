import SwiftUI

struct SpottScreenBackground: View {
    @Environment(\.colorScheme) private var colorScheme

    init() {}

    var body: some View {
        ZStack {
            SpottColor.canvas
            // Restraint mandate: the glow is barely-there — felt, not seen. Just
            // enough warmth that the canvas never reads as one flat grey sheet and
            // the glass control layer has faint light to refract. Never a visible
            // purple wash.
            RadialGradient(
                colors: [
                    SpottColor.twilight.opacity(colorScheme == .dark ? 0.11 : 0.06),
                    .clear
                ],
                center: UnitPoint(x: 0.12, y: 0.0),
                startRadius: 0,
                endRadius: 560
            )
            // Counterweight coral ember bottom-trailing — a whisper.
            RadialGradient(
                colors: [
                    SpottColor.coral.opacity(colorScheme == .dark ? 0.07 : 0.04),
                    .clear
                ],
                center: UnitPoint(x: 0.94, y: 1.0),
                startRadius: 0,
                endRadius: 460
            )
            // Faint mint whisper mid-trailing keeps large light-mode fields from
            // reading as one grey sheet.
            RadialGradient(
                colors: [
                    SpottColor.mint.opacity(colorScheme == .dark ? 0.045 : 0.03),
                    .clear
                ],
                center: UnitPoint(x: 1.05, y: 0.32),
                startRadius: 0,
                endRadius: 380
            )
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

#Preview("Screen background") {
    ZStack {
        SpottScreenBackground()
        VStack(spacing: 16) {
            Text("Tokyo Afterglow")
                .font(.title2.bold())
            GlassPill(text: "玻璃有了可折射的微光", systemImage: "sparkles", tint: SpottColor.twilight)
        }
    }
}

#Preview("Screen background · dark") {
    ZStack {
        SpottScreenBackground()
        GlassPill(text: "暗色模式", systemImage: "moon.fill", tint: SpottColor.twilight)
    }
    .preferredColorScheme(.dark)
}
