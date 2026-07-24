import MapKit
import SwiftUI

struct DiscoveryMap: View {
    @Environment(\.locale) private var locale
    let store: DiscoveryStore
    let locationAuthorized: Bool
    @Binding var selectedEventID: UUID?
    @Binding var showsResults: Bool
    let openEvent: (EventSummary) -> Void
    @State private var cameraPosition: MapCameraPosition

    init(
        store: DiscoveryStore,
        locationAuthorized: Bool,
        selectedEventID: Binding<UUID?>,
        showsResults: Binding<Bool>,
        openEvent: @escaping (EventSummary) -> Void
    ) {
        self.store = store
        self.locationAuthorized = locationAuthorized
        _selectedEventID = selectedEventID
        _showsResults = showsResults
        self.openEvent = openEvent
        _cameraPosition = State(initialValue: .fitting(store.mapEvents))
    }

    private var selectedEvent: EventSummary? {
        guard let selectedEventID else { return nil }
        return store.mapEvents.first { $0.id == selectedEventID }
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            Map(position: $cameraPosition, selection: $selectedEventID) {
                if locationAuthorized {
                    UserAnnotation()
                }
                ForEach(store.mapEvents) { event in
                    DiscoveryMapMarker(event: event, locale: locale)
                }
            }
            .mapStyle(.standard)
            .mapControls {
                if locationAuthorized {
                    MapUserLocationButton()
                }
                MapCompass()
                MapScaleView()
            }
            .onMapCameraChange(frequency: .onEnd, cameraSettled)
            .onChange(of: store.mapCameraRevision, cameraRefitRequested)
            .accessibilityLabel(Text(verbatim: DiscoveryHomeLocalization.text(
                "discovery.map.a11y.label", locale: locale
            )))
            .accessibilityHint(Text(verbatim: DiscoveryHomeLocalization.text(
                "discovery.map.a11y.hint", locale: locale
            )))
            .accessibilityIdentifier("discovery.map")

            if store.mapEvents.isEmpty {
                NoMapLocationsView()
                    .frame(maxHeight: .infinity, alignment: .center)
            }

            VStack(spacing: 12) {
                if let selectedEvent {
                    DiscoveryMapMiniCard(event: selectedEvent) {
                        openEvent(selectedEvent)
                    }
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                HStack {
                    Spacer()
                    MapResultsControl(count: store.mapEvents.count, action: showResults)
                }
            }
            .padding(16)
        }
    }

    private func cameraSettled(_ context: MapCameraUpdateContext) {
        guard cameraPosition.positionedByUser else { return }
        guard let bounds = MapBounds(region: context.region) else { return }
        store.mapBoundsDidSettle(bounds)
    }

    private func cameraRefitRequested(oldValue: Int, newValue: Int) {
        guard oldValue != newValue else { return }
        selectedEventID = nil
        cameraPosition = .fitting(store.mapEvents)
    }

    private func showResults() {
        showsResults = true
    }
}

private extension MapCameraPosition {
    static func fitting(_ events: [EventSummary]) -> MapCameraPosition {
        guard let viewport = DiscoveryMapViewport.fitting(events) else { return .automatic }
        return .region(MKCoordinateRegion(
            center: CLLocationCoordinate2D(
                latitude: viewport.centerLatitude,
                longitude: viewport.centerLongitude
            ),
            span: MKCoordinateSpan(
                latitudeDelta: viewport.latitudeDelta,
                longitudeDelta: viewport.longitudeDelta
            )
        ))
    }
}

private struct DiscoveryMapMarker: MapContent {
    let event: EventSummary
    let locale: Locale

    var body: some MapContent {
        if let coordinate = event.coordinate {
            Annotation(
                event.title,
                coordinate: CLLocationCoordinate2D(
                    latitude: coordinate.latitude,
                    longitude: coordinate.longitude
                )
            ) {
                Image(systemName: EventCoverStyle.style(for: event.category).symbol)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(SpottColor.twilight, in: Circle())
                    .frame(width: 44, height: 44)
                    .contentShape(Circle())
                    .accessibilityLabel(accessibilityLabel)
            }
            .tag(event.id)
        }
    }

    private var accessibilityLabel: Text {
        Text(verbatim: DiscoveryEventPresentation(
            event: event,
            locale: locale
        ).approximateLocationAccessibilityLabel)
    }
}

private struct DiscoveryMapMiniCard: View {
    @Environment(\.locale) private var locale
    let event: EventSummary
    let open: () -> Void

    private var presentation: DiscoveryCardPresentation {
        DiscoveryCardPresentation(event: event, locale: locale)
    }

