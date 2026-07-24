import Foundation
import Observation
import SwiftUI

protocol EventCommentServing {
    func eventComments(eventID: UUID, cursor: String?, limit: Int) async throws -> EventCommentPage
    func postEventComment(
        eventID: UUID,
        body: String,
        parentID: UUID?,
        locale: String
    ) async throws -> EventComment
}

extension SpottAPIClient: EventCommentServing {}

struct EventCommentThread: Identifiable, Equatable, Sendable {
    let comment: EventComment
    let replies: [EventComment]

    var id: UUID { comment.id }
}

enum EventCommentComposerAvailability: Equatable, Sendable {
    case available
    case signedOut
    case locked
}

@MainActor
@Observable
final class EventCommentsStore {
    static let maximumBodyLength = 2_000

    enum Phase: Equatable, Sendable {
        case idle
        case loading
        case loaded
        case failed
    }

    private(set) var phase: Phase = .idle
    private(set) var comments: [EventComment] = []
    private(set) var permission: String?
    private(set) var isPosting = false
    private(set) var postError: UserFacingError?

    @ObservationIgnored private let eventID: UUID
    @ObservationIgnored private let service: any EventCommentServing
    @ObservationIgnored private let locale: Locale
    /// Bumped whenever a newer load or a post supersedes in-flight loads, so a
    /// stale response can never clobber the optimistic append or a newer page.
    @ObservationIgnored private var loadGeneration = 0

    init(
        eventID: UUID,
        service: any EventCommentServing,
        locale: Locale = .current
    ) {
        self.eventID = eventID
        self.service = service
        self.locale = locale
    }

    var threads: [EventCommentThread] {
        let topLevel = comments
            .filter { $0.parentId == nil }
            .sorted { $0.createdAt > $1.createdAt }
        let repliesByParent = Dictionary(grouping: comments.filter { $0.parentId != nil }) {
            $0.parentId!
        }
        return topLevel.map { comment in
            EventCommentThread(
                comment: comment,
                replies: (repliesByParent[comment.id] ?? [])
                    .sorted { $0.createdAt < $1.createdAt }
            )
        }
    }

    func load() async {
        loadGeneration += 1
        let generation = loadGeneration
        if phase == .idle || phase == .failed {
            phase = .loading
        }
        do {
            let page = try await service.eventComments(eventID: eventID, cursor: nil, limit: 100)
            guard generation == loadGeneration else { return }
            comments = page.items
            permission = page.commentPermission
            phase = .loaded
        } catch is CancellationError {
            if generation == loadGeneration, phase == .loading { phase = .idle }
        } catch {
            guard generation == loadGeneration else { return }
            if phase != .loaded { phase = .failed }
        }
    }

    func post(
        body: String,
        parentID: UUID?,
        viewerID: UUID,
        viewerName: String
    ) async -> Bool {
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              trimmed.count <= Self.maximumBodyLength,
              !isPosting else { return false }

        postError = nil
        isPosting = true
        defer { isPosting = false }

        let now = Date()
        let optimistic = EventComment(
            id: UUID(),
            eventId: eventID,
            author: EventCommentAuthor(id: viewerID, name: viewerName),
            body: trimmed,
            parentId: parentID,
            locale: apiLocale,
            version: 1,
            createdAt: now,
            updatedAt: now
        )
        // Invalidate any in-flight load so a stale snapshot cannot drop the
        // optimistic append when it lands.
        loadGeneration += 1
        comments.append(optimistic)

        do {
            let created = try await service.postEventComment(
                eventID: eventID,
                body: trimmed,
                parentID: parentID,
                locale: apiLocale
            )
            if let index = comments.firstIndex(where: { $0.id == optimistic.id }) {
                comments[index] = created
            } else {
                comments.append(created)
            }
            // The create response carries no joined author nickname; a silent
            // reload restores the real display name without blocking success.
            loadGeneration += 1
            let generation = loadGeneration
            if let page = try? await service.eventComments(eventID: eventID, cursor: nil, limit: 100),
               generation == loadGeneration {
                comments = page.items
                permission = page.commentPermission
            }
            return true
        } catch {
            comments.removeAll { $0.id == optimistic.id }
            postError = AppModel.map(error)
            return false
        }
    }

    func clearPostError() {
        postError = nil
    }

    private var apiLocale: String {
        let language = locale.identifier.lowercased()
        if language.hasPrefix("zh") { return "zh-Hans" }
        if language.hasPrefix("ja") { return "ja" }
        return "en"
    }
}

