import Foundation
import Observation
import SwiftUI

enum NotificationListPhase: Equatable, Sendable {
    case loading
    case content([NotificationItem])
    case empty
    case failed
}

enum NotificationCenterNotice: Equatable, Sendable {
    case markReadFailedInCenter
    case markReadFailedAfterNavigation
    case navigationFailed
    case refreshFailed
}

@MainActor
@Observable
final class NotificationCenterStore {
    typealias PageLoader = (String?) async throws -> CursorPage<NotificationItem>

    private(set) var phase: NotificationListPhase = .loading
    private(set) var notice: NotificationCenterNotice?
    private(set) var nextCursor: String?
    private(set) var hasMore = false
    private(set) var isLoadingMore = false
    private(set) var paginationFailed = false
    private(set) var paginationRecoveryRequiresReload = false
    private(set) var isFirstPageRequestInFlight = false
    private var selectingIDs: Set<UUID> = []
    private var noticeSourceID: UUID?
    private var presentationGeneration: UInt64 = 0
    private var consumedCursors: Set<String> = []
    private var locallyConfirmedReadAt: [UUID: Date] = [:]

    var paginationTaskID: String? {
        guard hasMore,
              !paginationFailed,
              !isFirstPageRequestInFlight else { return nil }
        return normalizedCursor(nextCursor)
    }

    var hasRetainedPresentation: Bool { phase.hasRetainedPresentation }

    func load(isRefresh: Bool = false, using loader: PageLoader) async {
        presentationGeneration &+= 1
        let requestGeneration = presentationGeneration
        let previousPhase = phase
        let previousCursor = nextCursor
        let previousHasMore = hasMore
        let previousPaginationFailed = paginationFailed
        let previousPaginationRecoveryRequiresReload = paginationRecoveryRequiresReload
        let previousConsumedCursors = consumedCursors
        isFirstPageRequestInFlight = true
        isLoadingMore = false
        if !isRefresh { phase = .loading }
        defer {
            if presentationGeneration == requestGeneration {
                isFirstPageRequestInFlight = false
            }
        }

        do {
            let page = try await loader(nil)
            try Task.checkCancellation()
            guard presentationGeneration == requestGeneration else { return }
            let items = applyingLocalReadState(to: Self.unique(page.items))
            paginationFailed = false
            paginationRecoveryRequiresReload = false
            consumedCursors.removeAll()
            updatePagination(from: page)
            phase = items.isEmpty && !hasMore && !paginationFailed
                ? .empty
                : .content(items)
            clearRefreshNotice()
        } catch is CancellationError {
            guard presentationGeneration == requestGeneration else { return }
            phase = applyingLocalReadState(to: previousPhase)
            nextCursor = previousCursor
            hasMore = previousHasMore
            paginationFailed = previousPaginationFailed
            paginationRecoveryRequiresReload = previousPaginationRecoveryRequiresReload
            consumedCursors = previousConsumedCursors
        } catch {
            guard presentationGeneration == requestGeneration else { return }
            if isRefresh, previousPhase.hasRetainedPresentation {
                phase = applyingLocalReadState(to: previousPhase)
                nextCursor = previousCursor
                hasMore = previousHasMore
                paginationFailed = previousPaginationFailed
                paginationRecoveryRequiresReload = previousPaginationRecoveryRequiresReload
                consumedCursors = previousConsumedCursors
                notice = .refreshFailed
                noticeSourceID = nil
            } else {
                phase = .failed
                nextCursor = nil
                hasMore = false
                paginationFailed = false
                paginationRecoveryRequiresReload = false
                consumedCursors.removeAll()
            }
        }
    }

