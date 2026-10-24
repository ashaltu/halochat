import Foundation

@main
struct SwiftRoundTrip {
    static func main() throws {
        let alice = try e2eeCreateDevice(identity: Data("alice/device-1".utf8))
        let bob = try e2eeCreateDevice(identity: Data("bob/device-1".utf8))
        let aliceGroup = try e2eeCreateGroup(state: alice.state, groupId: Data("swift-group".utf8))
        let bobMember = try e2eeDeviceIdentity(state: bob.state)
        let added = try e2eeAddMember(
            state: aliceGroup,
            keyPackage: bob.keyPackage,
            expectedMember: bobMember
        )
        let bobGroup = try e2eeJoinGroup(state: bob.state, welcome: added.welcome)
        let aliceFingerprint = try e2eeSafetyFingerprint(state: added.state)
        let bobFingerprint = try e2eeSafetyFingerprint(state: bobGroup)
        precondition(aliceFingerprint == bobFingerprint)
        let sent = try e2eeEncryptApplication(state: added.state, plaintext: Data("Swift MLS message".utf8))
        let received = try e2eeDecryptApplication(state: bobGroup, message: sent.message)

        precondition(received.message == Data("Swift MLS message".utf8))

        let key = Data(repeating: 7, count: 32)
        let context = Data("account:alice/device:1/group:swift-group".utf8)
        let protected = try e2eeProtectState(state: sent.state, deviceKey: key, context: context)
        let restored = try e2eeUnprotectState(envelope: protected, deviceKey: key, context: context)
        precondition(restored == sent.state)
        print("Swift UniFFI MLS messaging and state protection passed")
    }
}
