import SwiftUI

struct DiscoveryEventCover: View {
    let event: EventSummary
    var cornerRadius: CGFloat = 14

    var body: some View {
        Group {
            if let url = event.coverURL {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        DiscoveryCoverFallback(event: event)
                    }
                }
            } else {
                DiscoveryCoverFallback(event: event)
            }
        }
        .clipped()
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .accessibilityHidden(true)
    }
}

private struct DiscoveryCoverFallback: View {
    let event: EventSummary

    var body: some View {
        ZStack {
            LinearGradient(colors: palette, startPoint: .topLeading, endPoint: .bottomTrailing)
            Circle()
                .fill(.white.opacity(0.24))
                .frame(width: 170, height: 170)
                .offset(x: 92, y: -58)
            Circle()
                .stroke(.white.opacity(0.42), lineWidth: 1)
                .frame(width: 118, height: 118)
                .offset(x: 120, y: -82)
            Image(systemName: symbol)
                .font(.system(size: 44, weight: .medium))
                .foregroundStyle(SpottColor.ink.opacity(0.72))
        }
    }

    private var palette: [Color] {
        switch event.category {
        case "outdoor", "sports": [SpottColor.mint.opacity(0.42), SpottColor.twilightPale]
        case "food": [SpottColor.coralPale, SpottColor.amber.opacity(0.42)]
        case "art", "music": [SpottColor.twilightPale, SpottColor.coral.opacity(0.28)]
        case "family": [SpottColor.coralPale, SpottColor.mint.opacity(0.3)]
        default: [SpottColor.twilightPale, SpottColor.coralPale]
        }
    }

    private var symbol: String {
        switch event.category {
        case "music": "waveform"
        case "outdoor": "mountain.2"
        case "sports": "figure.run"
        case "food": "fork.knife"
        case "art": "paintpalette"
        case "family": "figure.and.child.holdinghands"
        case "city-walk", "walk": "building.2"
        default: "calendar"
        }
    }
}