    func loadNextPage(using loader: PageLoader) async {
        guard hasMore,
              !isLoadingMore,
              !isFirstPageRequestInFlight else { return }
        guard let requestedCursor = normalizedCursor(nextCursor) else {
            invalidatePaginationForReload()
            return
        }
        guard !consumedCursors.contains(requestedCursor) else {
            invalidatePaginationForReload()
            return
        }

        let requestGeneration = presentationGeneration
        let previousPaginationFailed = paginationFailed
        isLoadingMore = true
        paginationFailed = false
        defer {
            if presentationGeneration == requestGeneration {
                isLoadingMore = false
            }
        }
        do {
            let page = try await loader(requestedCursor)
            try Task.checkCancellation()
            guard presentationGeneration == requestGeneration,
                  nextCursor == requestedCursor else { return }
            consumedCursors.insert(requestedCursor)
            appendUnique(applyingLocalReadState(to: page.items))
            if page.hasMore {
                guard let responseCursor = normalizedCursor(page.nextCursor),
                      !consumedCursors.contains(responseCursor) else {
                    invalidatePaginationForReload()
                    return
                }
            }
            updatePagination(from: page)
        } catch is CancellationError {
            guard presentationGeneration == requestGeneration else { return }
            paginationFailed = previousPaginationFailed
            return
        } catch {
            guard presentationGeneration == requestGeneration else { return }
            paginationFailed = true
        }
    }

    func retryPagination(using loader: PageLoader) async {
        guard paginationFailed,
              !isFirstPageRequestInFlight,
              !isLoadingMore else { return }
        if paginationRecoveryRequiresReload {
            await load(isRefresh: true, using: loader)
        } else {
            guard hasMore, normalizedCursor(nextCursor) != nil else { return }
            await loadNextPage(using: loader)
        }
    }

    func select(
        _ item: NotificationItem,
        navigate: (URL) async throws -> Bool,
        markRead: (UUID) async throws -> Void,
        onNotice: (NotificationCenterNotice) -> Void = { _ in }
    ) async {
        guard selectingIDs.insert(item.id).inserted else { return }
        defer { selectingIDs.remove(item.id) }

        let destinationURL = item.destinationURL
        var navigated = false
        if let destinationURL {
            do {
                navigated = try await navigate(destinationURL)
                try Task.checkCancellation()
                guard navigated else {
                    setNotice(.navigationFailed, sourceID: item.id)
                    return
                }
            } catch is CancellationError {
                return
            } catch {
                setNotice(.navigationFailed, sourceID: item.id)
                return
            }
        }
        guard item.readAt == nil else {
            if navigated { clearNotice(ifOwnedBy: item.id) }
            return
        }

        do {
            try await markRead(item.id)
            try Task.checkCancellation()
            markLocallyRead(item.id)
            clearNotice(ifOwnedBy: item.id)
        } catch is CancellationError {
            return
        } catch {
            if navigated {
                clearNotice(ifOwnedBy: item.id)
                onNotice(.markReadFailedAfterNavigation)
            } else {
                setNotice(.markReadFailedInCenter, sourceID: item.id)
            }
        }
    }

    func isSelecting(_ id: UUID) -> Bool { selectingIDs.contains(id) }

    func dismissNotice() {
        notice = nil
        noticeSourceID = nil
    }

    private func setNotice(_ value: NotificationCenterNotice, sourceID: UUID) {
        notice = value
        noticeSourceID = sourceID
    }

    private func clearNotice(ifOwnedBy id: UUID) {
        guard noticeSourceID == id else { return }
        notice = nil
        noticeSourceID = nil
    }

    private func clearRefreshNotice() {
        guard notice == .refreshFailed, noticeSourceID == nil else { return }
        notice = nil
    }

    private func invalidatePaginationForReload() {
        hasMore = false
        nextCursor = nil
        paginationFailed = true
        paginationRecoveryRequiresReload = true
    }

    private func updatePagination(from page: CursorPage<NotificationItem>) {
        nextCursor = normalizedCursor(page.nextCursor)
        hasMore = page.hasMore && nextCursor != nil
        paginationRecoveryRequiresReload = false
        if page.hasMore && nextCursor == nil {
            paginationFailed = true
            paginationRecoveryRequiresReload = true
        }
    }

    private func normalizedCursor(_ cursor: String?) -> String? {
        guard let value = cursor?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        return value
    }

    private func appendUnique(_ newItems: [NotificationItem]) {
        guard case .content(let existing) = phase else { return }
        var known = Set(existing.map(\.id))
        phase = .content(existing + newItems.filter { known.insert($0.id).inserted })
    }

