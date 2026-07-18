import Foundation

protocol GroupJoinServing: Actor {
    func group(identifier: String) async throws -> GroupSummary
    func joinGroup(id: UUID, inviteCode: String?) async throws -> GroupMembership
}

extension SpottAPIClient: GroupJoinServing {}

enum DeferredGroupJoinRecoveryPolicy {
    static func permitsJoin(_ group: GroupSummary, inviteCode: String?) -> Bool {
        guard group.status == "active",
              group.membershipStatus == nil,
              group.memberCount < group.capacity,
              group.availableActions.contains("joinGroup")
        else { return false }

        if group.joinMode == .inviteOnly {
            return inviteCode?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        }
        return true
    }
}
