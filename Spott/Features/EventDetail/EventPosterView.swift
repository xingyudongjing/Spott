import SwiftUI
import UIKit

struct EventShareItem: Identifiable {
    let id = UUID()
    let url: URL
}

struct ShareActivityView: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) { }
}

struct PosterGeneratorView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var displayLocale
    let resourceType: String
    let resourceID: UUID
    let title: String
    @State private var template = "tokyo_afterglow"
    @State private var job: PosterJob?
    @State private var busy = false
    @State private var shareItem: EventShareItem?
    @State private var error: UserFacingError?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(text("eventdetail.poster.headline"))
                        .font(.system(size: 28, weight: .bold, design: .rounded))
                    Text(title)
                        .font(.subheadline)
                        .foregroundStyle(SpottColor.muted)
                }

                if let url = job?.url, job?.state == "ready" {
                    AsyncImage(url: url) { image in
                        image.resizable().scaledToFit()
                    } placeholder: {
                        ProgressView().frame(maxWidth: .infinity, minHeight: 360)
                    }
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 26).stroke(SpottColor.divider))

                    Button {
                        shareItem = .init(url: url)
                    } label: {
                        Label(text("eventdetail.poster.share"), systemImage: "square.and.arrow.up")
                            .frame(maxWidth: .infinity, minHeight: 50)
                    }
                    .spottProminentActionStyle()
                } else {
                    Picker(text("eventdetail.poster.style"), selection: $template) {
                        Text(text("eventdetail.poster.template.tokyo_afterglow")).tag("tokyo_afterglow")
                        Text(text("eventdetail.poster.template.night_transit")).tag("night_transit")
                        Text(text("eventdetail.poster.template.paper_lantern")).tag("paper_lantern")
                    }
                    .pickerStyle(.segmented)

                    VStack(spacing: 14) {
                        Image(systemName: busy ? "wand.and.sparkles" : "rectangle.portrait.on.rectangle.portrait")
                            .font(.system(size: 42, weight: .light))
                            .foregroundStyle(SpottColor.twilight)
                        Text(posterStatus)
                            .font(.headline)
                        if busy { ProgressView() }
                    }
                    .frame(maxWidth: .infinity, minHeight: 260)
                    .spottGlassPanel(shape: RoundedRectangle(cornerRadius: 26, style: .continuous), interactive: false)

                    Button {
                        create()
                    } label: {
                        Text(text("eventdetail.poster.generate"))
                            .frame(maxWidth: .infinity, minHeight: 50)
                    }
                    .spottProminentActionStyle()
                    .disabled(busy)
                }

                if let error {
                    Label(
                        EventDetailExtrasLocalization.format(
                            "eventdetail.poster.error_format",
                            locale: displayLocale,
                            error.message,
                            error.id
                        ),
                        systemImage: "exclamationmark.triangle.fill"
                    )
                    .font(.caption)
                    .foregroundStyle(SpottColor.danger)
                }
                Text(text("eventdetail.poster.privacy"))
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
            }
            .padding(SpottMetric.pageInset)
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .navigationTitle(text("eventdetail.poster.title"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(text("eventdetail.poster.close")) { dismiss() }
            }
        }
        .sheet(item: $shareItem) { item in
            ShareActivityView(items: [item.url])
                .presentationDetents([.medium])
        }
        .task(id: resourceID) {
            await recoverApprovedPoster()
        }
    }

    private var posterStatus: String {
        switch job?.state {
        case "queued": text("eventdetail.poster.status.queued")
        case "processing": text("eventdetail.poster.status.processing")
        case "failed": text("eventdetail.poster.status.failed")
        default: text("eventdetail.poster.status.idle")
        }
    }

    private var locale: String {
        let language = Locale.preferredLanguages.first?.lowercased() ?? "en"
        if language.hasPrefix("zh") { return "zh-Hans" }
        if language.hasPrefix("ja") { return "ja" }
        return "en"
    }

    private func text(_ key: String.LocalizationValue) -> String {
        EventDetailExtrasLocalization.text(key, locale: displayLocale)
    }

    private func create() {
        busy = true
        error = nil
        Task { @MainActor in
            defer { busy = false }
            do {
                let receipt = try await model.api.createPoster(
                    resourceType: resourceType,
                    resourceID: resourceID,
                    template: template,
                    locale: locale
                )
                try await poll(jobID: receipt.id)
            } catch is CancellationError {
                return
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }

    @MainActor
    private func recoverApprovedPoster() async {
        guard resourceType == "event", job == nil else { return }
        do {
            let current = try await model.api.eventPoster(eventID: resourceID)
            job = current
            if current.state == "queued" || current.state == "processing" {
                busy = true
                defer { busy = false }
                try await poll(jobID: current.id)
            }
        } catch let apiError as APIError where apiError.status == 404 {
            // An approved poster is optional until the event has passed moderation.
        } catch is CancellationError {
            return
        } catch {
            self.error = AppModel.map(error)
        }
    }

    @MainActor
    private func poll(jobID: UUID) async throws {
        for attempt in 0..<20 {
            let current = try await model.api.poster(jobID: jobID)
            job = current
            if current.state == "ready" || current.state == "failed" { return }
            if attempt < 19 { try await Task.sleep(for: .seconds(1)) }
        }
    }
}
