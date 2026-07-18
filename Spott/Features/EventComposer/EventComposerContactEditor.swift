import SwiftUI
import UIKit

struct EventComposerContactEditor: View {
    @Binding var draft: EventComposerContactDraft
    let locale: Locale
    let isEditingDisabled: Bool
    let isRecovering: Bool
    let onRetryRecovery: () -> Void

    @FocusState private var focusedField: Field?

    private enum Field: Hashable {
        case label
        case value
    }

    private var copy: EventComposerContactCopy {
        EventComposerContactCopy(locale: locale)
    }

    private var kindBinding: Binding<OrganizerContact.Kind> {
        Binding(
            get: { draft.kind },
            set: { draft.updateKind($0) }
        )
    }

    private var labelBinding: Binding<String> {
        Binding(
            get: { draft.label },
            set: { draft.updateLabel($0) }
        )
    }

    private var valueBinding: Binding<String> {
        Binding(
            get: { draft.value },
            set: { draft.updateValue($0) }
        )
    }

    @ViewBuilder
    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: 12) {
                editorContent
                    .padding(18)
                    .glassEffect(
                        .regular.tint(SpottColor.twilight.opacity(0.055)),
                        in: .rect(cornerRadius: SpottMetric.cardRadius)
                    )
            }
        } else {
            editorContent
                .padding(18)
                .background(
                    .ultraThinMaterial,
                    in: RoundedRectangle(
                        cornerRadius: SpottMetric.cardRadius,
                        style: .continuous
                    )
                )
                .overlay(
                    RoundedRectangle(cornerRadius: SpottMetric.cardRadius)
                        .stroke(SpottColor.divider)
                )
        }
    }

    private var editorContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            kindPicker

            VStack(alignment: .leading, spacing: 7) {
                Text(copy.labelTitle)
                    .font(.subheadline.weight(.semibold))
                TextField(copy.labelPlaceholder, text: labelBinding)
                    .textInputAutocapitalization(.sentences)
                    .submitLabel(.next)
                    .focused($focusedField, equals: .label)
                    .onSubmit { focusedField = .value }
                    .composerContactFieldSurface()
                    .disabled(isEditingDisabled)
                    .accessibilityLabel(copy.labelTitle)
                    .accessibilityIdentifier("event.composer.contact.label")
            }

            VStack(alignment: .leading, spacing: 7) {
                Text(copy.valueTitle)
                    .font(.subheadline.weight(.semibold))
                TextField(copy.placeholder(for: draft.kind), text: valueBinding)
                    .keyboardType(keyboardType)
                    .textContentType(textContentType)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .focused($focusedField, equals: .value)
                    .composerContactFieldSurface()
                    .disabled(isEditingDisabled)
                    .accessibilityLabel(
                        "\(copy.title(for: draft.kind)), \(copy.valueTitle)"
                    )
                    .accessibilityHint(copy.privacyMessage)
                    .accessibilityIdentifier("event.composer.contact.value")
            }

            statusContent

            Label(copy.privacyMessage, systemImage: "lock.shield.fill")
                .font(.footnote)
                .foregroundStyle(SpottColor.muted)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("event.composer.contact.privacy")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("event.composer.contact.editor")
    }

    private var header: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 12) {
                headerIcon
                headerText
                Spacer(minLength: 0)
                validityBadge
            }
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    headerIcon
                    validityBadge
                }
                headerText
            }
        }
    }

    private var headerIcon: some View {
        Image(systemName: "person.crop.circle.badge.checkmark")
            .font(.system(size: 21, weight: .semibold))
            .foregroundStyle(SpottColor.twilight)
            .frame(width: 44, height: 44)
            .background(SpottColor.twilightPale, in: Circle())
            .accessibilityHidden(true)
    }

    private var headerText: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(copy.title)
                .font(.system(.headline, design: .rounded, weight: .bold))
                .fixedSize(horizontal: false, vertical: true)
            Text(copy.subtitle)
                .font(.footnote)
                .foregroundStyle(SpottColor.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var validityBadge: some View {
        Image(
            systemName: draft.contactForDraftSave() == nil
                ? "circle.dashed"
                : "checkmark.circle.fill"
        )
        .font(.title3)
        .foregroundStyle(
            draft.contactForDraftSave() == nil
                ? SpottColor.muted
                : SpottColor.mint
        )
        .frame(minWidth: 44, minHeight: 44)
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private var kindPicker: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(copy.kindTitle)
                .font(.subheadline.weight(.semibold))

            if #available(iOS 26.0, *) {
                Menu {
                    kindActions
                } label: {
                    kindMenuLabel
                }
                .buttonStyle(.glass)
                .disabled(isEditingDisabled)
            } else {
                Menu {
                    kindActions
                } label: {
                    kindMenuLabel
                }
                .buttonStyle(.bordered)
                .disabled(isEditingDisabled)
            }
        }
        .accessibilityIdentifier("event.composer.contact.kind")
    }

    @ViewBuilder
    private var kindActions: some View {
        ForEach(
            [
                OrganizerContact.Kind.email,
                OrganizerContact.Kind.line,
                OrganizerContact.Kind.website,
            ],
            id: \.rawValue
        ) { kind in
            Button {
                kindBinding.wrappedValue = kind
            } label: {
                if draft.kind == kind {
                    Label(copy.title(for: kind), systemImage: "checkmark")
                } else {
                    Text(copy.title(for: kind))
                }
            }
        }
    }

    private var kindMenuLabel: some View {
        HStack(spacing: 10) {
            Image(systemName: icon(for: draft.kind))
            Text(copy.title(for: draft.kind))
                .fontWeight(.semibold)
            Spacer(minLength: 10)
            Image(systemName: "chevron.up.chevron.down")
                .font(.caption.weight(.bold))
                .foregroundStyle(SpottColor.muted)
        }
        .frame(maxWidth: .infinity, minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityLabel(copy.kindTitle)
        .accessibilityValue(copy.title(for: draft.kind))
    }

    @ViewBuilder
    private var statusContent: some View {
        if draft.recoveryState == .failed {
            VStack(alignment: .leading, spacing: 10) {
                Label(
                    copy.recoveryFailedMessage,
                    systemImage: "exclamationmark.shield.fill"
                )
                .font(.footnote.weight(.semibold))
                .foregroundStyle(SpottColor.danger)
                .fixedSize(horizontal: false, vertical: true)

                Button(action: onRetryRecovery) {
                    if isRecovering {
                        ProgressView()
                            .frame(maxWidth: .infinity, minHeight: 44)
                    } else {
                        Label(copy.retryTitle, systemImage: "arrow.clockwise")
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(SpottColor.ink)
                .disabled(isRecovering)
                .accessibilityIdentifier("event.composer.contact.retry")
            }
            .accessibilityIdentifier("event.composer.contact.restore_error")
        } else if !draft.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  draft.contactForDraftSave() == nil {
            Label(copy.invalidMessage, systemImage: "exclamationmark.circle.fill")
                .font(.footnote)
                .foregroundStyle(SpottColor.danger)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("event.composer.contact.validation_error")
        }
    }

    private var keyboardType: UIKeyboardType {
        switch draft.kind {
        case .email: .emailAddress
        case .line: .asciiCapable
        case .website: .URL
        }
    }

    private var textContentType: UITextContentType? {
        switch draft.kind {
        case .email: .emailAddress
        case .line: nil
        case .website: .URL
        }
    }

    private func icon(for kind: OrganizerContact.Kind) -> String {
        switch kind {
        case .email: "envelope.fill"
        case .line: "message.fill"
        case .website: "lock.fill"
        }
    }
}

private extension View {
    @ViewBuilder
    func composerContactFieldSurface() -> some View {
        if #available(iOS 26.0, *) {
            self
                .padding(.horizontal, 13)
                .padding(.vertical, 13)
                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                .contentShape(Rectangle())
                .glassEffect(
                    .regular.interactive(),
                    in: .rect(cornerRadius: 13)
                )
        } else {
            self
                .padding(.horizontal, 13)
                .padding(.vertical, 13)
                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                .contentShape(Rectangle())
                .background(
                    Color.black.opacity(0.045),
                    in: RoundedRectangle(cornerRadius: 13, style: .continuous)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 13)
                        .stroke(SpottColor.divider)
                )
        }
    }
}
