import Observation
import SwiftUI

protocol HostTicketService: Sendable {
    func ticketTypes(eventID: UUID) async throws -> EventTicketTypePage
    func createTicketType(eventID: UUID, input: TicketTypeInput) async throws -> EventTicketType
    func updateTicketType(id: UUID, changes: TicketTypeUpdateInput) async throws -> EventTicketType
}

extension SpottAPIClient: HostTicketService {}

@MainActor
@Observable
final class HostTicketTypesStore {
    private(set) var items: [EventTicketType] = []
    private(set) var loading = false
    private(set) var saving = false
    private(set) var error: UserFacingError?

    private let service: HostTicketService
    private let eventID: UUID

    init(eventID: UUID, service: HostTicketService) {
        self.eventID = eventID
        self.service = service
    }

    func load() async {
        loading = true
        do {
            items = try await service.ticketTypes(eventID: eventID).items
            error = nil
        } catch {
            self.error = AppModel.map(error)
        }
        loading = false
    }

    @discardableResult
    func create(_ input: TicketTypeInput) async -> UserFacingError? {
        saving = true
        defer { saving = false }
        do {
            let created = try await service.createTicketType(eventID: eventID, input: input)
            items.append(created)
            items.sort { ($0.sortOrder, $0.id.uuidString) < ($1.sortOrder, $1.id.uuidString) }
            error = nil
            return nil
        } catch {
            let mapped = AppModel.map(error)
            self.error = mapped
            return mapped
        }
    }

    @discardableResult
    func update(id: UUID, changes: TicketTypeUpdateInput) async -> UserFacingError? {
        saving = true
        defer { saving = false }
        do {
            let updated = try await service.updateTicketType(id: id, changes: changes)
            if updated.active {
                if let index = items.firstIndex(where: { $0.id == id }) {
                    items[index] = updated
                } else {
                    items.append(updated)
                }
            } else {
                items.removeAll { $0.id == id }
            }
            error = nil
            return nil
        } catch {
            let mapped = AppModel.map(error)
            self.error = mapped
            return mapped
        }
    }

    @discardableResult
    func deactivate(id: UUID) async -> UserFacingError? {
        await update(id: id, changes: TicketTypeUpdateInput(active: false))
    }

    func clearError() {
        error = nil
    }
}

