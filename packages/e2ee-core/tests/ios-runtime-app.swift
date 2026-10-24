import Foundation
import UIKit

@main
final class E2eeRuntimeAppDelegate: UIResponder, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let result: String
        do {
            try Self.runRoundTrip()
            result = "passed"
        } catch {
            result = "failed: \(error)"
        }

        let output = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("e2ee-runtime-result.txt")
        try? Data(result.utf8).write(to: output, options: .atomic)
        return true
    }

    private static func runRoundTrip() throws {
        let accountId = Data("simulator-account".utf8)
        let deviceId = Data("simulator-device-1234".utf8)
        let identity = Data("halochat:user:simulator-account:device:simulator-device-1234".utf8)
        let device = try e2eeCreateDevice(identity: identity)
        let member = try e2eeDeviceIdentity(state: device.state)
        let proof = try e2eeSignDeviceBinding(state: device.state, accountId: accountId, deviceId: deviceId)
        guard e2eeVerifyDeviceBinding(
            accountId: accountId,
            deviceId: deviceId,
            identity: member.identity,
            signatureKey: member.signatureKey,
            signatureProof: proof
        ) else {
            throw RuntimeFailure.deviceBinding
        }

        let alice = try e2eeCreateDevice(identity: Data("alice/simulator".utf8))
        let bob = try e2eeCreateDevice(identity: Data("bob/simulator".utf8))
        let group = try e2eeCreateGroup(state: alice.state, groupId: Data("simulator-group".utf8))
        let bobMember = try e2eeDeviceIdentity(state: bob.state)
        let added = try e2eeAddMember(state: group, keyPackage: bob.keyPackage, expectedMember: bobMember)
        let joined = try e2eeJoinGroup(state: bob.state, welcome: added.welcome)
        guard try e2eeSafetyFingerprint(state: added.state) == e2eeSafetyFingerprint(state: joined) else {
            throw RuntimeFailure.safetyFingerprint
        }

        let plaintext = Data("iOS simulator MLS round trip".utf8)
        let encrypted = try e2eeEncryptApplication(state: added.state, plaintext: plaintext)
        let decrypted = try e2eeDecryptApplication(state: joined, message: encrypted.message)
        guard decrypted.message == plaintext else { throw RuntimeFailure.message }

        let key = Data(repeating: 7, count: 32)
        let context = Data("simulator:device:alice/group:simulator-group".utf8)
        let protected = try e2eeProtectState(state: encrypted.state, deviceKey: key, context: context)
        let restored = try e2eeUnprotectState(envelope: protected, deviceKey: key, context: context)
        guard restored == encrypted.state else { throw RuntimeFailure.stateProtection }
    }
}

private enum RuntimeFailure: Error {
    case deviceBinding
    case safetyFingerprint
    case message
    case stateProtection
}
