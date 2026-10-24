use js_sys::{Array, Object, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;

fn bytes_field(object: &Object, key: &str, bytes: &[u8]) -> Result<(), JsValue> {
    Reflect::set(
        object,
        &JsValue::from_str(key),
        &Uint8Array::from(bytes).into(),
    )
    .map(|_| ())
}

fn object_with_bytes(fields: &[(&str, &[u8])]) -> Result<JsValue, JsValue> {
    let object = Object::new();
    for (key, value) in fields {
        bytes_field(&object, key, value)?;
    }
    Ok(object.into())
}

fn to_js_error(error: String) -> JsValue {
    JsValue::from_str(&error)
}

#[wasm_bindgen(js_name = protectState)]
pub fn protect_state(
    state: Vec<u8>,
    device_key: Vec<u8>,
    context: Vec<u8>,
) -> Result<Vec<u8>, JsValue> {
    super::protect_state(&state, &device_key, &context).map_err(to_js_error)
}

#[wasm_bindgen(js_name = unprotectState)]
pub fn unprotect_state(
    envelope: Vec<u8>,
    device_key: Vec<u8>,
    context: Vec<u8>,
) -> Result<Vec<u8>, JsValue> {
    super::unprotect_state(&envelope, &device_key, &context).map_err(to_js_error)
}

fn parse_expected_members(encoded: &[u8]) -> Result<Vec<super::ExpectedMember>, JsValue> {
    serde_json::from_slice(encoded).map_err(|error| JsValue::from_str(&error.to_string()))
}

fn member_value(member: &super::ExpectedMember) -> Result<JsValue, JsValue> {
    object_with_bytes(&[
        ("identity", &member.identity),
        ("signatureKey", &member.signature_key),
    ])
}

#[wasm_bindgen(js_name = deviceIdentity)]
pub fn device_identity(state: Vec<u8>) -> Result<JsValue, JsValue> {
    let member = super::device_identity(&state).map_err(to_js_error)?;
    member_value(&member)
}

#[wasm_bindgen(js_name = signDeviceBinding)]
pub fn sign_device_binding(
    state: Vec<u8>,
    account_id: Vec<u8>,
    device_id: Vec<u8>,
) -> Result<Vec<u8>, JsValue> {
    super::sign_device_binding(&state, &account_id, &device_id).map_err(to_js_error)
}

#[wasm_bindgen(js_name = verifyDeviceBinding)]
pub fn verify_device_binding(
    account_id: Vec<u8>,
    device_id: Vec<u8>,
    identity: Vec<u8>,
    signature_key: Vec<u8>,
    signature_proof: Vec<u8>,
) -> bool {
    super::verify_device_binding(
        &account_id,
        &device_id,
        &identity,
        &signature_key,
        &signature_proof,
    )
}

#[wasm_bindgen(js_name = groupMembers)]
pub fn group_members(state: Vec<u8>) -> Result<JsValue, JsValue> {
    let members = super::group_members(&state).map_err(to_js_error)?;
    let result = Array::new();
    for member in members {
        result.push(&member_value(&member)?);
    }
    Ok(result.into())
}

#[wasm_bindgen(js_name = safetyFingerprint)]
pub fn safety_fingerprint(state: Vec<u8>) -> Result<Vec<u8>, JsValue> {
    super::safety_fingerprint(&state).map_err(to_js_error)
}

#[wasm_bindgen(js_name = createDevice)]
pub fn create_device(identity: Vec<u8>) -> Result<JsValue, JsValue> {
    let (state, key_package) = super::create_device(&identity).map_err(to_js_error)?;
    object_with_bytes(&[("state", &state), ("keyPackage", &key_package)])
}

#[wasm_bindgen(js_name = createKeyPackage)]
pub fn create_key_package(state: Vec<u8>) -> Result<JsValue, JsValue> {
    let (state, key_package) = super::create_key_package(&state).map_err(to_js_error)?;
    object_with_bytes(&[("state", &state), ("keyPackage", &key_package)])
}

#[wasm_bindgen(js_name = createGroup)]
pub fn create_group(state: Vec<u8>, group_id: Vec<u8>) -> Result<Vec<u8>, JsValue> {
    super::create_group(&state, &group_id).map_err(to_js_error)
}

#[wasm_bindgen(js_name = addMember)]
pub fn add_member(
    state: Vec<u8>,
    key_package: Vec<u8>,
    expected_member: Vec<u8>,
) -> Result<JsValue, JsValue> {
    let expected_member: super::ExpectedMember = serde_json::from_slice(&expected_member)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let result = super::add_member(&state, &key_package, &expected_member).map_err(to_js_error)?;
    object_with_bytes(&[
        ("state", &result.state),
        ("commit", &result.commit),
        ("welcome", &result.welcome),
    ])
}

#[wasm_bindgen(js_name = processCommit)]
pub fn process_commit(
    state: Vec<u8>,
    commit: Vec<u8>,
    expected_members: Vec<u8>,
) -> Result<Vec<u8>, JsValue> {
    let members = parse_expected_members(&expected_members)?;
    super::process_commit(&state, &commit, &members).map_err(to_js_error)
}

#[wasm_bindgen(js_name = removeMember)]
pub fn remove_member(state: Vec<u8>, leaf_index: u32) -> Result<JsValue, JsValue> {
    let result = super::remove_member(&state, leaf_index).map_err(to_js_error)?;
    object_with_bytes(&[("state", &result.state), ("commit", &result.commit)])
}

#[wasm_bindgen(js_name = joinGroup)]
pub fn join_group(state: Vec<u8>, welcome: Vec<u8>) -> Result<Vec<u8>, JsValue> {
    super::join_group(&state, &welcome).map_err(to_js_error)
}

#[wasm_bindgen(js_name = encryptApplication)]
pub fn encrypt_application(state: Vec<u8>, plaintext: Vec<u8>) -> Result<JsValue, JsValue> {
    let (state, ciphertext) =
        super::encrypt_application(&state, &plaintext).map_err(to_js_error)?;
    object_with_bytes(&[("state", &state), ("ciphertext", &ciphertext)])
}

#[wasm_bindgen(js_name = decryptApplication)]
pub fn decrypt_application(state: Vec<u8>, message: Vec<u8>) -> Result<JsValue, JsValue> {
    let (state, plaintext) = super::decrypt_application(&state, &message).map_err(to_js_error)?;
    object_with_bytes(&[("state", &state), ("plaintext", &plaintext)])
}
