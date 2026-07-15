import SwiftUI

struct DiscoveryEventCover: View {
    let event: EventSummary

    var body: some View {
        Group {
            if let url = event.coverURL {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        DiscoveryCoverFallback(category: event.category)
                    }
                }
            } else {
                DiscoveryCoverFallback(category: event.category)
            }
        }
        .clipped()
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityHidden(true)
    }
}

private struct DiscoveryCoverFallback: View {
    let category: String

    var body: some View {
        ZStack {
            Color(uiColor: .secondarySystemBackground)
            Image(systemName: symbol)
                .font(.system(size: 30, weight: .medium))
                .foregroundStyle(SpottColor.twilight)
        }
    }

    private var symbol: String {
        switch category {
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
