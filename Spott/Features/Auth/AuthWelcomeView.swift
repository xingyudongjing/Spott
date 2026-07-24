import SwiftUI

struct AuthWelcomeView: View {
    @Environment(\.locale) private var locale

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 8) {
                        Image(systemName: "location.north.circle.fill")
                            .font(.title3)
                            .foregroundStyle(SpottColor.twilight)
                            .accessibilityHidden(true)
                        Text(verbatim: "SPOTT")
                            .font(.subheadline.bold())
                            .tracking(3.5)
                            .foregroundStyle(SpottColor.twilight)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(Text(verbatim: "Spott"))

                    Text(text("auth.welcome.tagline"))
                        .font(.largeTitle.bold())
                        .foregroundStyle(SpottColor.ink)
                        .lineSpacing(2)
                }

                VStack(alignment: .leading, spacing: 12) {
                    benefitRow("person.2", text("auth.welcome.benefit.discover"), tint: SpottColor.twilight)
                    benefitRow("checkmark.shield", text("auth.welcome.benefit.trust"), tint: SpottColor.mint)
                    benefitRow("calendar.badge.checkmark", text("auth.welcome.benefit.sync"), tint: SpottColor.coral)
                }

                SurfaceCard {
                    AuthFormView(layout: .fullscreen)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 24)
            .padding(.bottom, 32)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(SpottScreenBackground())
    }

    private func text(_ key: String.LocalizationValue) -> String {
        AuthLocalization.text(key, locale: locale)
    }

    private func benefitRow(_ icon: String, _ title: String, tint: Color) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(tint)
                .frame(width: 38, height: 38)
                .background(tint.opacity(0.14), in: Circle())
                .accessibilityHidden(true)
            Text(title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(SpottColor.ink)
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}

#Preview("Auth welcome") {
    AuthWelcomeView()
        .environment(AppModel.preview)
}
