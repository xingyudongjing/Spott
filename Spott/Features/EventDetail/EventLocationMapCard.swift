import MapKit
import SwiftUI

struct EventLocationMapCard: View {
    let coordinate: EventCoordinate
    let isExact: Bool
    let locale: Locale
    let openRoute: () -> Void

    var body: some View {
        Button(action: openRoute) {
            VStack(alignment: .leading, spacing: 0) {
                map
                    .frame(height: 120)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                if !isExact {
                    Label(
                        EventDetailExtrasLocalization.text(
                            "eventdetail.map.approximate",
                            locale: locale
                        ),
                        systemImage: "circle.dashed"
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                }
            }
            .background(
                Color(uiColor: .secondarySystemGroupedBackground),
                in: RoundedRectangle(cornerRadius: 20, style: .continuous)
            )
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(Color.primary.opacity(0.08), lineWidth: 0.5)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityIdentifier("event.detail.map_preview")
    }

    private var map: some View {
        Map(
            initialPosition: .camera(
                MapCamera(
                    centerCoordinate: displayCoordinate,
                    distance: isExact ? 1_400 : 3_200
                )
            ),
            interactionModes: []
        ) {
            Annotation("", coordinate: displayCoordinate) {
                marker
            }
        }
    }

    @ViewBuilder
    private var marker: some View {
        if isExact {
            Image(systemName: "mappin.circle.fill")
                .font(.title3)
                .symbolRenderingMode(.palette)
                .foregroundStyle(.white, SpottColor.twilight)
        } else {
            ZStack {
                Circle()
                    .fill(SpottColor.twilight.opacity(0.18))
                Circle()
                    .stroke(SpottColor.twilight.opacity(0.55), lineWidth: 1.5)
                Circle()
                    .fill(SpottColor.twilight)
                    .frame(width: 8, height: 8)
            }
            .frame(width: 44, height: 44)
        }
    }

    private var displayCoordinate: CLLocationCoordinate2D {
        if isExact {
            return CLLocationCoordinate2D(
                latitude: coordinate.latitude,
                longitude: coordinate.longitude
            )
        }
        // Approximate coordinates render at ~0.01° so the card never implies a
        // precise venue before the exact address is disclosed.
        return CLLocationCoordinate2D(
            latitude: (coordinate.latitude * 100).rounded() / 100,
            longitude: (coordinate.longitude * 100).rounded() / 100
        )
    }

    private var accessibilityLabel: String {
        var parts = [
            EventDetailExtrasLocalization.text("eventdetail.map.accessibility", locale: locale)
        ]
        if !isExact {
            parts.append(
                EventDetailExtrasLocalization.text("eventdetail.map.approximate", locale: locale)
            )
        }
        return parts.joined(separator: ", ")
    }
}
