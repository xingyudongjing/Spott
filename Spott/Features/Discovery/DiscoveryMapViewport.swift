import Foundation

struct DiscoveryMapViewport: Equatable, Sendable {
    let centerLatitude: Double
    let centerLongitude: Double
    let latitudeDelta: Double
    let longitudeDelta: Double

    static func fitting(_ events: [EventSummary]) -> DiscoveryMapViewport? {
        let coordinates = events.compactMap(\.coordinate).filter {
            $0.latitude.isFinite && $0.longitude.isFinite
                && (-90 ... 90).contains($0.latitude)
                && (-180 ... 180).contains($0.longitude)
        }
        guard let minimumLatitude = coordinates.map(\.latitude).min(),
              let maximumLatitude = coordinates.map(\.latitude).max(),
              let minimumLongitude = coordinates.map(\.longitude).min(),
              let maximumLongitude = coordinates.map(\.longitude).max() else { return nil }

        return DiscoveryMapViewport(
            centerLatitude: (minimumLatitude + maximumLatitude) / 2,
            centerLongitude: (minimumLongitude + maximumLongitude) / 2,
            latitudeDelta: max((maximumLatitude - minimumLatitude) * 1.6, 0.06),
            longitudeDelta: max((maximumLongitude - minimumLongitude) * 1.6, 0.08)
        )
    }
}

extension MapBounds {
    var isUsefulDiscoveryViewport: Bool {
        west.isFinite && south.isFinite && east.isFinite && north.isFinite
            && (-180 ... 180).contains(west) && (-180 ... 180).contains(east)
            && (-90 ... 90).contains(south) && (-90 ... 90).contains(north)
            && west < east && south < north
            && east - west <= 120 && north - south <= 60
    }
}
