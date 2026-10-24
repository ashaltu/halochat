package expo.modules.halochate2ee

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import uniffi.halochat_e2ee_core.*
import java.security.SecureRandom

private data class StateRef(val envelope: ByteArray, val deviceKey: ByteArray, val context: ByteArray)

private fun Map<String, ByteArray>.stateRef() = StateRef(
  getValue("envelope").copyOf(),
  getValue("deviceKey").copyOf(),
  getValue("context").copyOf(),
)

private fun openState(state: StateRef) = e2eeUnprotectState(state.envelope, state.deviceKey, state.context)

private inline fun <T> withState(input: Map<String, ByteArray>, block: (StateRef, ByteArray) -> T): T {
  val state = input.stateRef()
  try {
    val raw = openState(state)
    try {
      return block(state, raw)
    } finally {
      raw.fill(0)
    }
  } finally {
    state.envelope.fill(0)
    state.deviceKey.fill(0)
    state.context.fill(0)
  }
}

private fun sealedState(raw: ByteArray, state: StateRef): Map<String, ByteArray> = try {
  mapOf(
    "envelope" to e2eeProtectState(raw, state.deviceKey, state.context),
    "deviceKey" to state.deviceKey.copyOf(),
    "context" to state.context.copyOf(),
  )
} finally {
  raw.fill(0)
}

private fun ExpectedMember.asMap() = mapOf("identity" to identity, "signatureKey" to signatureKey)

class HaloChatE2eeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HaloChatE2ee")

    AsyncFunction("generateDeviceKey") {
      ByteArray(32).also { SecureRandom().nextBytes(it) }
    }
    AsyncFunction("protectLocalData") { data: ByteArray, deviceKey: ByteArray, context: ByteArray ->
      try {
        e2eeProtectState(data, deviceKey, context)
      } finally {
        data.fill(0)
        deviceKey.fill(0)
        context.fill(0)
      }
    }
    AsyncFunction("unprotectLocalData") { envelope: ByteArray, deviceKey: ByteArray, context: ByteArray ->
      try {
        e2eeUnprotectState(envelope, deviceKey, context)
      } finally {
        envelope.fill(0)
        deviceKey.fill(0)
        context.fill(0)
      }
    }
    AsyncFunction("createDevice") { identity: ByteArray, deviceKey: ByteArray, context: ByteArray ->
      val state = StateRef(ByteArray(0), deviceKey.copyOf(), context.copyOf())
      try {
        val created = e2eeCreateDevice(identity)
        mapOf("state" to sealedState(created.state, state), "keyPackage" to created.keyPackage)
      } finally {
        state.deviceKey.fill(0)
        state.context.fill(0)
      }
    }
    AsyncFunction("deviceIdentity") { input: Map<String, ByteArray> ->
      withState(input) { _, raw -> e2eeDeviceIdentity(raw).asMap() }
    }
    AsyncFunction("signDeviceBinding") { input: Map<String, ByteArray>, accountId: ByteArray, deviceId: ByteArray ->
      withState(input) { _, raw -> e2eeSignDeviceBinding(raw, accountId, deviceId) }
    }
    AsyncFunction("createKeyPackage") { input: Map<String, ByteArray> ->
      withState(input) { ref, raw ->
        val result = e2eeCreateKeyPackage(raw)
        mapOf("state" to sealedState(result.state, ref), "keyPackage" to result.keyPackage)
      }
    }
    AsyncFunction("createGroup") { input: Map<String, ByteArray>, groupId: ByteArray, context: ByteArray ->
      withState(input) { ref, raw ->
        val scopedRef = ref.copy(context = context.copyOf())
        try {
          sealedState(e2eeCreateGroup(raw, groupId), scopedRef)
        } finally {
          scopedRef.context.fill(0)
        }
      }
    }
    AsyncFunction("addMember") { input: Map<String, ByteArray>, keyPackage: ByteArray, expectedMember: Map<String, ByteArray> ->
      val member = ExpectedMember(expectedMember.getValue("identity"), expectedMember.getValue("signatureKey"))
      withState(input) { ref, raw ->
        val result = e2eeAddMember(raw, keyPackage, member)
        mapOf("state" to sealedState(result.state, ref), "commit" to result.commit, "welcome" to result.welcome)
      }
    }
    AsyncFunction("joinGroup") { input: Map<String, ByteArray>, welcome: ByteArray, context: ByteArray ->
      withState(input) { ref, raw ->
        val scopedRef = ref.copy(context = context.copyOf())
        try {
          sealedState(e2eeJoinGroup(raw, welcome), scopedRef)
        } finally {
          scopedRef.context.fill(0)
        }
      }
    }
    AsyncFunction("processCommit") { input: Map<String, ByteArray>, commit: ByteArray, expectedMembers: List<Map<String, ByteArray>> ->
      val members = expectedMembers.map { ExpectedMember(it.getValue("identity"), it.getValue("signatureKey")) }
      withState(input) { ref, raw -> sealedState(e2eeProcessCommit(raw, commit, members), ref) }
    }
    AsyncFunction("removeMember") { input: Map<String, ByteArray>, leafIndex: Int ->
      withState(input) { ref, raw ->
        val result = e2eeRemoveMember(raw, leafIndex.toUInt())
        mapOf("state" to sealedState(result.state, ref), "commit" to result.commit)
      }
    }
    AsyncFunction("encryptApplication") { input: Map<String, ByteArray>, plaintext: ByteArray ->
      try {
        withState(input) { ref, raw ->
          val result = e2eeEncryptApplication(raw, plaintext)
          mapOf("state" to sealedState(result.state, ref), "message" to result.message)
        }
      } finally {
        plaintext.fill(0)
      }
    }
    AsyncFunction("decryptApplication") { input: Map<String, ByteArray>, message: ByteArray ->
      withState(input) { ref, raw ->
        val result = e2eeDecryptApplication(raw, message)
        mapOf("state" to sealedState(result.state, ref), "message" to result.message)
      }
    }
    AsyncFunction("groupMembers") { input: Map<String, ByteArray> ->
      withState(input) { _, raw -> e2eeGroupMembers(raw).map { it.asMap() } }
    }
    AsyncFunction("safetyFingerprint") { input: Map<String, ByteArray> ->
      withState(input) { _, raw -> e2eeSafetyFingerprint(raw) }
    }
  }
}