    private static func unique(_ items: [NotificationItem]) -> [NotificationItem] {
        var known: Set<UUID> = []
        return items.filter { known.insert($0.id).inserted }
    }

    private func markLocallyRead(_ id: UUID) {
        let readAt = Date()
        locallyConfirmedReadAt[id] = readAt
        guard case .content(let items) = phase else { return }
        phase = .content(items.map { item in
            guard item.id == id else { return item }
            return item.markedRead(at: readAt)
        })
    }

    private func applyingLocalReadState(
        to phase: NotificationListPhase
    ) -> NotificationListPhase {
        guard case .content(let items) = phase else { return phase }
        return .content(
            applyingLocalReadState(
                to: items,
                acknowledgesServerReads: false
            )
        )
    }

    private func applyingLocalReadState(
        to items: [NotificationItem],
        acknowledgesServerReads: Bool = true
    ) -> [NotificationItem] {
        items.map { item in
            if item.readAt != nil {
                if acknowledgesServerReads {
                    locallyConfirmedReadAt.removeValue(forKey: item.id)
                }
                return item
            }
            guard let readAt = locallyConfirmedReadAt[item.id] else { return item }
            return item.markedRead(at: readAt)
        }
    }
}

extension NotificationItem {
    var destinationURL: URL? {
        guard let identifier = resourcePublicId,
              Self.isSafeDeepLinkIdentifier(identifier) else { return nil }

        let route: String
        let expectedResourceType: String
        switch type {
        case "event.cancelled", "waitlist.offered":
            route = "e"
            expectedResourceType = "event"
        case "group.announcement", "group.dissolution_scheduled":
            route = "g"
            expectedResourceType = "group"
        default:
            return nil
        }
        guard resourceType == expectedResourceType else { return nil }
        return URL(string: "spott://\(route)/\(identifier)")
    }

    private static func isSafeDeepLinkIdentifier(_ value: String) -> Bool {
        guard !value.isEmpty,
              value.count <= 128,
              value == value.trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        return value.unicodeScalars.allSatisfy(allowed.contains)
    }

    fileprivate func markedRead(at date: Date) -> NotificationItem {
        NotificationItem(
            id: id,
            type: type,
            locale: locale,
            templateVersion: templateVersion,
            title: title,
            body: body,
            variables: variables,
            resourceType: resourceType,
            resourcePublicId: resourcePublicId,
            createdAt: createdAt,
            readAt: date
        )
    }

    func accessibilitySummary(timestamp: String, unreadLabel: String) -> String {
        var parts = [title, body, timestamp]
        if readAt == nil { parts.append(unreadLabel) }
        return parts.joined(separator: ", ")
    }
}

enum NotificationCenterLocale {
    static func eventLocale(for locale: Locale) -> EventLocale {
        switch locale.language.languageCode?.identifier.lowercased() {
        case "zh": .zhHans
        case "ja": .ja
        default: .en
        }
    }
}

enum NotificationTimestampFormatter {
    static func string(
        for date: Date,
        relativeTo referenceDate: Date = Date(),
        locale: Locale
    ) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = locale
        formatter.unitsStyle = .full
        return formatter.localizedString(for: date, relativeTo: referenceDate)
    }
}

private extension NotificationListPhase {
    var hasRetainedPresentation: Bool {
        switch self {
        case .content, .empty: true
        case .loading, .failed: false
        }
    }
}

enum NotificationCenterLayout {
    /// A one-point margin avoids a rendered target falling below 44 pt after rounding.
    static let minimumTouchTarget: CGFloat = 45
    static let timestampRefreshInterval: TimeInterval = 60

    static func showsLeadingIcon(for dynamicTypeSize: DynamicTypeSize) -> Bool {
        !dynamicTypeSize.isAccessibilitySize
    }
}

struct NotificationCenterStateCardPresentation: Equatable {
    let showsDecorativeIcon: Bool
    let minimumActionWidth: CGFloat
    let minimumActionHeight: CGFloat

