import SwiftUI

struct DiscoveryEventCover: View {
    let event: EventSummary

    var body: some View {
        // Shares the downsampling EventCoverView pipeline (红线7): thumbnails are
        // decoded off-main at the rendered slot size instead of full resolution.
        EventCoverView(url: event.coverURL, category: event.category, cornerRadius: 14)
            .clipped()
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityHidden(true)
    }
}
