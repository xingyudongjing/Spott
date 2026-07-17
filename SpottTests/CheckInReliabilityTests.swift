import Foundation
import XCTest
@testable import Spott

final class CheckInReliabilityTests: XCTestCase {
    func testCameraPanelInstantiatesScannerOnlyAfterExplicitAuthorization() {
        XCTAssertEqual(CheckInCameraPanelState(cameraAllowed: nil), .requesting)
        XCTAssertEqual(CheckInCameraPanelState(cameraAllowed: false), .denied)
        XCTAssertEqual(CheckInCameraPanelState(cameraAllowed: true), .scanner)
    }

    func testCheckInAccessibilityEventsSelectTheMatchingFocusAndAnnouncement() {
        let locale = Locale(identifier: "en")

        XCTAssertEqual(CheckInAccessibilityEvent.success.focusTarget, .success)
        XCTAssertEqual(
            CheckInAccessibilityEvent.success.announcement(
                eventTitle: "Tokyo Design Walk",
                locale: locale
            ),
            "Checked in to Tokyo Design Walk."
        )
        XCTAssertEqual(CheckInAccessibilityEvent.failure.focusTarget, .error)
        XCTAssertEqual(
            CheckInAccessibilityEvent.failure.announcement(
                eventTitle: "Tokyo Design Walk",
                locale: locale
            ),
            "Check-in could not be completed. Confirm the code and try again."
        )
    }

    func testCalendarErrorsHaveSpecificLocalizedMessagesInsteadOfGenericSuccess() {
        let locale = Locale(identifier: "en")

        XCTAssertEqual(
            CalendarIntegrationError.permissionDenied.localizedMessage(locale: locale),
            "Calendar access is off. Allow add-only access in Settings, then try again."
        )
        XCTAssertEqual(
            CalendarIntegrationError.authorizationFailed.localizedMessage(locale: locale),
            "Calendar permission could not be checked. Please try again."
        )
        XCTAssertEqual(
            CalendarIntegrationError.writeFailed.localizedMessage(locale: locale),
            "The event could not be saved to Calendar. Please try again."
        )
    }

    func testPermissionUsageDescriptionsAreLocalizedAndCalendarIsWriteOnly() throws {
        let repositoryRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let infoURL = repositoryRoot.appendingPathComponent("Spott/Info.plist")
        let infoData = try Data(contentsOf: infoURL)
        let info = try XCTUnwrap(
            PropertyListSerialization.propertyList(from: infoData, format: nil)
                as? [String: Any]
        )

        XCTAssertNotNil(info["NSCalendarsWriteOnlyAccessUsageDescription"])
        XCTAssertNil(info["NSCalendarsFullAccessUsageDescription"])

        let expectedKeys: Set<String> = [
            "NSCalendarsWriteOnlyAccessUsageDescription",
            "NSCameraUsageDescription",
            "NSLocationWhenInUseUsageDescription",
            "NSPhotoLibraryUsageDescription",
        ]
        for locale in ["zh-Hans", "ja", "en"] {
            let stringsURL = repositoryRoot
                .appendingPathComponent("Spott/Resources")
                .appendingPathComponent("\(locale).lproj")
                .appendingPathComponent("InfoPlist.strings")
            let stringsData = try Data(contentsOf: stringsURL)
            let values = try XCTUnwrap(
                PropertyListSerialization.propertyList(from: stringsData, format: nil)
                    as? [String: String]
            )
            XCTAssertEqual(Set(values.keys), expectedKeys, "Permission key drift for \(locale)")
            XCTAssertTrue(
                values.values.allSatisfy {
                    !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                },
                "Empty permission message for \(locale)"
            )
        }
    }
}
