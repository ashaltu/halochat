import ExpoModulesCore
import Foundation
import Security

private struct StateRef {
  var envelope: Data
  var deviceKey: Data
  var context: Data
}

private func stateRef(_ input: [String: Data]) throws -> StateRef {
  guard let envelope = input["envelope"], let deviceKey = input["deviceKey"], let context = input["context"] else {
    throw NSError(domain: "HaloChatE2ee", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid encrypted state"])
  }
  return StateRef(envelope: envelope, deviceKey: deviceKey, context: context)
}

private func openState(_ state: StateRef) throws -> Data {
  try e2eeUnprotectState(envelope: state.envelope, deviceKey: state.deviceKey, context: state.context)
}

private func withState<T>(_ input: [String: Data], _ operation: (StateRef, inout Data) throws -> T) throws -> T {
  var ref = try stateRef(input)
  var raw = try openState(ref)
  defer {
    raw.resetBytes(in: 0..<raw.count)
    ref.envelope.resetBytes(in: 0..<ref.envelope.count)
    ref.deviceKey.resetBytes(in: 0..<ref.deviceKey.count)
    ref.context.resetBytes(in: 0..<ref.context.count)
  }
  return try operation(ref, &raw)
}

private func sealedState(_ raw: inout Data, _ state: StateRef) throws -> [String: Data] {
  defer { raw.resetBytes(in: 0..<raw.count) }
  return [
    "envelope": try e2eeProtectState(state: raw, deviceKey: state.deviceKey, context: state.context),
    "deviceKey": state.deviceKey,
    "context": state.context,
  ]
}

private func memberMap(_ member: ExpectedMember) -> [String: Data] {
  ["identity": member.identity, "signatureKey": member.signatureKey]
}

public class HaloChatE2eeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HaloChatE2ee")

    AsyncFunction("generateDeviceKey") { () throws -> Data in
      var bytes = Data(count: 32)
      let status = bytes.withUnsafeMutableBytes { buffer in
        SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
      }
      guard status == errSecSuccess else {
        throw NSError(domain: "HaloChatE2ee", code: Int(status), userInfo: [NSLocalizedDescriptionKey: "Unable to generate device key"])
      }
      return bytes
    }
    AsyncFunction("protectLocalData") { (data: Data, deviceKey: Data, context: Data) throws -> Data in
      var cleartext = data
      var key = deviceKey
      var aad = context
      defer {
        cleartext.resetBytes(in: 0..<cleartext.count)
        key.resetBytes(in: 0..<key.count)
        aad.resetBytes(in: 0..<aad.count)
      }
      return try e2eeProtectState(state: cleartext, deviceKey: key, context: aad)
    }
    AsyncFunction("unprotectLocalData") { (envelope: Data, deviceKey: Data, context: Data) throws -> Data in
      var protected = envelope
      var key = deviceKey
      var aad = context
      defer {
        protected.resetBytes(in: 0..<protected.count)
        key.resetBytes(in: 0..<key.count)
        aad.resetBytes(in: 0..<aad.count)
      }
      return try e2eeUnprotectState(envelope: protected, deviceKey: key, context: aad)
    }
    AsyncFunction("createDevice") { (identity: Data, deviceKey: Data, context: Data) throws -> [String: Any] in
      var result = try e2eeCreateDevice(identity: identity)
      var state = StateRef(envelope: Data(), deviceKey: deviceKey, context: context)
      defer {
        state.deviceKey.resetBytes(in: 0..<state.deviceKey.count)
        state.context.resetBytes(in: 0..<state.context.count)
      }
      return ["state": try sealedState(&result.state, state), "keyPackage": result.keyPackage]
    }
    AsyncFunction("deviceIdentity") { (input: [String: Data]) throws -> [String: Data] in
      try withState(input) { _, raw in memberMap(try e2eeDeviceIdentity(state: raw)) }
    }
    AsyncFunction("createKeyPackage") { (input: [String: Data]) throws -> [String: Any] in
      try withState(input) { ref, raw in
        var result = try e2eeCreateKeyPackage(state: raw)
        return ["state": try sealedState(&result.state, ref), "keyPackage": result.keyPackage]
      }
    }
    AsyncFunction("createGroup") { (input: [String: Data], groupId: Data, context: Data) throws -> [String: Data] in
      try withState(input) { ref, raw in
        var scopedRef = ref
        scopedRef.context = context
        defer { scopedRef.context.resetBytes(in: 0..<scopedRef.context.count) }
        var created = try e2eeCreateGroup(state: raw, groupId: groupId)
        return try sealedState(&created, scopedRef)
      }
    }
    AsyncFunction("addMember") { (input: [String: Data], keyPackage: Data, expectedMember: [String: Data]) throws -> [String: Any] in
      guard let identity = expectedMember["identity"], let signatureKey = expectedMember["signatureKey"] else {
        throw NSError(domain: "HaloChatE2ee", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid expected member"])
      }
      let member = ExpectedMember(identity: identity, signatureKey: signatureKey)
      return try withState(input) { ref, raw in
        var result = try e2eeAddMember(state: raw, keyPackage: keyPackage, expectedMember: member)
        return ["state": try sealedState(&result.state, ref), "commit": result.commit, "welcome": result.welcome]
      }
    }
    AsyncFunction("joinGroup") { (input: [String: Data], welcome: Data, context: Data) throws -> [String: Data] in
      try withState(input) { ref, raw in
        var scopedRef = ref
        scopedRef.context = context
        defer { scopedRef.context.resetBytes(in: 0..<scopedRef.context.count) }
        var joined = try e2eeJoinGroup(state: raw, welcome: welcome)
        return try sealedState(&joined, scopedRef)
      }
    }
    AsyncFunction("processCommit") { (input: [String: Data], commit: Data, expectedMembers: [[String: Data]]) throws -> [String: Data] in
      let members = try expectedMembers.map { item -> ExpectedMember in
        guard let identity = item["identity"], let signatureKey = item["signatureKey"] else {
          throw NSError(domain: "HaloChatE2ee", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid expected member"])
        }
        return ExpectedMember(identity: identity, signatureKey: signatureKey)
      }
      return try withState(input) { ref, raw in
        var updated = try e2eeProcessCommit(state: raw, commit: commit, expectedMembers: members)
        return try sealedState(&updated, ref)
      }
    }
    AsyncFunction("removeMember") { (input: [String: Data], leafIndex: Int) throws -> [String: Any] in
      guard let index = UInt32(exactly: leafIndex) else {
        throw NSError(domain: "HaloChatE2ee", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid member index"])
      }
      return try withState(input) { ref, raw in
        var result = try e2eeRemoveMember(state: raw, leafIndex: index)
        return ["state": try sealedState(&result.state, ref), "commit": result.commit]
      }
    }
    AsyncFunction("encryptApplication") { (input: [String: Data], plaintext: Data) throws -> [String: Any] in
      var cleartext = plaintext
      defer { cleartext.resetBytes(in: 0..<cleartext.count) }
      return try withState(input) { ref, raw in
        var result = try e2eeEncryptApplication(state: raw, plaintext: cleartext)
        return ["state": try sealedState(&result.state, ref), "message": result.message]
      }
    }
    AsyncFunction("decryptApplication") { (input: [String: Data], message: Data) throws -> [String: Any] in
      try withState(input) { ref, raw in
        var result = try e2eeDecryptApplication(state: raw, message: message)
        return ["state": try sealedState(&result.state, ref), "message": result.message]
      }
    }
    AsyncFunction("groupMembers") { (input: [String: Data]) throws -> [[String: Data]] in
      try withState(input) { _, raw in try e2eeGroupMembers(state: raw).map(memberMap) }
    }
  }
}
