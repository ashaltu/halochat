use js_sys::{Object, Reflect, Uint8Array};
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

#[wasm_bindgen(js_name = createDevice)]
pub fn create_device(identity: Vec<u8>) -> Result<JsValue, JsValue> {
    let (state, key_package) = super::create_device(&identity).map_err(to_js_error)?;
    object_with_bytes(&[("state", &state), ("keyPackage", &key_package)])
}

#[wasm_bindgen(js_name = createGroup)]
pub fn create_group(state: Vec<u8>, group_id: Vec<u8>) -> Result<Vec<u8>, JsValue> {
    super::create_group(&state, &group_id).map_err(to_js_error)
}

#[wasm_bindgen(js_name = addMember)]
pub fn add_member(state: Vec<u8>, key_package: Vec<u8>) -> Result<JsValue, JsValue> {
    let result = super::add_member(&state, &key_package).map_err(to_js_error)?;
    object_with_bytes(&[
        ("state", &result.state),
        ("commit", &result.commit),
        ("welcome", &result.welcome),
    ])
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