    var body: some View {
        Button(action: open) {
            HStack(spacing: 12) {
                EventCoverView(url: event.coverURL, category: event.category, cornerRadius: 12)
                    .frame(width: 64, height: 64)
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: event.title)
                        .font(.headline)
                        .foregroundStyle(SpottColor.ink)
                        .lineLimit(1)
                    (
                        Text(verbatim: "\(presentation.startText) · ")
                            .foregroundStyle(SpottColor.muted)
                        + Text(verbatim: presentation.capacityText)
                            .foregroundStyle(
                                presentation.isCapacityUrgent
                                    ? SpottColor.coral
                                    : SpottColor.muted
                            )
                    )
                    .font(.caption.weight(.medium))
                    .monospacedDigit()
                    .lineLimit(1)
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(SpottColor.muted)
            }
            .padding(16)
            .frame(minHeight: 96)
            .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
        .buttonStyle(.plain)
        .glassEffect(
            .regular.interactive(),
            in: RoundedRectangle(cornerRadius: 22, style: .continuous)
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "\(event.title), \(miniCardSubtitle)"))
        .accessibilityHint(Text(verbatim: DiscoveryHomeLocalization.text(
            "discovery.map.minicard.hint", locale: locale
        )))
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("discovery.map-mini-card")
    }

    private var miniCardSubtitle: String {
        "\(presentation.startText) · \(presentation.capacityText)"
    }
}

private struct NoMapLocationsView: View {
    @Environment(\.locale) private var locale

    var body: some View {
        ContentUnavailableView {
            Label {
                Text(verbatim: DiscoveryHomeLocalization.text(
                    "discovery.map.no_locations.title", locale: locale
                ))
            } icon: {
                Image(systemName: "map")
            }
        } description: {
            Text(verbatim: DiscoveryHomeLocalization.text(
                "discovery.map.no_locations.message", locale: locale
            ))
        }
        .padding()
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
        .padding()
    }
}

private struct MapResultsControl: View {
    @Environment(\.locale) private var locale
    let count: Int
    let action: () -> Void

    var body: some View {
        SpottGlassGroup(spacing: 8) {
            Button(action: action) {
                Label(
                    DiscoveryHomeLocalization.format(
                        "discovery.map.results", locale: locale, count
                    ),
                    systemImage: "list.bullet"
                )
                .font(.subheadline.weight(.semibold))
                .frame(minHeight: 44)
            }
            .buttonStyle(.glassProminent)
            .buttonBorderShape(.capsule)
            .tint(SpottColor.twilight)
            .accessibilityIdentifier("discovery.map-results")
        }
    }
}

struct MapResultsSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    let events: [EventSummary]
    @Binding var selectedEventID: UUID?

    private var orderedEvents: [EventSummary] {
        guard let selectedEventID,
              let selected = events.first(where: { $0.id == selectedEventID }) else { return events }
        return [selected] + events.filter { $0.id != selectedEventID }
    }

    var body: some View {
        NavigationStack {
            List(orderedEvents) { event in
                Button { open(event) } label: {
                    DiscoveryEventRow(event: event)
                }
                .buttonStyle(.plain)
                .listRowInsets(.init(top: 10, leading: 16, bottom: 10, trailing: 16))
            }
            .listStyle(.plain)
            .overlay { if events.isEmpty { NoMapLocationsView() } }
            .navigationTitle(DiscoveryHomeLocalization.text(
                "discovery.map.results_title", locale: locale
            ))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(
                        DiscoveryHomeLocalization.text("discovery.map.close", locale: locale),
                        action: dismiss.callAsFunction
                    )
                }
            }
        }
        .accessibilityIdentifier("discovery.map-results-sheet")
    }

    private func open(_ event: EventSummary) {
        model.show(event: event)
        dismiss()
    }
}

private extension MapBounds {
    init?(region: MKCoordinateRegion) {
        guard region.center.latitude.isFinite,
              region.center.longitude.isFinite,
              region.span.latitudeDelta.isFinite,
              region.span.longitudeDelta.isFinite,
              region.span.latitudeDelta > 0,
              region.span.longitudeDelta > 0 else { return nil }
        let west = max(-180, region.center.longitude - region.span.longitudeDelta / 2)
        let east = min(180, region.center.longitude + region.span.longitudeDelta / 2)
        let south = max(-90, region.center.latitude - region.span.latitudeDelta / 2)
        let north = min(90, region.center.latitude + region.span.latitudeDelta / 2)
        guard west < east, south < north else { return nil }
        self.init(
            west: west.rounded(toPlaces: 5),
            south: south.rounded(toPlaces: 5),
            east: east.rounded(toPlaces: 5),
            north: north.rounded(toPlaces: 5)
        )
    }
}

private extension Double {
    func rounded(toPlaces places: Int) -> Double {
        let scale = pow(10, Double(places))
        return (self * scale).rounded() / scale
    }
}
