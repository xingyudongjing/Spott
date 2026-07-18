import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import UIKit

struct EventComposerView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    @State private var step = 0
    @State private var title = ""
    @State private var description = ""
    @State private var category = "city-walk"
    @State private var tags: [String] = []
    @State private var newTag = ""
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var photos: [ComposerPhoto] = []

    @State private var startsAt = Date.now.addingTimeInterval(86_400 * 7)
    @State private var endsAt = Date.now.addingTimeInterval(86_400 * 7 + 7_200)
    @State private var deadlineAt = Date.now.addingTimeInterval(86_400 * 6)
    @State private var region = "tokyo"
    @State private var publicArea = ""
    @State private var exactAddress = ""
    @State private var exactAddressVisibility = "confirmed"

    @State private var capacity = 12
    @State private var registrationMode = "automatic"
    @State private var waitlistEnabled = true
    @State private var attendeeRequirements = ""
    @State private var questions: [EventDraftInput.Question] = []
    @State private var newQuestion = ""
    @State private var newQuestionKind: RegistrationQuestionKind = .text
    @State private var newQuestionRequired = false
    @State private var newQuestionOptions = ""

    @State private var isFree = true
    @State private var amountText = ""
    @State private var collectorName = ""
    @State private var paymentMethod = ""
    @State private var paymentDeadlineText = ""
    @State private var refundPolicy = ""
    @State private var riskFlags: Set<String> = []
    @State private var riskNote = ""

    @State private var groups: [GroupSummary] = []
    @State private var groupID: UUID?
    @State private var checkinMode = "dynamic_qr"
    @State private var commentPermission = "participants"
    @State private var posterEnabled = true
    @State private var organizerContactDraft = EventComposerContactDraft()
    @State private var contactRecoveryBusy = false

    @State private var savedAt: Date?
    @State private var remoteDraft: EventSummary?
    @State private var busy = false
    @State private var error: UserFacingError?
    @State private var submitted = false
    @State private var boundSessionIdentity: EventComposerSessionIdentity?
    @State private var sessionGeneration: UInt64 = 0

    private let steps = ["内容", "时间地点", "报名", "费用风险", "社群互动", "预览"]

    var body: some View {
        Group {
            if EventComposerContactUITestFixture.isEnabled {
                if !canRenderCurrentDraft { secureDraftLoadingState }
                else { composer }
            } else if model.session == nil { signedOutState }
            else if model.session?.user.phoneVerified != true { phoneGate }
            else if !canRenderCurrentDraft { secureDraftLoadingState }
            else if submitted { submittedState }
            else { composer }
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .task(id: currentSessionTaskKey) {
            sessionGeneration &+= 1
            let generation = sessionGeneration
            await bindComposerToCurrentSession(generation: generation)
        }
        .onChange(of: photoItems) { _, items in
            let context = currentRequestContext
            Task { await loadPhotos(items, context: context) }
        }
    }

    private var currentSessionIdentity: EventComposerSessionIdentity? {
        if EventComposerContactUITestFixture.isEnabled {
            return EventComposerContactUITestFixture.identity
        }
        guard let session = model.session else { return nil }
        return EventComposerSessionIdentity(
            sessionID: session.sessionId,
            userID: session.user.id
        )
    }

    private var currentSessionTaskKey: String {
        if EventComposerContactUITestFixture.isEnabled {
            return "composer-contact-ui-fixture"
        }
        guard let session = model.session else { return "guest" }
        return "\(session.sessionId.uuidString)|\(session.user.id.uuidString)|\(session.user.phoneVerified)"
    }

    private var canRenderCurrentDraft: Bool {
        EventComposerSessionPresentation.canRenderSensitiveDraft(
            boundIdentity: boundSessionIdentity,
            currentIdentity: currentSessionIdentity
        )
    }

    private var secureDraftLoadingState: some View {
        VStack(spacing: 14) {
            ProgressView()
                .controlSize(.large)
            Text(EventComposerContactCopy(locale: locale).syncingTitle)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(SpottColor.muted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(SpottMetric.pageInset)
        .accessibilityIdentifier("event.composer.secure_session_loading")
    }

    private var signedOutState: some View {
        SpottStateCard(icon: "plus.circle", title: "登录后创建活动", message: "草稿会自动保存，并可在 Web 工作台继续编辑。", actionTitle: "登录") { model.presentedGate = .login }
            .padding(SpottMetric.pageInset)
    }

    private var phoneGate: some View {
        SpottStateCard(icon: "iphone.badge.checkmark", title: "先完成手机号验证", message: "发布活动属于高信任操作，验证后可获得首次奖励。", actionTitle: "继续验证") { model.presentedGate = .phoneVerification }
            .padding(SpottMetric.pageInset)
    }

    private var submittedState: some View {
        VStack(spacing: 18) {
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 48))
                .foregroundStyle(SpottColor.mint)
            Text("已提交审核").font(.system(size: 27, weight: .bold, design: .rounded))
            Text("审核结果、修改要求和发布状态会在 iOS 与 Web 同步。")
                .foregroundStyle(SpottColor.muted)
                .multilineTextAlignment(.center)
            Button("再创建一个") { reset() }.buttonStyle(PrimaryButtonStyle())
        }
        .padding(28)
    }

    private var composer: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                stepProgress
                stepFields
                if let savedAt {
                    Label("云端草稿 v\(remoteDraft?.version ?? 1) · \(savedAt.formatted(date: .omitted, time: .shortened)) 已同步", systemImage: "checkmark.icloud")
                        .font(.caption)
                        .foregroundStyle(SpottColor.mint)
                }
                if let error {
                    Label("\(error.message)（\(error.id)）", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(SpottColor.danger)
                }
                navigationControls
            }
            .padding(.horizontal, SpottMetric.pageInset)
            .padding(.top, 18)
            .padding(.bottom, 36)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("HOST ON SPOTT")
                .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                .tracking(1.6)
                .foregroundStyle(SpottColor.coral)
            Text("创建活动")
                .font(.system(size: 34, weight: .bold, design: .rounded))
                .tracking(-1.1)
            Text("六步完成，随时保存，Web 可以接着编辑。")
                .font(.subheadline)
                .foregroundStyle(SpottColor.muted)
            if model.session != nil, model.session?.user.phoneVerified == true, remoteDraft == nil {
                Label("正在建立云端草稿…", systemImage: "icloud.and.arrow.up")
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
            }
        }
    }

    private var stepProgress: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack(spacing: 6) {
                ForEach(steps.indices, id: \.self) { index in
                    Capsule()
                        .fill(index <= step ? SpottColor.twilight : Color.black.opacity(0.09))
                        .frame(height: 5)
                }
            }
            HStack {
                Text("第 \(step + 1) 步 / \(steps.count)")
                Spacer()
                Text(LocalizedStringKey(steps[step]))
                    .fontWeight(.semibold)
            }
            .font(.caption)
            .foregroundStyle(SpottColor.muted)
        }
        .padding(15)
        .spottGlassPanel(shape: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    @ViewBuilder private var stepFields: some View {
        switch step {
        case 0: contentStep
        case 1: placeStep
        case 2: registrationStep
        case 3: feeStep
        case 4: communityStep
        default: previewStep
        }
    }

    private var contentStep: some View {
        let photoCount = photos.count
        return VStack(spacing: 16) {
            ComposerSection(title: "封面与相册", subtitle: "1–6 张图片，第一张作为封面") {
                PhotosPicker(selection: $photoItems, maxSelectionCount: 6, matching: .images) {
                    Label(photoCount == 0 ? "选择图片" : "管理图片（\(photoCount) / 6）", systemImage: "photo.on.rectangle.angled")
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .background(Color.black.opacity(0.045), in: RoundedRectangle(cornerRadius: 14))
                        .overlay(RoundedRectangle(cornerRadius: 14).stroke(SpottColor.divider))
                }
                .buttonStyle(.plain)
                if !photos.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            ForEach(Array(photos.enumerated()), id: \.element.id) { index, photo in
                                ZStack(alignment: .topTrailing) {
                                    if let image = UIImage(data: photo.data) {
                                        Image(uiImage: image).resizable().scaledToFill().frame(width: 110, height: 92).clipped().clipShape(RoundedRectangle(cornerRadius: 13))
                                    }
                                    if index == 0 { Text("封面").font(.caption2.bold()).foregroundStyle(.white).padding(.horizontal, 7).padding(.vertical, 4).background(.black.opacity(0.45), in: Capsule()).padding(6) }
                                }
                            }
                        }
                    }
                }
            }
            ComposerSection(title: "让人一眼看懂", subtitle: "标题 4–40 字，说明 50–3000 字") {
                TextField("活动标题", text: $title).composerField()
                TextField("活动说明", text: $description, axis: .vertical).lineLimit(7...14).composerField()
                HStack { Spacer(); Text("\(description.count) / 3000").font(.caption).foregroundStyle(SpottColor.muted) }
            }
            ComposerSection(title: "分类与标签", subtitle: "一个主分类，最多 5 个标签") {
                Picker("主分类", selection: $category) {
                    Text("亲子").tag("family"); Text("户外").tag("outdoor"); Text("运动").tag("sports"); Text("城市探索").tag("city-walk"); Text("美食").tag("food"); Text("游戏").tag("games"); Text("文化艺术").tag("art"); Text("技能学习").tag("learning"); Text("职业交流").tag("networking")
                }
                .pickerStyle(.menu)
                HStack {
                    TextField("添加标签", text: $newTag).composerField()
                    Button("添加") { addTag() }.disabled(newTag.trimmingCharacters(in: .whitespaces).isEmpty || tags.count >= 5)
                }
                if !tags.isEmpty { FlowTags(tags: tags) { tag in tags.removeAll { $0 == tag } } }
            }
        }
    }

    private var placeStep: some View {
        VStack(spacing: 16) {
            ComposerSection(title: "时间", subtitle: "使用活动所在地时区展示") {
                DatePicker("开始", selection: $startsAt)
                DatePicker("结束", selection: $endsAt, in: startsAt...)
                DatePicker("报名截止", selection: $deadlineAt, in: Date.now...startsAt)
            }
            ComposerSection(title: "地点", subtitle: "公开范围与精确地址分开保存") {
                Picker("地区", selection: $region) { Text("东京").tag("tokyo"); Text("神奈川").tag("kanagawa"); Text("大阪").tag("osaka"); Text("京都").tag("kyoto") }
                TextField("公开集合范围，例如：代代木公园入口", text: $publicArea).composerField()
                TextField("精确地址", text: $exactAddress, axis: .vertical).lineLimit(2...5).composerField()
                Picker("精确地址可见范围", selection: $exactAddressVisibility) { Text("仅已确认参与者").tag("confirmed"); Text("公开显示").tag("public") }
                Text("默认只向已确认参与者返回精确地址，公开页面、候补和缓存都不会包含它。")
                    .font(.caption).foregroundStyle(SpottColor.muted)
            }
        }
    }

    private var registrationStep: some View {
        VStack(spacing: 16) {
            ComposerSection(title: "报名规则", subtitle: "支持自动确认、审核制和邀请制") {
                Stepper("人数上限：\(capacity)", value: $capacity, in: 2...500)
                Picker("确认方式", selection: $registrationMode) { Text("自动确认").tag("automatic"); Text("局头审核").tag("approval"); Text("仅限邀请").tag("invite_only") }
                Toggle("满员后开启候补", isOn: $waitlistEnabled)
                TextField("参与要求（可选）", text: $attendeeRequirements, axis: .vertical).lineLimit(3...8).composerField()
            }
            ComposerSection(title: "报名问题", subtitle: "最多 10 个；必填问题会在提交前校验") {
                ForEach(questions) { question in
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: question.required ? "asterisk.circle.fill" : questionIcon(question.kind))
                            .foregroundStyle(question.required ? SpottColor.coral : SpottColor.twilight)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(question.prompt).font(.subheadline.weight(.semibold))
                            HStack(spacing: 6) {
                                Text(questionKindTitle(question.kind))
                                if question.required { Text("必填") }
                                if !question.options.isEmpty { Text("\(question.options.count) 个选项") }
                            }
                            .font(.caption)
                            .foregroundStyle(SpottColor.muted)
                        }
                        Spacer()
                        Button(role: .destructive) {
                            questions.removeAll { $0.id == question.id }
                        } label: {
                            Image(systemName: "trash")
                        }
                    }
                    .padding(.vertical, 4)
                }
                Divider()
                TextField("例如：为什么想参加？", text: $newQuestion, axis: .vertical)
                    .lineLimit(2...5)
                    .composerField()
                Picker("回答方式", selection: $newQuestionKind) {
                    Text("文字").tag(RegistrationQuestionKind.text)
                    Text("单选").tag(RegistrationQuestionKind.singleChoice)
                    Text("是 / 否").tag(RegistrationQuestionKind.boolean)
                }
                .pickerStyle(.segmented)
                if newQuestionKind == .singleChoice {
                    TextField("选项，用换行或逗号分隔（2–12 个）", text: $newQuestionOptions, axis: .vertical)
                        .lineLimit(2...6)
                        .composerField()
                }
                Toggle("参与者必须回答", isOn: $newQuestionRequired)
                Button("添加问题") { addQuestion() }
                    .buttonStyle(.borderedProminent)
                    .tint(SpottColor.ink)
                    .disabled(!canAddQuestion)
            }
        }
    }

    private var feeStep: some View {
        VStack(spacing: 16) {
            ComposerSection(title: "活动费用", subtitle: "活动费由局头在 App 外自行收取，Spott 不经手") {
                Toggle("免费活动", isOn: $isFree)
                if !isFree {
                    TextField("金额（日元）", text: $amountText).keyboardType(.numberPad).composerField()
                    TextField("收款主体", text: $collectorName).composerField()
                    TextField("收款方式", text: $paymentMethod).composerField()
                    TextField("付款期限", text: $paymentDeadlineText).composerField()
                    TextField("退款规则", text: $refundPolicy, axis: .vertical).lineLimit(4...10).composerField()
                }
            }
            ComposerSection(title: "风险披露", subtitle: "命中高风险项会进入人工审核，不代表一定拒绝") {
                ForEach(riskOptions, id: \.0) { value, title in
                    Toggle(title, isOn: Binding(get: { riskFlags.contains(value) }, set: { enabled in if enabled { riskFlags.insert(value) } else { riskFlags.remove(value) } }))
                }
                if !riskFlags.isEmpty { TextField("说明风险与对应保护措施", text: $riskNote, axis: .vertical).lineLimit(4...10).composerField() }
            }
        }
    }

    private var communityStep: some View {
        VStack(spacing: 16) {
            ComposerSection(title: "关联社群", subtitle: "可选；活动会显示在社群主页") {
                Picker("社群", selection: $groupID) {
                    Text("不关联社群").tag(UUID?.none)
                    ForEach(groups) { group in Text(group.name).tag(Optional(group.id)) }
                }
            }
            ComposerSection(title: "现场签到", subtitle: "动态二维码最安全，也支持 6 位码与人工确认") {
                Picker("签到方式", selection: $checkinMode) { Text("动态二维码").tag("dynamic_qr"); Text("6 位签到码").tag("six_digit"); Text("人工签到").tag("manual") }
                .pickerStyle(.segmented)
            }
            ComposerSection(title: "活动互动", subtitle: "评论只在有关系的范围开放") {
                Picker("评论权限", selection: $commentPermission) { Text("关闭评论").tag("disabled"); Text("仅参与者").tag("participants"); Text("仅社群成员").tag("group_members") }
                Toggle("审核通过后生成分享海报", isOn: $posterEnabled)
            }
            EventComposerContactEditor(
                draft: $organizerContactDraft,
                locale: locale,
                isEditingDisabled: busy || contactRecoveryBusy,
                isRecovering: contactRecoveryBusy,
                onRetryRecovery: retryContactRecovery
            )
        }
    }

    private var previewStep: some View {
        VStack(spacing: 16) {
            ComposerSection(title: "提交前预览", subtitle: "系统会再次检查完整性、风险词和积分余额") {
                PreviewRow(title: "活动", value: title.isEmpty ? "未填写" : title)
                PreviewRow(title: "图片", value: "\(photos.count) 张")
                PreviewRow(title: "时间", value: startsAt.formatted(date: .abbreviated, time: .shortened))
                PreviewRow(title: "地点", value: publicArea.isEmpty ? "未填写" : publicArea)
                PreviewRow(title: "人数", value: "\(capacity)")
                PreviewRow(title: "确认", value: registrationModeTitle)
                PreviewRow(title: "费用", value: isFree ? "免费" : "¥\(amountText)")
                PreviewRow(
                    title: EventComposerContactCopy(locale: locale).title,
                    value: contactPreviewValue
                )
                PreviewRow(title: "发布积分", value: "100（提交时冻结）")
            }
            SurfaceCard {
                VStack(alignment: .leading, spacing: 10) {
                    Label("提交后的处理", systemImage: "shield.checkered")
                        .font(.headline)
                    Text("普通活动自动审核并抽样复核；酒精、夜间、未成年人、投资等风险活动进入人工审核。拒绝或审核前撤回会释放冻结积分。")
                        .font(.subheadline).foregroundStyle(SpottColor.muted).lineSpacing(4)
                }
            }
        }
    }

    private var navigationControls: some View {
        HStack(spacing: 12) {
            if step > 0 {
                Button("上一步") { withAnimation(.snappy) { step -= 1 } }
                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                    .frame(width: 96)
                    .frame(minHeight: 54)
                    .spottGlassPanel(shape: RoundedRectangle(cornerRadius: 16))
            }
            Button {
                advance()
            } label: {
                if busy { ProgressView().tint(.white).frame(maxWidth: .infinity) }
                else { Text(step == steps.count - 1 ? "确认并提交" : "保存并继续").frame(maxWidth: .infinity) }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(busy)
        }
    }

    private var draftInput: EventDraftInput {
        .init(
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            description: description.trimmingCharacters(in: .whitespacesAndNewlines),
            categoryId: category,
            startsAt: startsAt,
            endsAt: endsAt,
            deadlineAt: deadlineAt,
            regionId: region,
            publicArea: publicArea,
            exactAddress: exactAddress,
            capacity: capacity,
            registrationMode: registrationMode,
            waitlistEnabled: waitlistEnabled,
            fee: .init(
                isFree: isFree,
                amountJPY: isFree ? nil : Int(amountText),
                collectorName: isFree ? nil : collectorName,
                method: isFree ? nil : paymentMethod,
                paymentDeadlineText: isFree ? nil : paymentDeadlineText,
                refundPolicy: isFree ? nil : refundPolicy
            ),
            tags: Array(([category] + tags).prefix(5)),
            attendeeRequirements: attendeeRequirements.nilIfBlank,
            riskFlags: Array(riskFlags).sorted(),
            riskDetails: riskFlags.isEmpty ? [:] : Dictionary(uniqueKeysWithValues: riskFlags.map { ($0, riskNote) }),
            groupId: groupID,
            checkinMode: checkinMode,
            commentPermission: commentPermission,
            posterEnabled: posterEnabled,
            exactAddressVisibility: exactAddressVisibility,
            registrationQuestions: questions,
            organizerContact: organizerContactDraft.contactForDraftSave()
        )
    }

    private func advance() {
        guard let context = currentRequestContext,
              requestStillCurrent(context) else { return }
        if let validation = validationError(for: step) { error = validation; return }
        let contactPayload = organizerContactDraft.contactForDraftSave()
        let input = draftInput
        busy = true; error = nil
        Task {
            defer {
                if requestStillCurrent(context) {
                    busy = false
                }
            }
            do {
                guard requestStillCurrent(context) else { return }
                var draft: EventSummary
                if let existingDraft = remoteDraft {
                    let response = try await model.api.updateEventDraft(
                        id: existingDraft.id,
                        version: existingDraft.version,
                        draft: input
                    )
                    try requireExpectedDraftResponse(
                        response,
                        expectedID: existingDraft.id,
                        expectedOrganizerID: context.identity.userID
                    )
                    draft = response
                } else {
                    let response = try await model.api.createEventDraft(input)
                    try requireExpectedDraftResponse(
                        response,
                        expectedID: nil,
                        expectedOrganizerID: context.identity.userID
                    )
                    draft = response
                }
                guard requestStillCurrent(context) else { return }
                guard organizerContactDraft.reconcileAuthorizedResponse(
                    draft,
                    expectedContact: contactPayload != nil
                ) else {
                    throw EventComposerContactError.authorizedContactUnavailable
                }
                remoteDraft = draft
                if step == 0 {
                    for index in photos.indices where photos[index].assetID == nil {
                        let id = try await model.api.uploadEventImage(data: photos[index].data, filename: photos[index].filename, mimeType: photos[index].mimeType, eventID: draft.id, sortOrder: index)
                        guard requestStillCurrent(context) else { return }
                        photos[index].assetID = id
                    }
                    let refreshed = try? await model.api.event(
                        identifier: draft.id.uuidString.lowercased()
                    )
                    guard optionalResponseStillCurrent(
                        refreshed,
                        context: context
                    ) else { return }
                    if let refreshed {
                        try requireExpectedDraftResponse(
                            refreshed,
                            expectedID: draft.id,
                            expectedOrganizerID: context.identity.userID
                        )
                        draft = refreshed
                        guard organizerContactDraft.reconcileAuthorizedResponse(
                            refreshed,
                            expectedContact: contactPayload != nil
                        ) else {
                            throw EventComposerContactError.authorizedContactUnavailable
                        }
                        remoteDraft = refreshed
                    }
                }
                reconcileQuestions(from: draft)
                savedAt = .now
                if step < steps.count - 1 {
                    withAnimation(.snappy) { step += 1 }
                } else {
                    _ = try organizerContactDraft.contactForSubmission()
                    let quote = try await model.api.quote(purpose: "event_publish", resourceID: draft.id)
                    guard requestStillCurrent(context) else { return }
                    let submittedEvent = try await model.api.submitEvent(
                        id: draft.id,
                        version: draft.version,
                        quoteID: quote.id
                    )
                    guard requestStillCurrent(context) else { return }
                    try requireExpectedDraftResponse(
                        submittedEvent,
                        expectedID: draft.id,
                        expectedOrganizerID: context.identity.userID
                    )
                    guard organizerContactDraft.reconcileAuthorizedResponse(
                        submittedEvent,
                        expectedContact: true
                    ) else {
                        throw EventComposerContactError.authorizedContactUnavailable
                    }
                    remoteDraft = submittedEvent
                    model.trackAnalytics(.eventSubmissionCompleted(
                        eventID: submittedEvent.id,
                        status: submittedEvent.status,
                        category: category,
                        posterEnabled: posterEnabled
                    ))
                    submitted = true
                }
            } catch let contactError as EventComposerContactError {
                guard requestStillCurrent(context) else { return }
                self.error = contactUserFacingError(contactError)
            } catch {
                guard requestStillCurrent(context) else { return }
                self.error = AppModel.map(error)
            }
        }
    }

    private func validationError(for step: Int) -> UserFacingError? {
        func invalid(_ message: String) -> UserFacingError { .init(id: "DRAFT_STEP_INVALID", message: message, retryable: false) }
        switch step {
        case 0:
            if photos.isEmpty { return invalid("请至少选择 1 张活动图片。") }
            if !(4...40).contains(title.trimmingCharacters(in: .whitespaces).count) { return invalid("活动标题需要 4–40 个字符。") }
            if !(50...3000).contains(description.trimmingCharacters(in: .whitespacesAndNewlines).count) { return invalid("活动说明需要 50–3000 个字符。") }
        case 1:
            if endsAt <= startsAt { return invalid("结束时间必须晚于开始时间。") }
            if deadlineAt > startsAt { return invalid("报名截止时间不能晚于活动开始时间。") }
            if publicArea.trimmingCharacters(in: .whitespaces).isEmpty || exactAddress.trimmingCharacters(in: .whitespaces).isEmpty { return invalid("请填写公开集合范围与精确地址。") }
        case 2:
            if capacity < 2 { return invalid("活动人数至少为 2 人。") }
        case 3:
            if !isFree && (Int(amountText) ?? 0) <= 0 { return invalid("请填写有效的活动费用。") }
            if !isFree && (collectorName.nilIfBlank == nil || refundPolicy.nilIfBlank == nil) { return invalid("收费活动必须填写收款主体与退款规则。") }
            if !riskFlags.isEmpty && riskNote.trimmingCharacters(in: .whitespacesAndNewlines).count < 10 { return invalid("请说明风险与对应保护措施。") }
        case 4, 5:
            do {
                _ = try organizerContactDraft.contactForSubmission()
            } catch let contactError as EventComposerContactError {
                return contactUserFacingError(contactError)
            } catch {
                return contactUserFacingError(.invalid)
            }
        default: break
        }
        return nil
    }

    private func loadPhotos(
        _ items: [PhotosPickerItem],
        context: EventComposerRequestContext?
    ) async {
        guard let context, requestStillCurrent(context) else { return }
        var loaded: [ComposerPhoto] = []
        for (index, item) in items.prefix(6).enumerated() {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            guard requestStillCurrent(context) else { return }
            let type = item.supportedContentTypes.first ?? .jpeg
            loaded.append(.init(data: data, mimeType: type.preferredMIMEType ?? "image/jpeg", filename: "spott-event-\(index + 1).\(type.preferredFilenameExtension ?? "jpg")"))
        }
        guard requestStillCurrent(context) else { return }
        photos = loaded
    }

    private func addTag() {
        let value = newTag.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, tags.count < 5, !tags.contains(value) else { return }
        tags.append(value); newTag = ""
    }
    private func addQuestion() {
        let value = newQuestion.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canAddQuestion else { return }
        questions.append(
            .init(
                prompt: value,
                kind: newQuestionKind.rawValue,
                required: newQuestionRequired,
                options: newQuestionKind == .singleChoice ? parsedQuestionOptions : []
            )
        )
        newQuestion = ""
        newQuestionKind = .text
        newQuestionRequired = false
        newQuestionOptions = ""
    }

    private var parsedQuestionOptions: [String] {
        newQuestionOptions
            .components(separatedBy: CharacterSet(charactersIn: ",，\n"))
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .reduce(into: [String]()) { values, value in
                if !values.contains(value), values.count < 12 { values.append(value) }
            }
    }

    private var canAddQuestion: Bool {
        let prompt = newQuestion.trimmingCharacters(in: .whitespacesAndNewlines)
        return !prompt.isEmpty
            && prompt.count <= 240
            && questions.count < 10
            && (newQuestionKind != .singleChoice || parsedQuestionOptions.count >= 2)
    }

    private func questionKindTitle(_ kind: String) -> LocalizedStringKey {
        switch kind {
        case RegistrationQuestionKind.singleChoice.rawValue: "单选"
        case RegistrationQuestionKind.boolean.rawValue: "是 / 否"
        default: "文字"
        }
    }

    private func questionIcon(_ kind: String) -> String {
        switch kind {
        case RegistrationQuestionKind.singleChoice.rawValue: "list.bullet.circle"
        case RegistrationQuestionKind.boolean.rawValue: "checkmark.circle"
        default: "text.bubble"
        }
    }

    private func bindComposerToCurrentSession(generation: UInt64) async {
        if EventComposerContactUITestFixture.isEnabled {
            let identity = EventComposerContactUITestFixture.identity
            if boundSessionIdentity != identity {
                resetDraftFields()
                groups = []
                step = 4
                organizerContactDraft.updateKind(.line)
                organizerContactDraft.updateLabel("当日 LINE")
                organizerContactDraft.updateValue("spott_host")
                boundSessionIdentity = identity
            }
            return
        }

        guard let identity = currentSessionIdentity,
              model.session?.user.phoneVerified == true else {
            resetDraftFields()
            groups = []
            boundSessionIdentity = nil
            return
        }

        if boundSessionIdentity != identity {
            resetDraftFields()
            groups = []
            boundSessionIdentity = identity
        }
        let context = EventComposerRequestContext(
            identity: identity,
            generation: generation
        )
        guard requestStillCurrent(context) else { return }

        let loadedGroups = (try? await model.api.groups().items) ?? []
        guard requestStillCurrent(context) else { return }
        groups = loadedGroups
        await ensureCloudDraft(for: context)
    }

    private func ensureCloudDraft(
        for context: EventComposerRequestContext
    ) async {
        guard requestStillCurrent(context),
              model.session?.user.phoneVerified == true,
              remoteDraft == nil else { return }
        do {
            let draft = try await model.api.createBlankEventDraft()
            guard requestStillCurrent(context) else { return }
            try requireExpectedDraftResponse(
                draft,
                expectedID: nil,
                expectedOrganizerID: context.identity.userID
            )
            guard organizerContactDraft.reconcileAuthorizedResponse(
                draft,
                expectedContact: false
            ) else {
                error = contactUserFacingError(.authorizedContactUnavailable)
                return
            }
            remoteDraft = draft
            savedAt = .now
            error = nil
        } catch {
            guard requestStillCurrent(context) else { return }
            self.error = AppModel.map(error)
        }
    }

    private func reconcileQuestions(from event: EventSummary) {
        guard let serverQuestions = event.registrationQuestions else { return }
        questions = serverQuestions.map {
            .init(
                id: $0.id,
                prompt: $0.prompt,
                kind: $0.kind.rawValue,
                required: $0.required,
                options: $0.options
            )
        }
    }

    private func retryContactRecovery() {
        guard let context = currentRequestContext,
              requestStillCurrent(context),
              let remoteDraft,
              !contactRecoveryBusy else { return }
        contactRecoveryBusy = true
        Task {
            defer {
                if requestStillCurrent(context) {
                    contactRecoveryBusy = false
                }
            }
            do {
                let refreshed = try await model.api.event(
                    identifier: remoteDraft.id.uuidString.lowercased()
                )
                guard requestStillCurrent(context) else { return }
                try requireExpectedDraftResponse(
                    refreshed,
                    expectedID: remoteDraft.id,
                    expectedOrganizerID: context.identity.userID
                )
                guard organizerContactDraft.reconcileAuthorizedResponse(
                    refreshed,
                    expectedContact: false
                ) else {
                    error = contactUserFacingError(.authorizedContactUnavailable)
                    return
                }
                self.remoteDraft = refreshed
                error = nil
                savedAt = .now
            } catch {
                guard requestStillCurrent(context) else { return }
                self.error = AppModel.map(error)
            }
        }
    }

    private var contactPreviewValue: String {
        let copy = EventComposerContactCopy(locale: locale)
        guard let contact = organizerContactDraft.contactForDraftSave() else {
            return copy.missingMessage
        }
        let label = contact.label ?? copy.title(for: contact.kind)
        return "\(label) · \(contact.value)"
    }

    private func contactUserFacingError(
        _ error: EventComposerContactError
    ) -> UserFacingError {
        let copy = EventComposerContactCopy(locale: locale)
        switch error {
        case .missing:
            return .init(
                id: "DRAFT_CONTACT_REQUIRED",
                message: copy.missingMessage,
                retryable: false
            )
        case .invalid:
            return .init(
                id: "DRAFT_CONTACT_INVALID",
                message: copy.invalidMessage,
                retryable: false
            )
        case .authorizedContactUnavailable:
            return .init(
                id: "DRAFT_CONTACT_RESTORE_REQUIRED",
                message: copy.recoveryFailedMessage,
                retryable: true
            )
        }
    }
    private var registrationModeTitle: String { switch registrationMode { case "approval": "局头审核"; case "invite_only": "仅限邀请"; default: "自动确认" } }
    private var riskOptions: [(String, String)] { [("alcohol", "包含酒精"), ("late_night", "深夜时段"), ("family", "亲子活动"), ("minors", "涉及未成年人"), ("outdoor", "户外活动"), ("mountain", "山地活动"), ("water", "涉水活动"), ("high_fee", "高额费用"), ("career", "职业招募"), ("investment", "投资相关"), ("gender_limited", "性别限制")] }

    private var currentRequestContext: EventComposerRequestContext? {
        guard let identity = currentSessionIdentity else { return nil }
        return EventComposerRequestContext(
            identity: identity,
            generation: sessionGeneration
        )
    }

    private func requestStillCurrent(
        _ context: EventComposerRequestContext
    ) -> Bool {
        EventComposerSessionPresentation.canAcceptResponse(
            context,
            boundIdentity: boundSessionIdentity,
            currentIdentity: currentSessionIdentity,
            currentGeneration: sessionGeneration
        )
    }

    private func optionalResponseStillCurrent<Response>(
        _ response: Response?,
        context: EventComposerRequestContext
    ) -> Bool {
        EventComposerOptionalResponsePolicy.canContinue(
            after: response,
            context: context,
            boundIdentity: boundSessionIdentity,
            currentIdentity: currentSessionIdentity,
            currentGeneration: sessionGeneration
        )
    }

    private func requireExpectedDraftResponse(
        _ event: EventSummary,
        expectedID: UUID?,
        expectedOrganizerID: UUID
    ) throws {
        guard EventComposerDraftResponsePolicy.accepts(
            event,
            expectedID: expectedID,
            expectedOrganizerID: expectedOrganizerID
        ) else {
            throw APIError(
                status: 409,
                code: "DRAFT_RESPONSE_MISMATCH",
                message: "The server returned another event resource.",
                retryable: true
            )
        }
    }

    private func reset() {
        resetDraftFields()
        if let context = currentRequestContext,
           requestStillCurrent(context) {
            Task { await ensureCloudDraft(for: context) }
        }
    }

    private func resetDraftFields() {
        let start = Date.now.addingTimeInterval(86_400 * 7)
        step = 0
        title = ""
        description = ""
        category = "city-walk"
        tags = []
        newTag = ""
        photoItems = []
        photos = []
        startsAt = start
        endsAt = start.addingTimeInterval(7_200)
        deadlineAt = start.addingTimeInterval(-86_400)
        region = "tokyo"
        publicArea = ""
        exactAddress = ""
        exactAddressVisibility = "confirmed"
        capacity = 12
        registrationMode = "automatic"
        waitlistEnabled = true
        attendeeRequirements = ""
        questions = []
        newQuestion = ""
        newQuestionKind = .text
        newQuestionRequired = false
        newQuestionOptions = ""
        isFree = true
        amountText = ""
        collectorName = ""
        paymentMethod = ""
        paymentDeadlineText = ""
        refundPolicy = ""
        riskFlags = []
        riskNote = ""
        groupID = nil
        checkinMode = "dynamic_qr"
        commentPermission = "participants"
        posterEnabled = true
        organizerContactDraft = EventComposerContactDraft()
        contactRecoveryBusy = false
        remoteDraft = nil
        savedAt = nil
        busy = false
        submitted = false
        error = nil
    }
}

