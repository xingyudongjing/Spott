import ImageIO
import SwiftUI
import UIKit

/// Off-main-thread cover loader (红线7): downloads once through URLCache-backed
/// URLSession, then decodes a thumbnail sized to the rendered slot via ImageIO
/// (`CGImageSourceCreateThumbnailAtIndex`) so full-resolution server images
/// never decode on the main render path during scroll. Results are cached by
/// URL + pixel size in an `NSCache`.
final class SpottCoverImageLoader: @unchecked Sendable {
    static let shared = SpottCoverImageLoader()

    private let cache: NSCache<NSString, UIImage>
    private let session: URLSession

    init() {
        cache = NSCache()
        cache.countLimit = 160
        let configuration = URLSessionConfiguration.default
        configuration.urlCache = URLCache(
            memoryCapacity: 24 * 1024 * 1024,
            diskCapacity: 128 * 1024 * 1024
        )
        configuration.requestCachePolicy = .returnCacheDataElseLoad
        session = URLSession(configuration: configuration)
    }

    func cachedImage(url: URL, pixelSize: CGFloat) -> UIImage? {
        cache.object(forKey: key(url: url, pixelSize: pixelSize))
    }

    func image(url: URL, pixelSize: CGFloat) async throws -> UIImage {
        let cacheKey = key(url: url, pixelSize: pixelSize)
        if let hit = cache.object(forKey: cacheKey) { return hit }
        let (data, _) = try await session.data(from: url)
        try Task.checkCancellation()
        let decoded = try await Task.detached(priority: .userInitiated) {
            try Self.downsample(data: data, maxPixelSize: pixelSize)
        }.value
        cache.setObject(decoded, forKey: cacheKey)
        return decoded
    }

    private func key(url: URL, pixelSize: CGFloat) -> NSString {
        "\(url.absoluteString)#\(Int(pixelSize))" as NSString
    }

    private static func downsample(data: Data, maxPixelSize: CGFloat) throws -> UIImage {
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else {
            throw URLError(.cannotDecodeContentData)
        }
        let thumbnailOptions = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(64, maxPixelSize),
        ] as CFDictionary
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions) else {
            throw URLError(.cannotDecodeContentData)
        }
        return UIImage(cgImage: cgImage)
    }
}

struct EventCoverView: View {
    let url: URL?
    let category: String
    let cornerRadius: CGFloat

    init(url: URL?, category: String, cornerRadius: CGFloat = SpottMetric.coverRadius) {
        self.url = url
        self.category = category
        self.cornerRadius = cornerRadius
    }

    var body: some View {
        Color.clear
            .overlay {
                if let url {
                    DownsampledCoverImage(url: url, category: category)
                } else {
                    EventCoverPlaceholder(category: category)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .accessibilityHidden(true)
    }
}

private struct DownsampledCoverImage: View {
    let url: URL
    let category: String

    @Environment(\.displayScale) private var displayScale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var image: UIImage?
    @State private var didFail = false

    var body: some View {
        GeometryReader { proxy in
            let pixelSize = targetPixelSize(for: proxy.size)
            ZStack {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .frame(width: proxy.size.width, height: proxy.size.height)
                        .clipped()
                        .transition(.opacity)
                } else {
                    EventCoverPlaceholder(category: category)
                        .frame(width: proxy.size.width, height: proxy.size.height)
                }
            }
            .animation(
                reduceMotion || image == nil ? nil : .easeOut(duration: 0.36),
                value: image != nil
            )
            .task(id: "\(url.absoluteString)#\(Int(pixelSize))") {
                await load(pixelSize: pixelSize)
            }
        }
    }

    private func targetPixelSize(for size: CGSize) -> CGFloat {
        let points = max(size.width, size.height)
        guard points > 0 else { return 640 }
        return (points * displayScale).rounded(.up)
    }

    private func load(pixelSize: CGFloat) async {
        if let hit = SpottCoverImageLoader.shared.cachedImage(url: url, pixelSize: pixelSize) {
            // Cache hits render synchronously with no fade.
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { image = hit }
            return
        }
        do {
            let loaded = try await SpottCoverImageLoader.shared.image(url: url, pixelSize: pixelSize)
            guard !Task.isCancelled else { return }
            image = loaded
        } catch {
            guard !Task.isCancelled else { return }
            didFail = true
        }
    }
}

struct EventCoverPlaceholder: View {
    let category: String

    init(category: String) {
        self.category = category
    }

    var body: some View {
        let style = EventCoverStyle.style(for: category)
        ZStack {
            LinearGradient(
                colors: style.gradient,
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            Image(systemName: style.symbol)
                .font(.system(size: 74, weight: .medium))
                .foregroundStyle(.white.opacity(0.15))
                .rotationEffect(.degrees(-10))
                .offset(x: 30, y: 22)
            Image(systemName: style.symbol)
                .font(.system(size: 29, weight: .semibold))
                .foregroundStyle(.white.opacity(0.92))
        }
        .clipped()
    }
}

enum EventCoverStyle {
    struct Style {
        let symbol: String
        let gradient: [Color]
    }

    static func style(for category: String) -> Style {
        switch category {
        case "family":
            Style(symbol: "figure.and.child.holdinghands", gradient: [rgb(0xF2A0B5), rgb(0xC9679E)])
        case "outdoor":
            Style(symbol: "mountain.2", gradient: [rgb(0x6DC492), rgb(0x2E7D5B)])
        case "sports":
            Style(symbol: "figure.run", gradient: [rgb(0x6FB6EF), rgb(0x3167C7)])
        case "city-walk", "walk":
            Style(symbol: "building.2", gradient: [rgb(0x8B7BEB), rgb(0x5646C4)])
        case "food":
            Style(symbol: "fork.knife", gradient: [rgb(0xF4A261), rgb(0xD1495B)])
        case "art-culture", "art":
            Style(symbol: "paintpalette", gradient: [rgb(0xC084FC), rgb(0x7C3AED)])
        case "skill", "learning":
            Style(symbol: "graduationcap", gradient: [rgb(0x5EEAD4), rgb(0x0D9488)])
        case "career", "networking":
            Style(symbol: "briefcase", gradient: [rgb(0x9BA8C4), rgb(0x4B5A75)])
        case "music":
            Style(symbol: "music.note", gradient: [rgb(0xF472B6), rgb(0x9333EA)])
        case "games":
            Style(symbol: "gamecontroller", gradient: [rgb(0x818CF8), rgb(0x4F46E5)])
        default:
            Style(symbol: "calendar", gradient: [rgb(0x9B8CFF), rgb(0x4F3FBD)])
        }
    }

    private static func rgb(_ value: UInt32) -> Color {
        Color(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}

#Preview("Cover placeholders") {
    ScrollView {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 14) {
            ForEach(
                ["family", "outdoor", "sports", "city-walk", "food", "art-culture", "skill", "career", "music", "unknown"],
                id: \.self
            ) { slug in
                VStack(spacing: 6) {
                    EventCoverView(url: nil, category: slug, cornerRadius: 18)
                        .frame(height: 110)
                    Text(slug)
                        .font(.caption2)
                        .foregroundStyle(SpottColor.muted)
                }
            }
        }
        .padding(SpottMetric.pageInset)
    }
    .background(SpottScreenBackground())
}

#Preview("Cover · dark") {
    EventCoverView(url: nil, category: "music")
        .frame(width: 320, height: 180)
        .padding()
        .background(SpottScreenBackground())
        .preferredColorScheme(.dark)
}
