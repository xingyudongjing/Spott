import MapKit
import SwiftUI

struct DiscoveryMap: View {
    @Environment(\.locale) private var locale
    let store: DiscoveryStore
    @Binding var selectedEventID: UUID?
    @Binding var showsResults: Bool
    @State private var cameraPosition: MapCameraPosition

    init(
        store: DiscoveryStore,
        selectedEventID: Binding<UUID?>,
        showsResults: Binding<Bool>
    ) {
        self.store = store
        _selectedEventID = selectedEventID
        _showsResults = showsResults
        _cameraPosition = State(initialValue: .fitting(store.mapEvents))
    }

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Map(position: $cameraPosition, selection: $selectedEventID) {
                ForEach(store.mapEvents) { event in
                    DiscoveryMapMarker(event: event, locale: locale)
                }
            }
            .mapStyle(.standard)
            .mapControls {
                MapCompass()
                MapScaleView()
            }
            .onMapCameraChange(frequency: .onEnd, cameraSettled)
            .onChange(of: selectedEventID, selectionChanged)
            .accessibilityLabel("活动地图")
            .accessibilityHint("地图位置均为主办方公开的约略位置；结果也可在列表中浏览。")
            .accessibilityIdentifier("discovery.map")

            if store.mapEvents.isEmpty {
                NoMapLocationsView()
            }

            MapResultsControl(count: store.mapEvents.count, action: showResults)
                .padding(16)
        }
    }

    private func cameraSettled(_ context: MapCameraUpdateContext) {
        guard cameraPosition.positionedByUser else { return }
        guard let bounds = MapBounds(region: context.region) else { return }
        store.mapBoundsDidSettle(bounds)
    }

    private func selectionChanged(oldValue: UUID?, newValue: UUID?) {
        if newValue != nil { showsResults = true }
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
                Image(systemName: event.remaining > 0 ? "calendar.badge.plus" : "calendar")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 44, height: 44)
                    .background(SpottColor.twilight, in: Circle())
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

private struct NoMapLocationsView: View {
    var body: some View {
        ContentUnavailableView(
            "没有可显示的位置",
            systemImage: "map",
            description: Text("这些活动尚未发布公共地图位置，请使用列表查看。")
        )
        .padding()
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
        .padding()
    }
}

private struct MapResultsControl: View {
    let count: Int
    let action: () -> Void

    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: 8) {
                button.buttonStyle(.glassProminent)
            }
        } else {
            button
                .buttonStyle(.borderedProminent)
                .background(.regularMaterial, in: Capsule())
        }
    }

    private var button: some View {
        Button(action: action) {
            Label("\(count) 个地图结果", systemImage: "list.bullet")
                .font(.subheadline.weight(.semibold))
                .frame(minHeight: 44)
        }
        .accessibilityIdentifier("discovery.map-results")
    }
}

struct MapResultsSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
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
            .navigationTitle("地图结果")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("关闭", action: dismiss.callAsFunction)
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
