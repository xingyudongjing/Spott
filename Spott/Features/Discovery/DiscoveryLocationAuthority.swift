import CoreLocation
import Foundation
import Observation

@MainActor
@Observable
final class DiscoveryLocationAuthority: NSObject, CLLocationManagerDelegate {
    struct Fix: Equatable, Sendable {
        let latitude: Double
        let longitude: Double
    }

    private(set) var status: CLAuthorizationStatus
    private(set) var latestFix: Fix?

    @ObservationIgnored private var manager: CLLocationManager?
    @ObservationIgnored private var pendingFixHandlers: [(Fix?) -> Void] = []
    @ObservationIgnored private var wantsFixAfterAuthorization = false

    override init() {
        status = .notDetermined
        super.init()
    }

    var isAuthorized: Bool {
        status == .authorizedWhenInUse || status == .authorizedAlways
    }

    var isDenied: Bool {
        status == .denied || status == .restricted
    }

    var isUndetermined: Bool {
        status == .notDetermined
    }

    func prepare() {
        _ = locationManager()
    }

    /// Requests when-in-use authorization if needed, then delivers a one-shot
    /// fix. The completion receives nil when authorization is denied or the
    /// fix fails.
    func requestFix(_ completion: @escaping (Fix?) -> Void) {
        let manager = locationManager()
        switch status {
        case .authorizedWhenInUse, .authorizedAlways:
            pendingFixHandlers.append(completion)
            manager.requestLocation()
        case .notDetermined:
            pendingFixHandlers.append(completion)
            wantsFixAfterAuthorization = true
            manager.requestWhenInUseAuthorization()
        default:
            completion(nil)
        }
    }

    func boundsAroundLatestFix() -> MapBounds? {
        guard let latestFix else { return nil }
        return Self.bounds(around: latestFix)
    }

    static func bounds(around fix: Fix) -> MapBounds {
        let latitudeDelta = 0.027
        let longitudeDelta = 0.033
        return MapBounds(
            west: max(-180, fix.longitude - longitudeDelta),
            south: max(-90, fix.latitude - latitudeDelta),
            east: min(180, fix.longitude + longitudeDelta),
            north: min(90, fix.latitude + latitudeDelta)
        )
    }

    private func locationManager() -> CLLocationManager {
        if let manager { return manager }
        let created = CLLocationManager()
        created.desiredAccuracy = kCLLocationAccuracyHundredMeters
        created.delegate = self
        manager = created
        status = created.authorizationStatus
        return created
    }

    private func flushPendingFixHandlers(with fix: Fix?) {
        let handlers = pendingFixHandlers
        pendingFixHandlers = []
        for handler in handlers {
            handler(fix)
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let newStatus = manager.authorizationStatus
        Task { @MainActor in
            status = newStatus
            guard wantsFixAfterAuthorization else { return }
            switch newStatus {
            case .authorizedWhenInUse, .authorizedAlways:
                wantsFixAfterAuthorization = false
                locationManager().requestLocation()
            case .denied, .restricted:
                wantsFixAfterAuthorization = false
                flushPendingFixHandlers(with: nil)
            default:
                break
            }
        }
    }

    nonisolated func locationManager(
        _ manager: CLLocationManager,
        didUpdateLocations locations: [CLLocation]
    ) {
        guard let coordinate = locations.last?.coordinate,
              coordinate.latitude.isFinite,
              coordinate.longitude.isFinite else { return }
        let fix = Fix(latitude: coordinate.latitude, longitude: coordinate.longitude)
        Task { @MainActor in
            latestFix = fix
            flushPendingFixHandlers(with: fix)
        }
    }

    nonisolated func locationManager(
        _ manager: CLLocationManager,
        didFailWithError error: Error
    ) {
        Task { @MainActor in
            flushPendingFixHandlers(with: nil)
        }
    }
}