struct EventCommentsSection: View {
    let store: EventCommentsStore
    let event: EventSummary
    let viewerUser: UserSession.User?
    let locale: Locale
    let requestSignIn: () -> Void
    var onComposerFocusChange: ((Bool) -> Void)? = nil

    @State private var draft = ""
    @State private var replyTarget: EventComment?
    @FocusState private var composerFocused: Bool

    private var effectivePermission: String? {
        store.permission ?? event.commentPermission
    }

    private var isOrganizer: Bool {
        viewerUser?.id == event.organizerId
    }

    private var availability: EventCommentComposerAvailability {
        guard viewerUser != nil else { return .signedOut }
        if isOrganizer { return .available }
        switch effectivePermission {
        case "participants":
            let status = event.viewerRegistration?.status
            return status == .confirmed || status == .checkedIn ? .available : .locked
        case "group_members":
            // Group membership is not part of the event payload; without a
            // positive signal the composer stays honestly locked.
            return .locked
        default:
            return .locked
        }
    }

    var body: some View {
        if effectivePermission != "disabled",
           effectivePermission != nil || store.phase == .loaded {
            VStack(alignment: .leading, spacing: 12) {
                header
                content
            }
            .onChange(of: composerFocused) { _, focused in
                onComposerFocusChange?(focused)
            }
            .accessibilityIdentifier("event.detail.comments")
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(text("eventdetail.comments.title"))
                .font(.title3.bold())
                .accessibilityAddTraits(.isHeader)
            Spacer()
            if store.phase == .loaded, !store.comments.isEmpty {
                Text(
                    EventDetailExtrasLocalization.format(
                        "eventdetail.comments.count",
                        locale: locale,
                        store.comments.count
                    )
                )
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .idle, .loading:
            Label(text("eventdetail.comments.loading"), systemImage: "ellipsis.bubble")
                .font(.footnote)
                .foregroundStyle(.secondary)
        case .failed:
            VStack(alignment: .leading, spacing: 8) {
                Label(text("eventdetail.comments.load_failed"), systemImage: "wifi.exclamationmark")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Button(text("eventdetail.comments.retry")) {
                    Task { await store.load() }
                }
                .font(.footnote.weight(.semibold))
                .buttonStyle(.glass)
                .buttonBorderShape(.capsule)
            }
        case .loaded:
            loadedContent
        }
    }

    @ViewBuilder
    private var loadedContent: some View {
        if store.threads.isEmpty {
            VStack(spacing: 10) {
                Image(systemName: "text.bubble.fill")
                    .font(.system(size: 26, weight: .semibold))
                    .foregroundStyle(SpottColor.muted)
                    .frame(width: 56, height: 56)
                    .background(SpottColor.muted.opacity(0.12), in: Circle())
                Text(text("eventdetail.comments.empty_title"))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                Text(text("eventdetail.comments.empty_message"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
            .padding(.horizontal, 20)
            .background(
                Color(uiColor: .secondarySystemGroupedBackground),
                in: RoundedRectangle(cornerRadius: 18, style: .continuous)
            )
        } else {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(store.threads.enumerated()), id: \.element.id) { index, thread in
                    EventCommentThreadView(
                        thread: thread,
                        canReply: availability == .available,
                        locale: locale,
                        reply: { beginReply(to: thread.comment) }
                    )
                    if index < store.threads.count - 1 {
                        Divider().padding(.leading, 16)
                    }
                }
            }
            .background(
                Color(uiColor: .secondarySystemGroupedBackground),
                in: RoundedRectangle(cornerRadius: 18, style: .continuous)
            )
        }

        composer
    }

    @ViewBuilder
    private var composer: some View {
        switch availability {
        case .available:
            activeComposer
        case .signedOut:
            Button(action: requestSignIn) {
                HStack(spacing: 8) {
                    Image(systemName: "person.crop.circle.badge.checkmark")
                    Text(text("eventdetail.comments.signin"))
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.caption.bold())
                        .foregroundStyle(.tertiary)
                }
                .font(.subheadline.weight(.semibold))
                .frame(minHeight: 44)
                .padding(.horizontal, 14)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .background(
                Color(uiColor: .secondarySystemGroupedBackground),
                in: RoundedRectangle(cornerRadius: 18, style: .continuous)
            )
        case .locked:
            Label(lockedCopy, systemImage: "lock")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .background(
                    Color(uiColor: .secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 18, style: .continuous)
                )
                .accessibilityIdentifier("event.detail.comments.locked")
        }
    }

    private var activeComposer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let replyTarget {
                HStack(spacing: 8) {
                    Text(
                        EventDetailExtrasLocalization.format(
                            "eventdetail.comments.replying_to",
                            locale: locale,
                            replyTarget.author.name
                        )
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(SpottColor.twilight)
                    .lineLimit(1)

                    Button {
                        self.replyTarget = nil
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(.rect)
                    }
                    .accessibilityLabel(text("eventdetail.comments.cancel_reply"))
                }
            }

            HStack(alignment: .bottom, spacing: 10) {
                TextField(
                    text("eventdetail.comments.placeholder"),
                    text: $draft,
                    axis: .vertical
                )
                .lineLimit(1...5)
                .focused($composerFocused)
                .textFieldStyle(.plain)
                .frame(minHeight: 30)
                .accessibilityIdentifier("event.detail.comments.field")

                Button(action: submit) {
                    if store.isPosting {
                        ProgressView().controlSize(.small)
                            .frame(minWidth: 44, minHeight: 44)
                    } else {
                        Image(systemName: "paperplane.fill")
                            .frame(minWidth: 44, minHeight: 44)
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(canSubmit ? SpottColor.twilight : Color.secondary)
                .disabled(!canSubmit)
                .accessibilityLabel(text("eventdetail.comments.send"))
                .accessibilityIdentifier("event.detail.comments.send")
            }

            if draft.count > EventCommentsStore.maximumBodyLength - 200 {
                Text(
                    EventDetailExtrasLocalization.format(
                        "eventdetail.comments.chars",
                        locale: locale,
                        draft.count,
                        EventCommentsStore.maximumBodyLength
                    )
                )
                .font(.caption2.monospacedDigit())
                .foregroundStyle(
                    draft.count > EventCommentsStore.maximumBodyLength
                        ? SpottColor.danger
                        : Color.secondary
                )
            }

            if let postError = store.postError {
                Label(text("eventdetail.comments.post_failed"), systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(SpottColor.danger)
                    .accessibilityIdentifier("event.detail.comments.post_failed")
                    .id(postError.id)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(
            Color(uiColor: .secondarySystemGroupedBackground),
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color.primary.opacity(0.08), lineWidth: 0.5)
        }
    }

    private var canSubmit: Bool {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty
            && trimmed.count <= EventCommentsStore.maximumBodyLength
            && !store.isPosting
    }

    private var lockedCopy: String {
        switch effectivePermission {
        case "group_members":
            text("eventdetail.comments.locked.group_members")
        default:
            text("eventdetail.comments.locked.participants")
        }
    }

    private func beginReply(to comment: EventComment) {
        replyTarget = comment
        composerFocused = true
    }

    private func submit() {
        guard let viewerUser, canSubmit else { return }
        let body = draft
        let parentID = replyTarget?.id
        Task { @MainActor in
            let posted = await store.post(
                body: body,
                parentID: parentID,
                viewerID: viewerUser.id,
                viewerName: viewerUser.publicHandle
            )
            if posted {
                draft = ""
                replyTarget = nil
            }
        }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        EventDetailExtrasLocalization.text(key, locale: locale)
    }
}

private struct EventCommentThreadView: View {
    let thread: EventCommentThread
    let canReply: Bool
    let locale: Locale
    let reply: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            EventCommentRowView(
                comment: thread.comment,
                locale: locale,
                replyAction: canReply ? reply : nil
            )
            ForEach(thread.replies) { replyComment in
                EventCommentRowView(
                    comment: replyComment,
                    locale: locale,
                    replyAction: nil
                )
                .padding(.leading, 24)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}

private struct EventCommentRowView: View {
    let comment: EventComment
    let locale: Locale
    let replyAction: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(comment.author.name)
                    .font(.footnote.weight(.semibold))
                Text(relativeTime)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
            Text(comment.body)
                .font(.subheadline)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            if let replyAction {
                Button(action: replyAction) {
                    Text(EventDetailExtrasLocalization.text("eventdetail.comments.reply", locale: locale))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(SpottColor.twilight)
                        .frame(minWidth: 44, minHeight: 44, alignment: .leading)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var relativeTime: String {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = locale
        formatter.unitsStyle = .short
        return formatter.localizedString(for: comment.createdAt, relativeTo: Date())
    }
}
