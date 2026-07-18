import SwiftUI
import UIKit
import XCTest
@testable import Spott

final class VisibleAccessibilityLayoutPolicyTests: XCTestCase {
    func testLargestAccessibilityLaunchCategoryMatchesTheCurrentUIKitRawValue() {
        XCTAssertEqual(
            UIContentSizeCategory.accessibilityExtraExtraExtraLarge.rawValue,
            "UICTContentSizeCategoryAccessibilityXXXL"
        )
    }

    func testDiscoveryChromeUsesCompactHorizontalLabelsAtStandardSizes() {
        let policy = DiscoveryChromeLayoutPolicy(dynamicTypeSize: .large)

        XCTAssertFalse(policy.usesStackedFilterLabels)
        XCTAssertFalse(policy.usesStackedModeBar)
        XCTAssertEqual(policy.filterLabelLineLimit, 1)
        XCTAssertTrue(policy.emphasizesResultCount)
        XCTAssertGreaterThanOrEqual(policy.listBottomContentMargin, 32)
    }

    func testDiscoveryChromeUsesVerticallyAdaptiveLabelsAtAccessibilitySizes() {
        let policy = DiscoveryChromeLayoutPolicy(dynamicTypeSize: .accessibility3)

        XCTAssertTrue(policy.usesStackedFilterLabels)
        XCTAssertTrue(policy.usesStackedModeBar)
        XCTAssertNil(policy.filterLabelLineLimit)
        XCTAssertTrue(policy.emphasizesResultCount)
        XCTAssertGreaterThanOrEqual(policy.listBottomContentMargin, 64)
    }

    func testComposerGuestGateCentersOnlyAtStandardSizes() {
        XCTAssertTrue(
            EventComposerAccessGateLayoutPolicy(dynamicTypeSize: .large).centersInViewport
        )
        XCTAssertFalse(
            EventComposerAccessGateLayoutPolicy(dynamicTypeSize: .accessibility3).centersInViewport
        )
    }

    func testProfileGuestHeaderProtectsPrimaryActionAtAccessibilitySizes() {
        let standard = ProfileSignedOutLayoutPolicy(dynamicTypeSize: .large)
        let accessibility = ProfileSignedOutLayoutPolicy(dynamicTypeSize: .accessibility3)

        XCTAssertTrue(standard.showsPlatformBadge)
        XCTAssertFalse(standard.placesPrimaryActionBeforeSupportingText)
        XCTAssertEqual(standard.bottomContentPadding, 36)

        XCTAssertFalse(accessibility.showsPlatformBadge)
        XCTAssertTrue(accessibility.placesPrimaryActionBeforeSupportingText)
        XCTAssertGreaterThanOrEqual(accessibility.bottomContentPadding, 96)
    }

    func testEventActionBarMovesSupportingCopyIntoScrollContentAtAccessibilitySizes() {
        let standard = EventActionBarLayoutPolicy(dynamicTypeSize: .large)
        let accessibility = EventActionBarLayoutPolicy(dynamicTypeSize: .accessibility3)

        XCTAssertTrue(standard.showsSupportingTextInBar)
        XCTAssertTrue(standard.pinsActionBar)
        XCTAssertFalse(standard.actionFillsWidth)
        XCTAssertEqual(standard.actionLineLimit, 2)

        XCTAssertFalse(accessibility.showsSupportingTextInBar)
        XCTAssertFalse(accessibility.pinsActionBar)
        XCTAssertTrue(accessibility.actionFillsWidth)
        XCTAssertNil(accessibility.actionLineLimit)
    }
}