    init(dynamicTypeSize: DynamicTypeSize) {
        showsDecorativeIcon = NotificationCenterLayout.showsLeadingIcon(for: dynamicTypeSize)
        minimumActionWidth = NotificationCenterLayout.minimumTouchTarget
        minimumActionHeight = NotificationCenterLayout.minimumTouchTarget
    }
}

struct NotificationCenterTaskID: Hashable {
    let locale: EventLocale
}

struct NotificationCenterCopy {
    let title: String
    let loading: String
    let emptyTitle: String
    let emptyMessage: String
    let loadFailureTitle: String
    let loadFailureMessage: String
    let retry: String
    let markReadFailureInCenter: String
    let markReadFailureAfterNavigation: String
    let navigationFailure: String
    let refreshFailure: String
    let paginationFailure: String
    let dismiss: String
    let opensDestinationHint: String
    let staysInCenterHint: String
    let unread: String

    init(locale: Locale) {
        switch NotificationCenterLocale.eventLocale(for: locale) {
        case .ja:
            title = "通知"
            loading = "通知を読み込んでいます"
            emptyTitle = "通知はありません"
            emptyMessage = "キャンセル待ち、変更、セキュリティに関する通知はここに表示されます。"
            loadFailureTitle = "通知を読み込めませんでした"
            loadFailureMessage = "接続を確認して、もう一度お試しください。"
            retry = "再試行"
            markReadFailureInCenter = "既読にできませんでした。通知センターに留まっています。後でもう一度お試しください。"
            markReadFailureAfterNavigation = "関連する詳細は開きましたが、この通知を既読にできませんでした。後でもう一度お試しください。"
            navigationFailure = "関連する詳細を開けませんでした。通知センターに留まっています。"
            refreshFailure = "更新できませんでした。表示中の通知はそのまま残しています。"
            paginationFailure = "さらに通知を読み込めませんでした。表示中の通知はそのまま残しています。"
            dismiss = "閉じる"
            opensDestinationHint = "関連する詳細を開きます"
            staysInCenterHint = "この通知センターに留まります"
            unread = "未読"
        case .en:
            title = "Notifications"
            loading = "Loading notifications"
            emptyTitle = "No notifications"
            emptyMessage = "Waitlist, change, and security notices will stay here."
            loadFailureTitle = "Notifications couldn’t load"
            loadFailureMessage = "Check your connection and try again."
            retry = "Try again"
            markReadFailureInCenter = "Couldn’t mark this notification as read. You’re still in Notification Center; try again later."
            markReadFailureAfterNavigation = "The related details opened, but this notification couldn’t be marked as read. Try again later."
            navigationFailure = "Couldn’t open the related details. You’re still in Notification Center."
            refreshFailure = "Couldn’t refresh. Your current notifications are still here."
            paginationFailure = "Couldn’t load more. Your current notifications are still here."
            dismiss = "Dismiss"
            opensDestinationHint = "Opens the related details"
            staysInCenterHint = "Stays in Notification Center"
            unread = "Unread"
        case .zhHans:
            title = "通知"
            loading = "正在加载通知"
            emptyTitle = "暂无通知"
            emptyMessage = "候补、变更和安全通知会保留在这里。"
            loadFailureTitle = "无法加载通知"
            loadFailureMessage = "请检查网络连接后重试。"
            retry = "重新加载"
            markReadFailureInCenter = "暂时无法标为已读。你仍停留在通知中心，可稍后重试。"
            markReadFailureAfterNavigation = "已打开相关详情，但这条通知暂时无法标为已读。请稍后重试。"
            navigationFailure = "暂时无法打开相关详情。你仍停留在通知中心。"
            refreshFailure = "刷新失败，当前通知仍保留在这里。"
            paginationFailure = "无法加载更多通知，当前通知仍保留在这里。"
            dismiss = "关闭"
            opensDestinationHint = "打开相关详情"
            staysInCenterHint = "留在通知中心"
            unread = "未读"
        }
    }

    func notice(_ notice: NotificationCenterNotice) -> String {
        switch notice {
        case .markReadFailedInCenter: markReadFailureInCenter
        case .markReadFailedAfterNavigation: markReadFailureAfterNavigation
        case .navigationFailed: navigationFailure
        case .refreshFailed: refreshFailure
        }
    }
}
