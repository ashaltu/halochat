use super::{ExpectedMember, GroupCommitResult};
use std::fmt::{Display, Formatter};

#[derive(Debug, uniffi::Error)]
pub enum E2eeError {
    Operation { message: String },
}

impl Display for E2eeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Operation { message } => formatter.write_str(message),
        }
    }
}

impl std::error::Error for E2eeError {}

impl From<String> for E2eeError {
    fn from(message: String) -> Self {
        Self::Operation { message }
    }
}

#[derive(uniffi::Record)]
pub struct DeviceResult {
    pub state: Vec<u8>,
    pub key_package: Vec<u8>,
}

#[derive(uniffi::Record)]
pub struct AddMemberResult {
    pub state: Vec<u8>,
    pub commit: Vec<u8>,
    pub welcome: Vec<u8>,
}

#[derive(uniffi::Record)]
pub struct CommitResult {
    pub state: Vec<u8>,
    pub commit: Vec<u8>,
}

#[derive(uniffi::Record)]
pub struct ApplicationResult {
    pub state: Vec<u8>,
    pub message: Vec<u8>,
}

impl From<GroupCommitResult> for CommitResult {
    fn from(result: GroupCommitResult) -> Self {
        Self {
            state: result.state,
            commit: result.commit,
        }
    }
}

#[uniffi::export]
pub fn e2ee_protect_state(
    state: Vec<u8>,
    device_key: Vec<u8>,
    context: Vec<u8>,
) -> Result<Vec<u8>, E2eeError> {
    super::protect_state(&state, &device_key, &context).map_err(Into::into)
}

#[uniffi::export]
pub fn e2ee_unprotect_state(
    envelope: Vec<u8>,
    device_key: Vec<u8>,
    context: Vec<u8>,
) -> Result<Vec<u8>, E2eeError> {
    super::unprotect_state(&envelope, &device_key, &context).map_err(Into::into)
}

#[uniffi::export]
pub fn e2ee_device_identity(state: Vec<u8>) -> Result<ExpectedMember, E2eeError> {
    super::device_identity(&state).map_err(Into::into)
}

#[uniffi::export]
pub fn e2ee_group_members(state: Vec<u8>) -> Result<Vec<ExpectedMember>, E2eeError> {
    super::group_members(&state).map_err(Into::into)
}

#[uniffi::export]
pub fn e2ee_create_device(identity: Vec<u8>) -> Result<DeviceResult, E2eeError> {
    let (state, key_package) = super::create_device(&identity)?;
    Ok(DeviceResult { state, key_package })
}

#[uniffi::export]
pub fn e2ee_create_group(state: Vec<u8>, group_id: Vec<u8>) -> Result<Vec<u8>, E2eeError> {
    super::create_group(&state, &group_id).map_err(Into::into)
}

#[uniffi::export]
pub fn e2ee_add_member(
    state: Vec<u8>,
    key_package: Vec<u8>,
    expected_member: ExpectedMember,
) -> Result<AddMemberResult, E2eeError> {
    let result = super::add_member(&state, &key_package, &expected_member)?;
    Ok(AddMemberResult {
        state: result.state,
        commit: result.commit,
        welcome: result.welcome,
    })
}

#[uniffi::export]
pub fn e2ee_process_commit(
    state: Vec<u8>,
    commit: Vec<u8>,
    expected_members: Vec<ExpectedMember>,
) -> Result<Vec<u8>, E2eeError> {
    super::process_commit(&state, &commit, &expected_members).map_err(Into::into)
}

#[uniffi::export]
pub fn e2ee_remove_member(state: Vec<u8>, leaf_index: u32) -> Result<CommitResult, E2eeError> {
    super::remove_member(&state, leaf_index)
        .map(Into::into)
        .map_err(Into::into)
}

#[uniffi::export]
pub fn e2ee_join_group(state: Vec<u8>, welcome: Vec<u8>) -> Result<Vec<u8>, E2eeError> {
    super::join_group(&state, &welcome).map_err(Into::into)
}

#[uniffi::export]
pub fn e2ee_encrypt_application(
    state: Vec<u8>,
    plaintext: Vec<u8>,
) -> Result<ApplicationResult, E2eeError> {
    let (state, message) = super::encrypt_application(&state, &plaintext)?;
    Ok(ApplicationResult { state, message })
}

#[uniffi::export]
pub fn e2ee_decrypt_application(
    state: Vec<u8>,
    message: Vec<u8>,
) -> Result<ApplicationResult, E2eeError> {
    let (state, message) = super::decrypt_application(&state, &message)?;
    Ok(ApplicationResult { state, message })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exported_api_round_trips_group_messages_and_state_protection() {
        let alice = e2ee_create_device(b"alice/device-1".to_vec()).unwrap();
        let bob = e2ee_create_device(b"bob/device-1".to_vec()).unwrap();
        let alice_group = e2ee_create_group(alice.state, b"ffi-group".to_vec()).unwrap();
        let bob_member = e2ee_device_identity(bob.state.clone()).unwrap();
        let added = e2ee_add_member(alice_group, bob.key_package, bob_member).unwrap();
        let bob_group = e2ee_join_group(bob.state, added.welcome).unwrap();

        let sent = e2ee_encrypt_application(added.state, b"ffi message".to_vec()).unwrap();
        let received = e2ee_decrypt_application(bob_group, sent.message).unwrap();
        assert_eq!(received.message, b"ffi message");

        let key = vec![7; super::super::STATE_KEY_LENGTH];
        let context = b"account:alice/device:1/group:ffi-group".to_vec();
        let protected =
            e2ee_protect_state(sent.state.clone(), key.clone(), context.clone()).unwrap();
        assert_eq!(
            e2ee_unprotect_state(protected, key, context).unwrap(),
            sent.state
        );
    }
}
