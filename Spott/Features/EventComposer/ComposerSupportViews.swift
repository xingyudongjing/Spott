import SwiftUI
import UniformTypeIdentifiers

struct ComposerPhoto: Identifiable, Equatable {
    let id = UUID()
    let data: Data
    let mimeType: String
    let filename: String
    var assetID: UUID?
}

struct ComposerSection<Content: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.system(size: 18, weight: .bold, design: .rounded))
                Text(subtitle).font(.caption).foregroundStyle(SpottColor.muted)
            }
            content
        }
        .padding(18)
        .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: SpottMetric.cardRadius).stroke(SpottColor.divider))
    }
}

extension View {
    func composerField() -> some View {
        self
            .font(.system(size: 15, design: .rounded))
            .padding(.horizontal, 13)
            .padding(.vertical, 12)
            .background(SpottColor.ink.opacity(0.045), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
    }
}

struct ComposerPreviewRow: View {
    let title: String
    let value: String
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).foregroundStyle(SpottColor.muted)
            Spacer()
            Text(value).fontWeight(.semibold).multilineTextAlignment(.trailing)
        }
        .font(.subheadline)
    }
}

struct ComposerFlowTags: View {
    let tags: [String]
    let removeLabel: (String) -> String
    let remove: (String) -> Void
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 7) {
                ForEach(tags, id: \.self) { tag in
                    Button { remove(tag) } label: {
                        HStack(spacing: 5) { Text(tag); Image(systemName: "xmark").font(.caption2.bold()) }
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 10).padding(.vertical, 7)
                            .frame(minHeight: 32)
                            .background(SpottColor.twilightPale, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(removeLabel(tag))
                }
            }
        }
    }
}

struct ComposerPhotoGrid: View {
    @Binding var photos: [ComposerPhoto]
    let locked: Bool
    let locale: Locale
    @State private var draggingID: UUID?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var columns: [GridItem] {
        [GridItem(.adaptive(minimum: 100), spacing: 10)]
    }

    var body: some View {
        LazyVGrid(columns: columns, spacing: 10) {
            ForEach(Array(photos.enumerated()), id: \.element.id) { index, photo in
                cell(photo: photo, index: index)
            }
        }
        .animation(reduceMotion ? nil : SpottMotion.standard, value: photos.map(\.id))
    }

    @ViewBuilder
    private func cell(photo: ComposerPhoto, index: Int) -> some View {
        let base = ZStack(alignment: .topLeading) {
            if let image = UIImage(data: photo.data) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(minWidth: 0, maxWidth: .infinity)
                    .frame(height: 92)
                    .clipped()
                    .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
            } else {
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .fill(SpottColor.twilightPale)
                    .frame(height: 92)
            }
            if index == 0 {
                Text(text("composer.photos.cover_badge"))
                    .font(.caption2.bold())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 4)
                    .background(.black.opacity(0.45), in: Capsule())
                    .padding(6)
            }
        }
        .overlay(alignment: .topTrailing) {
            if !locked {
                Button {
                    remove(photo)
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title3)
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(.white, .black.opacity(0.55))
                        .frame(width: 44, height: 44, alignment: .topTrailing)
                        .padding(.top, 2)
                        .padding(.trailing, 2)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(text("composer.photos.remove"))
            }
        }
        .opacity(draggingID == photo.id ? 0.55 : 1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel(index: index))

        if locked {
            base
        } else {
            base
                .onDrag {
                    draggingID = photo.id
                    return NSItemProvider(object: photo.id.uuidString as NSString)
                }
                .onDrop(
                    of: [.text],
                    delegate: ComposerPhotoDropDelegate(
                        item: photo,
                        photos: $photos,
                        draggingID: $draggingID,
                        animated: !reduceMotion
                    )
                )
                .contextMenu {
                    if index > 0 {
                        Button(text("composer.photos.make_cover"), systemImage: "star") {
                            move(photo, to: 0)
                        }
                        Button(text("composer.photos.move_forward"), systemImage: "arrow.left") {
                            move(photo, to: index - 1)
                        }
                    }
                    if index < photos.count - 1 {
                        Button(text("composer.photos.move_backward"), systemImage: "arrow.right") {
                            move(photo, to: index + 1)
                        }
                    }
                    Button(text("composer.photos.remove"), systemImage: "trash", role: .destructive) {
                        remove(photo)
                    }
                }
                .accessibilityActions {
                    if index > 0 {
                        Button(text("composer.photos.make_cover")) { move(photo, to: 0) }
                        Button(text("composer.photos.move_forward")) { move(photo, to: index - 1) }
                    }
                    if index < photos.count - 1 {
                        Button(text("composer.photos.move_backward")) { move(photo, to: index + 1) }
                    }
                    Button(text("composer.photos.remove")) { remove(photo) }
                }
        }
    }

    private func accessibilityLabel(index: Int) -> String {
        index == 0
            ? ComposerLocalization.format("composer.photos.accessibility_cover", locale: locale, index + 1)
            : ComposerLocalization.format("composer.photos.accessibility_item", locale: locale, index + 1, photos.count)
    }

    private func remove(_ photo: ComposerPhoto) {
        guard !locked else { return }
        if reduceMotion {
            photos.removeAll { $0.id == photo.id }
        } else {
            withAnimation(SpottMotion.standard) {
                photos.removeAll { $0.id == photo.id }
            }
        }
    }

    private func move(_ photo: ComposerPhoto, to target: Int) {
        guard !locked,
              let source = photos.firstIndex(where: { $0.id == photo.id }),
              (0..<photos.count).contains(target),
              source != target else { return }
        let apply = {
            let value = photos.remove(at: source)
            photos.insert(value, at: target)
        }
        if reduceMotion { apply() } else { withAnimation(SpottMotion.standard, apply) }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        ComposerLocalization.text(key, locale: locale)
    }
}

