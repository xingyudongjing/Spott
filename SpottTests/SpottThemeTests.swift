import SwiftUI
import UIKit
import XCTest
@testable import Spott

@MainActor
final class SpottThemeTests: XCTestCase {
    func testSemanticColorsMatchSharedLightAndDarkDesignTokens() {
        assertColor(SpottColor.canvas, light: 0xF7F5F0, dark: 0x0E1014, name: "canvas")
        assertColor(SpottColor.surface, light: 0xFFFFFF, dark: 0x171A20, name: "surface")
        assertColor(SpottColor.ink, light: 0x17181C, dark: 0xF7F6F2, name: "ink")
        assertColor(SpottColor.muted, light: 0x6F737C, dark: 0xA7ACB7, name: "muted")
        assertColor(SpottColor.twilight, light: 0x6E5BE7, dark: 0x9B8CFF, name: "twilight")
        assertColor(SpottColor.coral, light: 0xFF745F, dark: 0xFF866F, name: "coral")
        assertColor(SpottColor.mint, light: 0x3DBD91, dark: 0x51D4A5, name: "mint")
        assertColor(SpottColor.amber, light: 0xD99A2B, dark: 0xF0B84F, name: "amber")
        assertColor(SpottColor.danger, light: 0xD84B5B, dark: 0xFF6B79, name: "danger")
        assertColor(SpottColor.divider, light: 0xE6E2DA, dark: 0x2B3038, name: "divider")
    }

    private func assertColor(_ color: Color, light: UInt32, dark: UInt32, name: String) {
        assertResolved(color, style: .light, expected: light, name: "\(name).light")
        assertResolved(color, style: .dark, expected: dark, name: "\(name).dark")
    }

    private func assertResolved(
        _ color: Color,
        style: UIUserInterfaceStyle,
        expected: UInt32,
        name: String
    ) {
        let resolved = UIColor(color).resolvedColor(
            with: UITraitCollection(userInterfaceStyle: style)
        )
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        XCTAssertTrue(resolved.getRed(&red, green: &green, blue: &blue, alpha: &alpha), name)
        XCTAssertEqual(red, CGFloat((expected >> 16) & 0xFF) / 255, accuracy: 0.006, name)
        XCTAssertEqual(green, CGFloat((expected >> 8) & 0xFF) / 255, accuracy: 0.006, name)
        XCTAssertEqual(blue, CGFloat(expected & 0xFF) / 255, accuracy: 0.006, name)
        XCTAssertEqual(alpha, 1, accuracy: 0.006, name)
    }
}
