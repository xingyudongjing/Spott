import SwiftUI

struct OrganizerContactCard: View {
    let contact: OrganizerContact
    let locale: Locale
    let onReportHost: (() -> Void)?

    private var actionURL: URL? { contact.actionURL }

    @ViewBuilder
    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: 10) {
                cardContent
            }
        } else {
            cardContent
        }
    }

    private var cardContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "lock.shield.fill")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(SpottColor.twilight)
                    .frame(width: 42, height: 42)
                    .background(SpottColor.twilightPale, in: Circle())
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 5) {
                    Text(text("journey.contact.title"))
                        .font(.headline)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                    Text(text("journey.contact.visibility"))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(SpottColor.twilight)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            VStack(alignment: .leading, spacing: 5) {
                Label(displayLabel, systemImage: contactIcon)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(displayValue)
                    .font(.body.monospaced())
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel("\(displayLabel): \(displayValue)")
            }

            Text(text("journey.contact.safety"))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            actionLayout
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .spottGlassPanel(
            shape: RoundedRectangle(cornerRadius: 24, style: .continuous),
            tint: SpottColor.twilightPale.opacity(0.38),
            interactive: false
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("registration.contact.card")
    }

    private var actionLayout: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                contactAction
                reportAction
            }
            VStack(spacing: 10) {
                contactAction
                reportAction
            }
        }
    }

    @ViewBuilder
    private var contactAction: some View {
        if let actionURL {
            if #available(iOS 26.0, *) {
                contactLink(destination: actionURL)
                    .buttonStyle(.glassProminent)
                    .tint(SpottColor.twilight)
            } else {
                contactLink(destination: actionURL)
                    .buttonStyle(.borderedProminent)
                    .tint(SpottColor.twilight)
            }
        }
    }

    private func contactLink(destination: URL) -> some View {
        Link(destination: destination) {
            Label(actionTitle, systemImage: contactIcon)
                .frame(maxWidth: .infinity, minHeight: 44)
                .multilineTextAlignment(.center)
        }
        .buttonBorderShape(.capsule)
        .accessibilityHint(text("journey.contact.external_hint"))
        .accessibilityIdentifier("registration.contact.action")
    }

    @ViewBuilder
    private var reportAction: some View {
        if let onReportHost {
            let button = Button(action: onReportHost) {
                Label(
                    text("journey.contact.report"),
                    systemImage: "person.crop.circle.badge.exclamationmark"
                )
                .frame(maxWidth: .infinity, minHeight: 44)
                .multilineTextAlignment(.center)
            }
            .buttonBorderShape(.capsule)
            .accessibilityIdentifier("registration.contact.report")

            if #available(iOS 26.0, *) {
                button.buttonStyle(.glass)
            } else {
                button.buttonStyle(.bordered)
            }
        }
    }

    private var displayLabel: String {
        if let label = contact.label?.trimmingCharacters(in: .whitespacesAndNewlines),
           !label.isEmpty {
            return label
        }
        return text(kindLabelKey)
    }

    private var displayValue: String {
        contact.kind == .line ? "@\(contact.value)" : contact.value
    }

    private var contactIcon: String {
        switch contact.kind {
        case .email: "envelope.fill"
        case .line: "message.fill"
        case .website: "lock.fill"
        }
    }

    private var kindLabelKey: String.LocalizationValue {
        switch contact.kind {
        case .email: "journey.contact.kind.email"
        case .line: "journey.contact.kind.line"
        case .website: "journey.contact.kind.website"
        }
    }

    private var actionTitle: String {
        switch contact.kind {
        case .email: text("journey.contact.action.email")
        case .line: text("journey.contact.action.line")
        case .website: text("journey.contact.action.website")
        }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }
}