private struct ComposerPhotoDropDelegate: DropDelegate {
    let item: ComposerPhoto
    @Binding var photos: [ComposerPhoto]
    @Binding var draggingID: UUID?
    let animated: Bool

    func dropEntered(info: DropInfo) {
        guard let draggingID,
              draggingID != item.id,
              let source = photos.firstIndex(where: { $0.id == draggingID }),
              let target = photos.firstIndex(where: { $0.id == item.id }) else { return }
        let apply = {
            photos.move(
                fromOffsets: IndexSet(integer: source),
                toOffset: target > source ? target + 1 : target
            )
        }
        if animated { withAnimation(SpottMotion.standard, apply) } else { apply() }
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        DropProposal(operation: .move)
    }

    func performDrop(info: DropInfo) -> Bool {
        draggingID = nil
        return true
    }
}

struct ComposerQuestionRow: View {
    let question: EventDraftInput.Question
    let index: Int
    let count: Int
    let isEditing: Bool
    let locale: Locale
    let onEdit: () -> Void
    let onMoveUp: () -> Void
    let onMoveDown: () -> Void
    let onDelete: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: question.required ? "asterisk.circle.fill" : icon)
                .foregroundStyle(question.required ? SpottColor.coral : SpottColor.twilight)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                Text(question.prompt).font(.subheadline.weight(.semibold))
                HStack(spacing: 6) {
                    Text(kindTitle)
                    if question.required { Text(text("composer.questions.required_tag")) }
                    if !question.options.isEmpty {
                        Text(ComposerLocalization.format("composer.questions.option_count", locale: locale, question.options.count))
                    }
                }
                .font(.caption)
                .foregroundStyle(SpottColor.muted)
            }
            Spacer()
            HStack(spacing: 2) {
                Button { onMoveUp() } label: {
                    Image(systemName: "chevron.up")
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .disabled(index == 0)
                .accessibilityLabel(text("composer.questions.move_up"))

                Button { onMoveDown() } label: {
                    Image(systemName: "chevron.down")
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .disabled(index == count - 1)
                .accessibilityLabel(text("composer.questions.move_down"))

                Button { onEdit() } label: {
                    Image(systemName: isEditing ? "pencil.circle.fill" : "pencil")
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel(text("composer.questions.edit"))

                Button(role: .destructive) { onDelete() } label: {
                    Image(systemName: "trash")
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel(text("composer.questions.delete"))
            }
            .font(.footnote.weight(.semibold))
            .buttonStyle(.plain)
            .foregroundStyle(SpottColor.twilight)
        }
        .padding(.vertical, 4)
        .background(isEditing ? SpottColor.twilightPale.opacity(0.5) : .clear, in: RoundedRectangle(cornerRadius: 10))
    }

    private var kindTitle: String {
        switch question.kind {
        case RegistrationQuestionKind.singleChoice.rawValue: text("composer.questions.kind_single_choice")
        case RegistrationQuestionKind.boolean.rawValue: text("composer.questions.kind_boolean")
        default: text("composer.questions.kind_text")
        }
    }

    private var icon: String {
        switch question.kind {
        case RegistrationQuestionKind.singleChoice.rawValue: "list.bullet.circle"
        case RegistrationQuestionKind.boolean.rawValue: "checkmark.circle"
        default: "text.bubble"
        }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        ComposerLocalization.text(key, locale: locale)
    }
}