private struct ComposerPhoto: Identifiable {
    let id = UUID()
    let data: Data
    let mimeType: String
    let filename: String
    var assetID: UUID?
}

private struct ComposerSection<Content: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            VStack(alignment: .leading, spacing: 4) {
                Text(LocalizedStringKey(title)).font(.system(size: 18, weight: .bold, design: .rounded))
                Text(LocalizedStringKey(subtitle)).font(.caption).foregroundStyle(SpottColor.muted)
            }
            content
        }
        .padding(18)
        .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: SpottMetric.cardRadius).stroke(SpottColor.divider))
    }
}

private extension View {
    func composerField() -> some View {
        self
            .font(.system(size: 15, design: .rounded))
            .padding(.horizontal, 13)
            .padding(.vertical, 12)
            .background(Color.black.opacity(0.045), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
    }
}

private struct PreviewRow: View {
    let title: String
    let value: String
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(LocalizedStringKey(title)).foregroundStyle(SpottColor.muted)
            Spacer()
            Text(value).fontWeight(.semibold).multilineTextAlignment(.trailing)
        }
        .font(.subheadline)
    }
}

private struct FlowTags: View {
    let tags: [String]
    let remove: (String) -> Void
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 7) {
                ForEach(tags, id: \.self) { tag in
                    Button { remove(tag) } label: {
                        HStack(spacing: 5) { Text(tag); Image(systemName: "xmark").font(.caption2.bold()) }
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 10).padding(.vertical, 7)
                            .background(SpottColor.twilightPale, in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

private extension String {
    var nilIfBlank: String? { trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : self }
}
