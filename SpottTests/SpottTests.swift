//
//  SpottTests.swift
//  SpottTests
//
//  Created by 姚凯 on 2026/7/15.
//

import Foundation
import Testing
@testable import Spott

struct SpottTests {
    @Test func customGlassDefaultsToNoninteractive() {
        #expect(SpottGlassMetrics.defaultInteractive == false)
    }

    @Test func appleNonceUsesURLSafeCharactersAndRequestedLength() throws {
        let nonce = try AppleSignInNonce.generate(length: 48)

        #expect(nonce.count == 48)
        #expect(nonce.allSatisfy { AppleSignInNonce.allowedCharacters.contains($0) })
    }

    @Test func appleNonceHashMatchesAppleOIDCContract() {
        #expect(
            AppleSignInNonce.sha256("spott-apple-nonce")
                == "cdce5bb04723dd7683a8d25005e93051536ffecafd41505c35654142441e3c59"
        )
    }

    @Test func appleAuthenticationPayloadUsesBackendFieldNames() throws {
        let payload = AppleAuthenticationPayload(
            identityToken: "identity.jwt",
            nonce: "raw-nonce",
            deviceId: UUID(uuidString: "00000000-0000-0000-0000-000000000123")!
        )

        let object = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as? [String: String]
        )
        #expect(object["identityToken"] == "identity.jwt")
        #expect(object["nonce"] == "raw-nonce")
        #expect(object["deviceId"] == "00000000-0000-0000-0000-000000000123")
        #expect(object["platform"] == "ios")
    }

    @Test func googleOAuthConfigurationRequiresMatchingNativeCredentials() throws {
        let configuration = try GoogleOAuthConfiguration(values: [
            "GIDClientID": "123456789-ios.apps.googleusercontent.com",
            "GIDServerClientID": "123456789-web.apps.googleusercontent.com",
            "GIDReversedClientID": "com.googleusercontent.apps.123456789-ios",
        ])

        #expect(configuration.clientID == "123456789-ios.apps.googleusercontent.com")
        #expect(configuration.serverClientID == "123456789-web.apps.googleusercontent.com")
        #expect(configuration.reversedClientID == "com.googleusercontent.apps.123456789-ios")
    }

    @Test func googleOAuthConfigurationRejectsPlaceholderCredentials() {
        #expect(throws: GoogleOAuthConfiguration.ConfigurationError.self) {
            try GoogleOAuthConfiguration(values: [
                "GIDClientID": "SET_GOOGLE_IOS_CLIENT_ID",
                "GIDServerClientID": "SET_GOOGLE_SERVER_CLIENT_ID",
                "GIDReversedClientID": "SET_GOOGLE_REVERSED_CLIENT_ID",
            ])
        }
    }

    @Test func safetyReportPayloadMatchesModerationContract() throws {
        let payload = SafetyReportPayload(
            targetType: .event,
            targetId: UUID(uuidString: "00000000-0000-0000-0000-000000000222")!,
            reason: "unsafe",
            details: "The meeting point is misleading.",
            evidenceAssetIds: []
        )

        let object = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as? [String: Any]
        )
        #expect(object["targetType"] as? String == "event")
        #expect(object["targetId"] as? String == "00000000-0000-0000-0000-000000000222")
        #expect(object["reason"] as? String == "unsafe")
        #expect(object["evidenceAssetIds"] as? [String] == [])
    }

    @Test func notificationPreferenceUpdateKeepsLocaleAndQuietHours() throws {
        let payload = NotificationPreferenceUpdate(
            inApp: true,
            push: false,
            email: true,
            quietStart: "22:30",
            quietEnd: "07:30",
            locale: "ja"
        )

        let object = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as? [String: Any]
        )
        #expect(object["inApp"] as? Bool == true)
        #expect(object["push"] as? Bool == false)
        #expect(object["email"] as? Bool == true)
        #expect(object["quietStart"] as? String == "22:30")
        #expect(object["quietEnd"] as? String == "07:30")
        #expect(object["locale"] as? String == "ja")
    }

    @Test func storeTransactionPayloadUsesSignedJWSField() throws {
        let object = try #require(
            JSONSerialization.jsonObject(
                with: JSONEncoder().encode(AppleStoreTransactionPayload(signedTransaction: "header.payload.signature"))
            ) as? [String: String]
        )
        #expect(object == ["signedTransaction": "header.payload.signature"])
    }

    @Test func storeCatalogDecodesPaidAndBonusPointsSeparately() throws {
        let data = Data(#"{"store":"apple","items":[{"productId":"jp.spott.points.1000","points":1000,"bonusPoints":50}]}"#.utf8)

        let catalog = try JSONDecoder().decode(StoreProductCatalog.self, from: data)

        #expect(catalog.store == "apple")
        #expect(catalog.items.first?.productId == "jp.spott.points.1000")
        #expect(catalog.items.first?.points == 1_000)
        #expect(catalog.items.first?.bonusPoints == 50)
    }

    @Test func registrationPayloadUsesQuestionUUIDsAndTypedAnswers() throws {
        let questionID = UUID(uuidString: "00000000-0000-0000-0000-000000000301")!
        let payload = RegistrationRequestPayload(
            partySize: 2,
            quoteID: UUID(uuidString: "00000000-0000-0000-0000-000000000302")!,
            expectedEventVersion: 7,
            joinWaitlistIfFull: true,
            answers: [
                questionID: .text("第一次参加"),
                UUID(uuidString: "00000000-0000-0000-0000-000000000303")!: .boolean(true),
            ],
            attendeeNote: "素食"
        )

        let object = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as? [String: Any]
        )
        let answers = try #require(object["answers"] as? [String: Any])
        #expect(object["partySize"] as? Int == 2)
        #expect(object["quoteId"] as? String == "00000000-0000-0000-0000-000000000302")
        #expect(object["expectedEventVersion"] as? Int == 7)
        #expect(answers[questionID.uuidString.lowercased()] as? String == "第一次参加")
        #expect(answers["00000000-0000-0000-0000-000000000303"] as? Bool == true)
    }

    @Test func waitlistAcceptancePayloadCarriesQuoteAndBothConcurrencyVersions() throws {
        let payload = WaitlistAcceptancePayload(
            quoteID: UUID(uuidString: "00000000-0000-0000-0000-000000000304")!,
            expectedRegistrationVersion: 4,
            expectedEventVersion: 9
        )

        let object = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as? [String: Any]
        )
        #expect(object["quoteId"] as? String == "00000000-0000-0000-0000-000000000304")
        #expect(object["expectedRegistrationVersion"] as? Int == 4)
        #expect(object["expectedEventVersion"] as? Int == 9)
    }

    @Test func registrationQuestionDecodesStableServerID() throws {
        let data = Data(#"{"id":"00000000-0000-0000-0000-000000000304","prompt":"是否同意规则？","kind":"boolean","required":true,"options":[]}"#.utf8)

        let question = try JSONDecoder().decode(RegistrationQuestion.self, from: data)

        #expect(question.id.uuidString.lowercased() == "00000000-0000-0000-0000-000000000304")
        #expect(question.kind == .boolean)
        #expect(question.required)
    }

    @Test func checkInPayloadRequiresExactlyOneCredential() throws {
        let registrationID = UUID(uuidString: "00000000-0000-0000-0000-000000000305")!
        let operationID = UUID(uuidString: "00000000-0000-0000-0000-000000000306")!

        #expect(throws: CheckInRequestPayload.ValidationError.self) {
            try CheckInRequestPayload(
                registrationID: registrationID,
                operationID: operationID,
                token: "opaque-token",
                code: "123456"
            )
        }
        let valid = try CheckInRequestPayload(
            registrationID: registrationID,
            operationID: operationID,
            token: "opaque-token"
        )
        let object = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(valid)) as? [String: Any]
        )
        #expect(object["registrationId"] as? String == registrationID.uuidString.lowercased())
        #expect(object["operationId"] as? String == operationID.uuidString.lowercased())
        #expect(object["token"] as? String == "opaque-token")
        #expect(object["code"] == nil)
    }

    @Test func feedbackPayloadPreservesPrivacyAndAllowedTags() throws {
        let payload = FeedbackSubmissionPayload(
            attendanceRating: 5,
            tags: [.friendly, .safe, .wouldJoinAgain],
            comment: "集合信息很清楚。",
            visibility: .aggregateOnly
        )

        let object = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as? [String: Any]
        )
        #expect(object["attendanceRating"] as? Int == 5)
        #expect(object["tags"] as? [String] == ["friendly", "safe", "would_join_again"])
        #expect(object["comment"] as? String == "集合信息很清楚。")
        #expect(object["visibility"] as? String == "aggregate_only")
    }

    @Test func safetyCaseDecodesPublicReferenceAndAppealState() throws {
        let data = Data(#"{"reference":"SPT-2026-ABCDEF123456","relationship":"submitted","targetType":"event","targetId":"00000000-0000-0000-0000-000000000501","reason":"unsafe","severity":"p1","status":"appealed","caseStatus":"appealed","decision":"content_removed","slaDueAt":"2026-07-16T00:00:00Z","createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-15T01:00:00Z","appeal":{"id":"00000000-0000-0000-0000-000000000502","status":"pending","createdAt":"2026-07-15T01:00:00Z","decidedAt":null}}"#.utf8)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        let item = try decoder.decode(SafetyCase.self, from: data)

        #expect(item.id == "SPT-2026-ABCDEF123456")
        #expect(item.appeal?.status == "pending")
        #expect(item.canAppeal == false)
    }

    @Test func safetyCaseAllowsAppealOnlyAfterAResolvedDecision() throws {
        let data = Data(#"{"reference":"SPT-2026-ABCDEF123457","relationship":"subject","targetType":"user","targetId":"00000000-0000-0000-0000-000000000503","reason":"harassment","severity":"p2","status":"closed","caseStatus":"decided","decision":"warning","slaDueAt":null,"createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-15T01:00:00Z","appeal":null}"#.utf8)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        let item = try decoder.decode(SafetyCase.self, from: data)

        #expect(item.canAppeal)
    }

    @Test func groupCreationPayloadCarriesQuoteAndGovernanceFields() throws {
        let payload = GroupCreationPayload(
            quoteId: UUID(uuidString: "00000000-0000-0000-0000-000000000601")!,
            name: "东京城市散步",
            slug: "tokyo-city-walk",
            description: "每个月一起探索一条适合步行的东京街区路线。",
            joinMode: .approval,
            regionId: "tokyo",
            categoryId: "outdoor",
            tags: ["city-walk", "photography"],
            rules: "尊重边界，准时到场。"
        )
        let object = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as? [String: Any]
        )

        #expect(object["quoteId"] as? String == "00000000-0000-0000-0000-000000000601")
        #expect(object["joinMode"] as? String == "approval")
        #expect(object["categoryId"] as? String == "outdoor")
        #expect(object["tags"] as? [String] == ["city-walk", "photography"])
    }

    @Test func groupDetailDecodesMembershipAndAnnouncementSummary() throws {
        let data = Data(#"{"id":"00000000-0000-0000-0000-000000000602","ownerId":"00000000-0000-0000-0000-000000000603","owner":{"id":"00000000-0000-0000-0000-000000000603","name":"Hikari","handle":"hikari"},"name":"东京城市散步","slug":"tokyo-city-walk","description":"一起探索东京。","joinMode":"approval","regionId":"tokyo","categoryId":"outdoor","tags":["city-walk"],"rules":"尊重彼此","capacity":50,"memberCount":12,"status":"active","membershipStatus":"active","membershipRole":"member","viewerFollowing":true,"announcementSummary":[{"id":"00000000-0000-0000-0000-000000000604","groupId":"00000000-0000-0000-0000-000000000602","authorId":"00000000-0000-0000-0000-000000000603","authorName":"Hikari","title":"下次路线","body":"周六见","visibility":"members","commentsEnabled":true,"pinnedAt":null,"likeCount":2,"viewerLiked":true,"commentCount":1,"version":1,"createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-15T00:00:00Z"}],"closingAt":null,"dissolveAfter":null,"availableActions":["viewAnnouncements","unfollowGroup"],"version":3,"updatedAt":"2026-07-15T00:00:00Z"}"#.utf8)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        let group = try decoder.decode(GroupSummary.self, from: data)

        #expect(group.membershipStatus == "active")
        #expect(group.membershipRole == "member")
        #expect(group.announcementSummary.first?.viewerLiked == true)
        #expect(group.availableActions.contains("viewAnnouncements"))
    }

    @Test func eventDraftQuestionKeepsStableIDAndChoiceOptions() throws {
        let questionID = UUID(uuidString: "00000000-0000-0000-0000-000000000701")!
        let question = EventDraftInput.Question(
            id: questionID,
            prompt: "希望走哪条路线？",
            kind: "single_choice",
            required: true,
            options: ["河岸", "老街"]
        )
        let object = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(question)) as? [String: Any]
        )

        #expect(object["id"] as? String == questionID.uuidString.uppercased())
        #expect(object["kind"] as? String == "single_choice")
        #expect(object["required"] as? Bool == true)
        #expect(object["options"] as? [String] == ["河岸", "老街"])
    }

    @Test func apnsDeviceTokenUsesStableLowercaseHex() {
        let token = APNSDeviceToken.hexString(Data([0x00, 0x0f, 0xa4, 0xff]))
        #expect(token == "000fa4ff")
    }

    @Test func groupDirectoryKeepsPublicDiscoveryAvailableWithoutAuthentication() {
        #expect(GroupDirectoryScope.discover.requiresAuthentication == false)
        #expect(GroupDirectoryScope.mine.requiresAuthentication == true)
    }

    @Test func groupManagementPolicyGrantsAdminsContentAndMemberToolsButReservesOwnershipTools() {
        let admin = GroupPresentationPolicy(
            membershipRole: "admin",
            availableActions: []
        )
        let owner = GroupPresentationPolicy(
            membershipRole: "owner",
            availableActions: ["purchaseCapacity", "transferGroup", "dissolveGroup"]
        )

        #expect(admin.canManageAnnouncements)
        #expect(admin.canManageMembers)
        #expect(admin.canPurchaseCapacity == false)
        #expect(owner.canManageAnnouncements)
        #expect(owner.canManageMembers)
        #expect(owner.canPurchaseCapacity)
        #expect(owner.canTransferOwnership)
        #expect(owner.canDissolve)
    }

    @Test func inviteOnlyGroupRequiresANormalizedInviteCodeBeforeJoining() {
        #expect(GroupJoinReadiness(mode: .inviteOnly, rawInviteCode: "  ") == .inviteRequired)
        #expect(
            GroupJoinReadiness(mode: .inviteOnly, rawInviteCode: "  SPOTT-2026-INVITE  ")
                == .ready(inviteCode: "SPOTT-2026-INVITE")
        )
        #expect(GroupJoinReadiness(mode: .open, rawInviteCode: "") == .ready(inviteCode: nil))
    }

    @Test func pendingOperationsRespectDependencies() {
        let firstID = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
        let secondID = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!
        let thirdID = UUID(uuidString: "00000000-0000-0000-0000-000000000003")!
        let first = PendingOperation(operationID: firstID, entityType: "event", entityID: nil, action: "create", baseVersion: nil, payload: Data("{}".utf8), dependencies: [])
        let second = PendingOperation(operationID: secondID, entityType: "event", entityID: nil, action: "update", baseVersion: 1, payload: Data("{}".utf8), dependencies: [firstID])
        let third = PendingOperation(operationID: thirdID, entityType: "registration", entityID: nil, action: "create", baseVersion: nil, payload: Data("{}".utf8), dependencies: [secondID])

        let sorted = SyncEngine.topologicalSort([third, second, first])

        #expect(sorted.map(\.operationID) == [firstID, secondID, thirdID])
    }

    @Test func eventPrivacyAndActionContractDecodes() throws {
        let payload = """
        {
          "id":"019b0000-0000-7000-8100-000000000001",
          "publicSlug":"tokyo-night-walk",
          "organizerId":"019b0000-0000-7000-8100-000000000099",
          "status":"published",
          "title":"东京夜行",
          "description":"公开说明",
          "category":"city-walk",
          "startsAt":"2026-07-18T08:30:00Z",
          "endsAt":"2026-07-18T10:30:00Z",
          "deadlineAt":"2026-07-18T07:30:00Z",
          "displayTimeZone":"Asia/Tokyo",
          "region":"tokyo",
          "publicArea":"清澄白河站附近",
          "capacity":20,
          "confirmedCount":8,
          "availableCapacity":12,
          "fee":{"isFree":true,"amountJPY":null,"collectorName":null,"method":null,"paymentDeadlineText":null,"refundPolicy":null},
          "coverURL":null,
          "tags":["city-walk"],
          "organizer":{"id":"019b0000-0000-7000-8100-000000000099","name":"夜行会","handle":"night_walk","viewerFollowing":false,"trust":{"phoneVerified":true,"completedEventCount":8,"attendanceRateBand":"90_plus"}},
          "favorited":false,
          "registrationStatus":null,
          "viewerRegistration":null,
          "registrationMode":"automatic",
          "waitlistEnabled":true,
          "format":"in_person",
          "primaryLocale":"ja",
          "supportedLocales":["ja","en"],
          "localeConfirmed":true,
          "availableActions":["register"],
          "version":4,
          "updatedAt":"2026-07-15T08:00:00Z",
          "coordinate":{"latitude":35.68,"longitude":139.79,"precision":"approximate"},
          "exactAddress":null,
          "registrationQuestions":[]
        }
        """
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        let event = try decoder.decode(EventSummary.self, from: Data(payload.utf8))

        #expect(event.exactAddress == nil)
        #expect(event.remaining == 12)
        #expect(event.availableActions == [.register])
        #expect(event.availableActions[0].requiresPhone)
    }

    @Test func APIErrorsKeepStableUserFacingCodes() async {
        let mapped = await MainActor.run {
            AppModel.map(APIError(
                status: 409,
                code: "VERSION_CONFLICT",
                message: "raw server-only diagnostic must never reach the user",
                retryable: false
            ))
        }
        #expect(mapped.id == "VERSION_CONFLICT")
        #expect(mapped.retryable == false)
        #expect(mapped.message != "raw server-only diagnostic must never reach the user")
    }

    @Test func publicProfileHostedEventsDecodeThePrivacySafeCardContract() throws {
        let data = Data(#"{"items":[{"id":"00000000-0000-0000-0000-000000000801","publicSlug":"tokyo-afterglow","status":"published","title":"东京余光散步","startsAt":"2026-07-18T08:30:00Z","endsAt":"2026-07-18T10:30:00Z","region":"tokyo","publicArea":"清澄白河站附近","priceLabel":"免费","coverURL":"https://media.spott.jp/event.webp"}],"hasMore":false,"nextCursor":null}"#.utf8)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        let page = try decoder.decode(PublicHostedEventPage.self, from: data)

        #expect(page.items.count == 1)
        #expect(page.items[0].publicSlug == "tokyo-afterglow")
        #expect(page.items[0].coverURL?.absoluteString == "https://media.spott.jp/event.webp")
    }

    @Test func posterAndActiveTransferContractsPreserveReadyAndRecoveryState() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let poster = try decoder.decode(PosterJob.self, from: Data(#"{"id":"00000000-0000-0000-0000-000000000802","state":"ready","assetId":"00000000-0000-0000-0000-000000000803","url":"https://media.spott.jp/poster.webp","failureCode":null,"template":"tokyo_afterglow","locale":"ja","updatedAt":"2026-07-15T08:00:00Z"}"#.utf8))
        let transfer = try decoder.decode(ActiveGroupTransfer.self, from: Data(#"{"id":"00000000-0000-0000-0000-000000000804","groupId":"00000000-0000-0000-0000-000000000805","fromUserId":"00000000-0000-0000-0000-000000000806","toUserId":"00000000-0000-0000-0000-000000000807","state":"cooling_off","expiresAt":"2026-07-16T08:00:00Z","cooldownUntil":"2026-07-22T08:00:00Z"}"#.utf8))

        #expect(poster.url?.absoluteString == "https://media.spott.jp/poster.webp")
        #expect(transfer.state == "cooling_off")
        #expect(transfer.cooldownUntil != nil)
    }

    @Test func accountMergePreviewCarriesARealSecondIdentityProof() throws {
        let request = AccountMergePreviewRequest(
            credential: .apple(identityToken: "apple.jwt", nonce: String(repeating: "n", count: 32), platform: "ios")
        )
        let object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        let credential = try #require(object["credential"] as? [String: Any])

        #expect(credential["provider"] as? String == "apple")
        #expect(credential["identityToken"] as? String == "apple.jwt")
        #expect(credential["nonce"] as? String == String(repeating: "n", count: 32))
        #expect(credential["platform"] as? String == "ios")
    }

    @Test func accountMergeCommitIsBoundToJobProofDeviceAndPlatform() throws {
        let payload = AccountMergeCommitRequest(
            jobId: UUID(uuidString: "00000000-0000-0000-0000-000000000808")!,
            mergeToken: String(repeating: "m", count: 43),
            deviceId: UUID(uuidString: "00000000-0000-0000-0000-000000000809")!,
            platform: "ios"
        )
        let object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as? [String: String])

        #expect(object["jobId"] == "00000000-0000-0000-0000-000000000808")
        #expect(object["mergeToken"] == String(repeating: "m", count: 43))
        #expect(object["deviceId"] == "00000000-0000-0000-0000-000000000809")
        #expect(object["platform"] == "ios")
    }
}