struct HostTicketTypesView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    let event: EventSummary

    @State private var store: HostTicketTypesStore?
    @State private var editorTarget: HostTicketTypeEditorTarget?
    @State private var deactivating: EventTicketType?

    var body: some View {
        Group {
            if let store {
                content(store)
            } else {
                ProgressView()
            }
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .navigationTitle(text("host.tickets.title"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(text("host.common.close")) { dismiss() }
            }
            ToolbarItem(placement: .primaryAction) {
                Button {
                    editorTarget = .create
                } label: {
                    Label(text("host.tickets.add"), systemImage: "plus")
                }
            }
        }
        .task {
            if store == nil {
                store = HostTicketTypesStore(eventID: event.id, service: model.api)
            }
            await store?.load()
        }
        .sheet(item: $editorTarget) { target in
            NavigationStack {
                HostTicketTypeEditorView(event: event, target: target) { input in
                    guard let store else {
                        return UserFacingError(id: "STORE_UNAVAILABLE", message: text("host.tickets.save_failed"), retryable: true)
                    }
                    switch target {
                    case .create:
                        return await store.create(input)
                    case .edit(let existing):
                        return await store.update(
                            id: existing.id,
                            changes: TicketTypeUpdateInput(
                                name: input.name,
                                description: input.description,
                                isFree: input.isFree,
                                amountJPY: input.amountJPY,
                                collectorName: input.collectorName,
                                method: input.method,
                                paymentDeadlineText: input.paymentDeadlineText,
                                refundPolicy: input.refundPolicy,
                                quota: input.quota
                            )
                        )
                    }
                }
            }
            .tint(SpottColor.twilight)
        }
        .confirmationDialog(
            text("host.tickets.deactivate_title"),
            isPresented: Binding(
                get: { deactivating != nil },
                set: { if !$0 { deactivating = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button(text("host.tickets.deactivate_confirm"), role: .destructive) {
                if let ticket = deactivating {
                    Task { _ = await store?.deactivate(id: ticket.id) }
                }
                deactivating = nil
            }
            Button(text("host.cancel.dialog_dismiss"), role: .cancel) { deactivating = nil }
        } message: {
            Text(text("host.tickets.deactivate_message"))
        }
    }

    @ViewBuilder
    private func content(_ store: HostTicketTypesStore) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(text("host.tickets.boundary"))
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                if store.loading, store.items.isEmpty {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 60)
                } else if store.items.isEmpty {
                    SpottEmptyState(
                        icon: "ticket",
                        title: text("host.tickets.empty_title"),
                        message: text("host.tickets.empty_message"),
                        actionTitle: text("host.tickets.add")
                    ) { editorTarget = .create }
                } else {
                    ForEach(store.items) { ticket in
                        ticketRow(ticket)
                    }
                }
                if let error = store.error {
                    Label("\(error.message)（\(error.id)）", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(SpottColor.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(SpottMetric.pageInset)
        }
        .refreshable { await store.load() }
    }

    private func ticketRow(_ ticket: EventTicketType) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(ticket.name)
                        .font(.system(size: 16, weight: .bold, design: .rounded))
                    Text(priceLabel(ticket))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(ticket.isFree ? SpottColor.mint : SpottColor.ink)
                }
                Spacer()
                if ticket.soldOut {
                    Text(text("host.tickets.sold_out"))
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(SpottColor.coral, in: Capsule())
                }
            }
            if let description = ticket.description, !description.isEmpty {
                Text(description)
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
                    .lineLimit(3)
            }
            if !ticket.isFree {
                VStack(alignment: .leading, spacing: 3) {
                    if let collector = ticket.collectorName, !collector.isEmpty {
                        Text(HostLocalization.format("host.tickets.collector", locale: locale, collector))
                    }
                    if let method = ticket.method, !method.isEmpty {
                        Text(HostLocalization.format("host.tickets.method", locale: locale, method))
                    }
                    if let deadline = ticket.paymentDeadlineText, !deadline.isEmpty {
                        Text(HostLocalization.format("host.tickets.deadline", locale: locale, deadline))
                    }
                }
                .font(.caption)
                .foregroundStyle(SpottColor.muted)
            }
            HStack {
                Text(quotaLabel(ticket))
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
                Spacer()
                Button(text("host.tickets.edit")) { editorTarget = .edit(ticket) }
                    .buttonStyle(.glass)
                    .font(.caption.weight(.semibold))
                Button(text("host.tickets.deactivate"), role: .destructive) { deactivating = ticket }
                    .buttonStyle(.glass)
                    .tint(SpottColor.danger)
                    .font(.caption.weight(.semibold))
            }
        }
        .padding(16)
        .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: SpottMetric.cardRadius).stroke(SpottColor.divider))
    }

    private func priceLabel(_ ticket: EventTicketType) -> String {
        if ticket.isFree { return text("host.tickets.free") }
        let amount = ticket.amountJPY ?? 0
        return HostLocalization.format("host.tickets.paid_price", locale: locale, amount.formatted())
    }

    private func quotaLabel(_ ticket: EventTicketType) -> String {
        if let quota = ticket.quota {
            return HostLocalization.format("host.tickets.quota_used", locale: locale, ticket.soldCount, quota)
        }
        return HostLocalization.format("host.tickets.quota_unlimited", locale: locale, ticket.soldCount)
    }

    private func text(_ key: String.LocalizationValue) -> String {
        HostLocalization.text(key, locale: locale)
    }
}

enum HostTicketTypeEditorTarget: Identifiable {
    case create
    case edit(EventTicketType)

    var id: String {
        switch self {
        case .create: "create"
        case .edit(let ticket): ticket.id.uuidString
        }
    }
}

