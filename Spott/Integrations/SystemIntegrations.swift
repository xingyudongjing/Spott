import ActivityKit
import EventKit
import Foundation
import StoreKit
import UserNotifications
import UIKit

actor NotificationCenterManager {
    static let shared = NotificationCenterManager()
    func requestAuthorization() async throws -> Bool {
        let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
        if granted {
            await MainActor.run { UIApplication.shared.registerForRemoteNotifications() }
        }
        return granted
    }
}

enum APNSDeviceToken {
    static func hexString(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }
}

extension Notification.Name {
    static let spottPushTokenUpdated = Notification.Name("jp.spott.push-token-updated")
}

final class SpottAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = APNSDeviceToken.hexString(deviceToken)
        UserDefaults.standard.set(token, forKey: "spott.apns.device-token")
        NotificationCenter.default.post(name: .spottPushTokenUpdated, object: nil)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // Permission and simulator failures remain visible in Settings; no token is sent to the API.
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound, .badge]
    }
}

actor CalendarIntegration {
    private let store = EKEventStore()
    func add(title: String, start: Date, end: Date, notes: String) async throws {
        guard try await store.requestFullAccessToEvents() else { return }
        let event = EKEvent(eventStore: store); event.title = title; event.startDate = start; event.endDate = end; event.notes = notes; event.calendar = store.defaultCalendarForNewEvents
        try store.save(event, span: .thisEvent)
    }
}

actor StoreKitManager {
    static let shared = StoreKitManager()

    func products(ids: Set<String>) async throws -> [Product] { try await Product.products(for: ids) }

    func purchase(_ product: Product, appAccountToken: UUID) async throws -> VerifiedStorePurchase? {
        switch try await product.purchase(options: [.appAccountToken(appAccountToken)]) {
        case .success(let verification):
            guard case .verified(let transaction) = verification else {
                throw StoreError.verificationFailed
            }
            return .init(transaction: transaction, signedTransaction: verification.jwsRepresentation)
        case .pending, .userCancelled: return nil
        @unknown default: return nil
        }
    }

    func unfinishedPurchases() async -> [VerifiedStorePurchase] {
        var purchases: [VerifiedStorePurchase] = []
        for await verification in Transaction.unfinished {
            guard case .verified(let transaction) = verification else { continue }
            purchases.append(.init(transaction: transaction, signedTransaction: verification.jwsRepresentation))
        }
        return purchases
    }

    func finish(_ purchase: VerifiedStorePurchase) async {
        await purchase.transaction.finish()
    }

    enum StoreError: Error { case verificationFailed }
}

struct VerifiedStorePurchase: Sendable {
    let transaction: StoreKit.Transaction
    let signedTransaction: String
}

struct SpottActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable { let phase: String; let minutesRemaining: Int }
    let eventID: UUID
    let title: String
    let publicArea: String
}

enum LiveActivityIntegration {
    static func start(event: EventSummary) throws {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let attributes = SpottActivityAttributes(
            eventID: event.id,
            title: event.title,
            publicArea: event.publicArea ?? ""
        )
        _ = try Activity.request(attributes: attributes, content: .init(state: .init(phase: "即将开始", minutesRemaining: 60), staleDate: event.startsAt), pushType: .token)
    }
}