struct HostTicketTypeEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    let event: EventSummary
    let target: HostTicketTypeEditorTarget
    let save: (TicketTypeInput) async -> UserFacingError?

    @State private var name: String
    @State private var details: String
    @State private var isFree: Bool
    @State private var amountText: String
    @State private var collectorName: String
    @State private var method: String
    @State private var paymentDeadlineText: String
    @State private var refundPolicy: String
    @State private var quotaText: String
    @State private var busy = false
    @State private var validationMessage: String?

    private var soldCount: Int {
        if case .edit(let ticket) = target { return ticket.soldCount }
        return 0
    }

    init(event: EventSummary, target: HostTicketTypeEditorTarget, save: @escaping (TicketTypeInput) async -> UserFacingError?) {
        self.event = event
        self.target = target
        self.save = save
        let existing: EventTicketType? = if case .edit(let ticket) = target { ticket } else { nil }
        _name = State(initialValue: existing?.name ?? "")
        _details = State(initialValue: existing?.description ?? "")
        _isFree = State(initialValue: existing?.isFree ?? true)
        _amountText = State(initialValue: existing?.amountJPY.map(String.init) ?? "")
        _collectorName = State(initialValue: existing?.collectorName ?? "")
        _method = State(initialValue: existing?.method ?? "")
        _paymentDeadlineText = State(initialValue: existing?.paymentDeadlineText ?? "")
        _refundPolicy = State(initialValue: existing?.refundPolicy ?? "")
        _quotaText = State(initialValue: existing?.quota.map(String.init) ?? "")
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ComposerSection(
                    title: text("host.tickets.editor_basics"),
                    subtitle: text("host.tickets.editor_basics_subtitle")
                ) {
                    TextField(text("host.tickets.name_placeholder"), text: $name).composerField()
                    TextField(text("host.tickets.description_placeholder"), text: $details, axis: .vertical)
                        .lineLimit(2...6)
                        .composerField()
                    TextField(text("host.tickets.quota_placeholder"), text: $quotaText)
                        .keyboardType(.numberPad)
                        .composerField()
                    if soldCount > 0 {
                        Text(HostLocalization.format("host.tickets.quota_floor", locale: locale, soldCount))
                            .font(.caption)
                            .foregroundStyle(SpottColor.muted)
                    }
                }
                ComposerSection(
                    title: text("host.tickets.editor_payment"),
                    subtitle: text("host.tickets.editor_payment_subtitle")
                ) {
                    Toggle(text("host.tickets.free_toggle"), isOn: $isFree)
                    if !isFree {
                        TextField(text("host.tickets.amount_placeholder"), text: $amountText)
                            .keyboardType(.numberPad)
                            .composerField()
                        TextField(text("host.tickets.collector_placeholder"), text: $collectorName).composerField()
                        TextField(text("host.tickets.method_placeholder"), text: $method).composerField()
                        TextField(text("host.tickets.deadline_placeholder"), text: $paymentDeadlineText).composerField()
                        TextField(text("host.tickets.refund_placeholder"), text: $refundPolicy, axis: .vertical)
                            .lineLimit(3...8)
                            .composerField()
                    }
                }
                if let validationMessage {
                    Label(validationMessage, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(SpottColor.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Button {
                    submit()
                } label: {
                    if busy {
                        ProgressView().tint(.white).frame(maxWidth: .infinity)
                    } else {
                        Text(text("host.tickets.save")).frame(maxWidth: .infinity)
                    }
                }
                .spottProminentActionStyle()
                .controlSize(.large)
                .disabled(busy)
            }
            .padding(SpottMetric.pageInset)
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .navigationTitle(text(editorTitleKey))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(text("host.common.close")) { dismiss() }
            }
        }
    }

    private var editorTitleKey: String.LocalizationValue {
        if case .edit = target { "host.tickets.editor_edit_title" } else { "host.tickets.editor_create_title" }
    }

    private func submit() {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...80).contains(trimmedName.count) else {
            validationMessage = text("host.tickets.validation_name")
            return
        }
        var quota: Int?
        if !quotaText.trimmingCharacters(in: .whitespaces).isEmpty {
            guard let parsed = Int(quotaText), parsed >= 1 else {
                validationMessage = text("host.tickets.validation_quota")
                return
            }
            if parsed < soldCount {
                validationMessage = HostLocalization.format("host.tickets.quota_floor", locale: locale, soldCount)
                return
            }
            quota = parsed
        }
        var input = TicketTypeInput(name: trimmedName, isFree: isFree)
        input.description = details.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : details
        input.quota = quota
        if !isFree {
            guard let amount = Int(amountText), amount > 0 else {
                validationMessage = text("host.tickets.validation_amount")
                return
            }
            let collector = collectorName.trimmingCharacters(in: .whitespacesAndNewlines)
            let payMethod = method.trimmingCharacters(in: .whitespacesAndNewlines)
            let refund = refundPolicy.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !collector.isEmpty, !payMethod.isEmpty, !refund.isEmpty else {
                validationMessage = text("host.tickets.validation_paid_fields")
                return
            }
            input.amountJPY = amount
            input.collectorName = collector
            input.method = payMethod
            input.paymentDeadlineText = paymentDeadlineText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? nil
                : paymentDeadlineText
            input.refundPolicy = refund
        }
        validationMessage = nil
        busy = true
        Task {
            let failure = await save(input)
            busy = false
            if let failure {
                validationMessage = "\(failure.message)（\(failure.id)）"
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            } else {
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                dismiss()
            }
        }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        HostLocalization.text(key, locale: locale)
    }
}
