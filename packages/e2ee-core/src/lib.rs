//! MLS protocol core for HaloChat.
//!
//! Snapshots contain private keys and group secrets. Callers must encrypt them
//! at rest and atomically persist each new snapshot with its outgoing wire data.
//! The basic credential is not HaloChat identity authentication.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use openmls::prelude::{
    BasicCredential, Ciphersuite, CredentialWithKey, KeyPackage, KeyPackageIn, MlsGroup,
    MlsGroupCreateConfig, MlsGroupJoinConfig, MlsMessageBodyIn, MlsMessageIn, MlsMessageOut,
    OpenMlsProvider, ProcessedMessageContent, ProtocolMessage, StagedWelcome,
};
use openmls_basic_credential::SignatureKeyPair;
#[cfg(test)]
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_rust_crypto::{MemoryStorage, RustCrypto};
use openmls_traits::random::OpenMlsRand;
use openmls_traits::signatures::Signer;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use tls_codec::{Deserialize as TlsDeserialize, Serialize as TlsSerialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

#[cfg(feature = "native-bindings")]
mod ffi;
#[cfg(target_arch = "wasm32")]
mod wasm;

#[cfg(feature = "native-bindings")]
uniffi::setup_scaffolding!();

const SUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
const STATE_VERSION: u32 = 1;
const STATE_ENVELOPE_MAGIC: &[u8; 4] = b"HCE1";
const STATE_NONCE_LENGTH: usize = 12;
const STATE_KEY_LENGTH: usize = 32;
const STATE_CONTEXT_MAX_LENGTH: usize = 1024;

pub struct AddMemberResult {
    pub state: Vec<u8>,
    pub commit: Vec<u8>,
    pub welcome: Vec<u8>,
}

pub struct GroupCommitResult {
    pub state: Vec<u8>,
    pub commit: Vec<u8>,
}

#[cfg_attr(feature = "native-bindings", derive(uniffi::Record))]
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExpectedMember {
    pub identity: Vec<u8>,
    pub signature_key: Vec<u8>,
}

pub fn protect_state(state: &[u8], device_key: &[u8], context: &[u8]) -> Result<Vec<u8>, String> {
    if device_key.len() != STATE_KEY_LENGTH {
        return Err("MLS state key must be 32 bytes".to_owned());
    }
    if context.is_empty() || context.len() > STATE_CONTEXT_MAX_LENGTH {
        return Err("MLS state context length is invalid".to_owned());
    }
    let provider = RustCrypto::default();
    let nonce = provider
        .random_array::<STATE_NONCE_LENGTH>()
        .map_err(|error| error.to_string())?;
    let cipher = Aes256Gcm::new_from_slice(device_key).map_err(|error| error.to_string())?;
    let mut aad = Vec::with_capacity(STATE_ENVELOPE_MAGIC.len() + context.len());
    aad.extend_from_slice(STATE_ENVELOPE_MAGIC);
    aad.extend_from_slice(context);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: state,
                aad: &aad,
            },
        )
        .map_err(|_| "Unable to encrypt MLS state".to_owned())?;
    let mut envelope =
        Vec::with_capacity(STATE_ENVELOPE_MAGIC.len() + nonce.len() + ciphertext.len());
    envelope.extend_from_slice(STATE_ENVELOPE_MAGIC);
    envelope.extend_from_slice(&nonce);
    envelope.extend_from_slice(&ciphertext);
    Ok(envelope)
}

pub fn unprotect_state(
    envelope: &[u8],
    device_key: &[u8],
    context: &[u8],
) -> Result<Vec<u8>, String> {
    if device_key.len() != STATE_KEY_LENGTH {
        return Err("MLS state key must be 32 bytes".to_owned());
    }
    if context.is_empty() || context.len() > STATE_CONTEXT_MAX_LENGTH {
        return Err("MLS state context length is invalid".to_owned());
    }
    let minimum_length = STATE_ENVELOPE_MAGIC.len() + STATE_NONCE_LENGTH + 16;
    if envelope.len() < minimum_length || !envelope.starts_with(STATE_ENVELOPE_MAGIC) {
        return Err("Invalid MLS state envelope".to_owned());
    }
    let nonce_start = STATE_ENVELOPE_MAGIC.len();
    let ciphertext_start = nonce_start + STATE_NONCE_LENGTH;
    let cipher = Aes256Gcm::new_from_slice(device_key).map_err(|error| error.to_string())?;
    let mut aad = Vec::with_capacity(STATE_ENVELOPE_MAGIC.len() + context.len());
    aad.extend_from_slice(STATE_ENVELOPE_MAGIC);
    aad.extend_from_slice(context);
    cipher
        .decrypt(
            Nonce::from_slice(&envelope[nonce_start..ciphertext_start]),
            Payload {
                msg: &envelope[ciphertext_start..],
                aad: &aad,
            },
        )
        .map_err(|_| "Unable to authenticate MLS state envelope".to_owned())
}

#[derive(Deserialize, Serialize, Zeroize, ZeroizeOnDrop)]
struct StateSnapshot {
    version: u32,
    group_id: Option<Vec<u8>>,
    identity: Vec<u8>,
    signature_public_key: Vec<u8>,
    storage: Vec<StorageEntry>,
}

#[derive(Deserialize, Serialize, Zeroize, ZeroizeOnDrop)]
struct StorageEntry {
    key: Vec<u8>,
    value: Vec<u8>,
}

#[derive(Default)]
struct HaloProvider {
    crypto: RustCrypto,
    storage: MemoryStorage,
}

impl OpenMlsProvider for HaloProvider {
    type CryptoProvider = RustCrypto;
    type RandProvider = RustCrypto;
    type StorageProvider = MemoryStorage;

    fn storage(&self) -> &Self::StorageProvider {
        &self.storage
    }

    fn crypto(&self) -> &Self::CryptoProvider {
        &self.crypto
    }

    fn rand(&self) -> &Self::RandProvider {
        &self.crypto
    }
}

impl Drop for HaloProvider {
    fn drop(&mut self) {
        if let Ok(values) = self.storage.values.get_mut() {
            for (mut key, mut value) in values.drain() {
                key.zeroize();
                value.zeroize();
            }
        }
    }
}

fn encode_state(
    provider: &HaloProvider,
    identity: Vec<u8>,
    signature_public_key: Vec<u8>,
    group_id: Option<Vec<u8>>,
) -> Result<Vec<u8>, String> {
    let values = provider
        .storage()
        .values
        .read()
        .map_err(|_| "MLS storage lock is poisoned".to_owned())?;
    let snapshot = StateSnapshot {
        version: STATE_VERSION,
        group_id,
        identity,
        signature_public_key,
        storage: values
            .iter()
            .map(|(key, value)| StorageEntry {
                key: key.clone(),
                value: value.clone(),
            })
            .collect(),
    };
    serde_json::to_vec(&snapshot).map_err(|error| error.to_string())
}

fn decode_state(encoded: &[u8]) -> Result<(StateSnapshot, HaloProvider), String> {
    let snapshot: StateSnapshot =
        serde_json::from_slice(encoded).map_err(|error| error.to_string())?;
    if snapshot.version != STATE_VERSION {
        return Err("Unsupported MLS state version".to_owned());
    }

    let provider = HaloProvider::default();
    let values = snapshot
        .storage
        .iter()
        .map(|entry| (entry.key.clone(), entry.value.clone()))
        .collect::<HashMap<_, _>>();
    *provider
        .storage()
        .values
        .write()
        .map_err(|_| "MLS storage lock is poisoned".to_owned())? = values;
    Ok((snapshot, provider))
}

fn load_group(
    snapshot: &StateSnapshot,
    provider: &HaloProvider,
) -> Result<(MlsGroup, SignatureKeyPair), String> {
    let group_id = snapshot
        .group_id
        .as_deref()
        .ok_or_else(|| "MLS state has no group".to_owned())?;
    let group = MlsGroup::load(
        provider.storage(),
        &openmls::prelude::GroupId::from_slice(group_id),
    )
    .map_err(|error| error.to_string())?
    .ok_or_else(|| "MLS group state is missing".to_owned())?;
    let signer = SignatureKeyPair::read(
        provider.storage(),
        &snapshot.signature_public_key,
        SUITE.signature_algorithm(),
    )
    .ok_or_else(|| "MLS signing key is missing".to_owned())?;
    Ok((group, signer))
}

fn expected_members_for_group(group: &MlsGroup) -> Result<Vec<ExpectedMember>, String> {
    let mut members = group
        .members()
        .map(|member| {
            let credential = BasicCredential::try_from(member.credential)
                .map_err(|error| format!("Unsupported MLS credential: {error}"))?;
            Ok(ExpectedMember {
                identity: credential.identity().to_vec(),
                signature_key: member.signature_key,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    members.sort_by(|left, right| {
        left.identity
            .cmp(&right.identity)
            .then(left.signature_key.cmp(&right.signature_key))
    });
    if members
        .iter()
        .any(|member| member.identity.is_empty() || member.signature_key.is_empty())
    {
        return Err("MLS group contains an incomplete device identity".to_owned());
    }
    if members
        .windows(2)
        .any(|pair| pair[0].identity == pair[1].identity)
    {
        return Err("MLS group has duplicate device identities".to_owned());
    }
    Ok(members)
}

fn verify_expected_members(
    group: &MlsGroup,
    expected_members: &[ExpectedMember],
) -> Result<(), String> {
    let actual = expected_members_for_group(group)?;
    let mut expected = expected_members.to_vec();
    expected.sort_by(|left, right| {
        left.identity
            .cmp(&right.identity)
            .then(left.signature_key.cmp(&right.signature_key))
    });
    if expected
        .iter()
        .any(|member| member.identity.is_empty() || member.signature_key.is_empty())
    {
        return Err("Expected MLS roster contains an incomplete device identity".to_owned());
    }
    if expected
        .windows(2)
        .any(|pair| pair[0].identity == pair[1].identity)
    {
        return Err("Expected MLS roster has duplicate device identities".to_owned());
    }
    if actual != expected {
        return Err("MLS commit does not match the expected device roster".to_owned());
    }
    Ok(())
}

pub fn device_identity(state: &[u8]) -> Result<ExpectedMember, String> {
    let (snapshot, _) = decode_state(state)?;
    Ok(ExpectedMember {
        identity: snapshot.identity.clone(),
        signature_key: snapshot.signature_public_key.clone(),
    })
}

pub fn sign_device_binding(
    state: &[u8],
    account_id: &[u8],
    device_id: &[u8],
) -> Result<Vec<u8>, String> {
    if account_id.is_empty()
        || device_id.is_empty()
        || account_id.len() > 256
        || device_id.len() > 256
    {
        return Err("MLS account and device identifiers are invalid".to_owned());
    }
    if account_id
        .iter()
        .chain(device_id)
        .any(|byte| *byte == 0 || !byte.is_ascii())
    {
        return Err(
            "MLS account and device identifiers must be ASCII without NUL bytes".to_owned(),
        );
    }

    let (snapshot, provider) = decode_state(state)?;
    let expected_identity = [
        b"halochat:user:".as_slice(),
        account_id,
        b":device:",
        device_id,
    ]
    .concat();
    if snapshot.identity != expected_identity {
        return Err("MLS device identity does not match its account and device".to_owned());
    }

    let signer = SignatureKeyPair::read(
        provider.storage(),
        &snapshot.signature_public_key,
        SUITE.signature_algorithm(),
    )
    .ok_or_else(|| "MLS signing key is missing".to_owned())?;
    let message = device_binding_message(
        account_id,
        device_id,
        &snapshot.identity,
        &snapshot.signature_public_key,
    );
    signer
        .sign(&message)
        .map_err(|_| "Unable to sign MLS device binding".to_owned())
}

pub fn verify_device_binding(
    account_id: &[u8],
    device_id: &[u8],
    identity: &[u8],
    signature_key: &[u8],
    signature_proof: &[u8],
) -> bool {
    use ed25519_dalek::{Signature, VerifyingKey};

    if account_id.is_empty()
        || device_id.is_empty()
        || signature_key.len() != 32
        || signature_proof.len() != 64
    {
        return false;
    }
    let mut expected_identity = b"halochat:user:".to_vec();
    expected_identity.extend_from_slice(account_id);
    expected_identity.extend_from_slice(b":device:");
    expected_identity.extend_from_slice(device_id);
    if identity != expected_identity {
        return false;
    }
    let Ok(key_bytes) = <&[u8; 32]>::try_from(signature_key) else {
        return false;
    };
    let Ok(proof_bytes) = <&[u8; 64]>::try_from(signature_proof) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(key_bytes) else {
        return false;
    };
    let message = device_binding_message(account_id, device_id, identity, signature_key);
    key.verify_strict(&message, &Signature::from_bytes(proof_bytes))
        .is_ok()
}

fn device_binding_message(
    account_id: &[u8],
    device_id: &[u8],
    identity: &[u8],
    signature_key: &[u8],
) -> Vec<u8> {
    let fields = [account_id, device_id, identity, signature_key];
    let mut message = b"halochat:device-binding:v1".to_vec();
    for field in fields {
        message.extend_from_slice(&(field.len() as u32).to_be_bytes());
        message.extend_from_slice(field);
    }
    message
}

pub fn group_members(state: &[u8]) -> Result<Vec<ExpectedMember>, String> {
    let (snapshot, provider) = decode_state(state)?;
    let (group, _) = load_group(&snapshot, &provider)?;
    expected_members_for_group(&group)
}

fn hash_fingerprint_field(hash: &mut Sha256, value: &[u8]) {
    hash.update((value.len() as u64).to_be_bytes());
    hash.update(value);
}

pub fn safety_fingerprint(state: &[u8]) -> Result<Vec<u8>, String> {
    let (snapshot, provider) = decode_state(state)?;
    let (group, _) = load_group(&snapshot, &provider)?;
    let members = expected_members_for_group(&group)?;
    let mut hash = Sha256::new();
    hash.update(b"halochat:mls-safety-fingerprint:v1");
    hash_fingerprint_field(&mut hash, group.group_id().as_slice());
    for member in members {
        hash_fingerprint_field(&mut hash, &member.identity);
        hash_fingerprint_field(&mut hash, &member.signature_key);
    }
    Ok(hash.finalize().to_vec())
}

fn encode_message(message: &MlsMessageOut) -> Result<Vec<u8>, String> {
    message
        .tls_serialize_detached()
        .map_err(|error| error.to_string())
}

fn decode_protocol_message(encoded: &[u8]) -> Result<ProtocolMessage, String> {
    MlsMessageIn::tls_deserialize_exact(encoded)
        .map_err(|error| error.to_string())?
        .try_into_protocol_message()
        .map_err(|error| error.to_string())
}

pub fn create_device(identity: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    if identity.is_empty() {
        return Err("MLS device identity cannot be empty".to_owned());
    }
    let provider = HaloProvider::default();
    let credential = BasicCredential::new(identity.to_vec());
    let signer =
        SignatureKeyPair::new(SUITE.signature_algorithm()).map_err(|error| error.to_string())?;
    signer
        .store(provider.storage())
        .map_err(|error| error.to_string())?;
    let encoded_key_package = create_key_package_for_device(&provider, credential, &signer)?;
    let state = encode_state(&provider, identity.to_vec(), signer.to_public_vec(), None)?;
    Ok((state, encoded_key_package))
}

fn create_key_package_for_device(
    provider: &HaloProvider,
    credential: BasicCredential,
    signer: &SignatureKeyPair,
) -> Result<Vec<u8>, String> {
    let credential_with_key = CredentialWithKey {
        credential: credential.into(),
        signature_key: signer.public().into(),
    };
    KeyPackage::builder()
        .build(SUITE, provider, signer, credential_with_key)
        .map_err(|error| error.to_string())?
        .key_package()
        .tls_serialize_detached()
        .map_err(|error| error.to_string())
}

pub fn create_key_package(state: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    let (snapshot, provider) = decode_state(state)?;
    let signer = SignatureKeyPair::read(
        provider.storage(),
        &snapshot.signature_public_key,
        SUITE.signature_algorithm(),
    )
    .ok_or_else(|| "MLS signing key is missing".to_owned())?;
    let key_package = create_key_package_for_device(
        &provider,
        BasicCredential::new(snapshot.identity.clone()),
        &signer,
    )?;
    let updated_state = encode_state(
        &provider,
        snapshot.identity.clone(),
        snapshot.signature_public_key.clone(),
        snapshot.group_id.clone(),
    )?;
    Ok((updated_state, key_package))
}

pub fn create_group(state: &[u8], group_id: &[u8]) -> Result<Vec<u8>, String> {
    if group_id.is_empty() {
        return Err("MLS group id cannot be empty".to_owned());
    }
    let (mut snapshot, provider) = decode_state(state)?;
    if snapshot.group_id.is_some() {
        return Err("MLS device already belongs to a group".to_owned());
    }
    let signer = SignatureKeyPair::read(
        provider.storage(),
        &snapshot.signature_public_key,
        SUITE.signature_algorithm(),
    )
    .ok_or_else(|| "MLS signing key is missing".to_owned())?;
    let credential = BasicCredential::new(snapshot.identity.clone());
    let credential_with_key = CredentialWithKey {
        credential: credential.into(),
        signature_key: signer.public().into(),
    };
    let config = MlsGroupCreateConfig::builder()
        .ciphersuite(SUITE)
        .use_ratchet_tree_extension(true)
        .build();
    let group = MlsGroup::new_with_group_id(
        &provider,
        &signer,
        &config,
        openmls::prelude::GroupId::from_slice(group_id),
        credential_with_key,
    )
    .map_err(|error| error.to_string())?;
    snapshot.group_id = Some(group.group_id().as_slice().to_vec());
    encode_state(
        &provider,
        snapshot.identity.clone(),
        snapshot.signature_public_key.clone(),
        snapshot.group_id.clone(),
    )
}

pub fn add_member(
    state: &[u8],
    encoded_key_package: &[u8],
    expected_member: &ExpectedMember,
) -> Result<AddMemberResult, String> {
    let (snapshot, provider) = decode_state(state)?;
    let (mut group, signer) = load_group(&snapshot, &provider)?;
    if expected_member.identity.is_empty() || expected_member.signature_key.is_empty() {
        return Err("Expected MLS device identity cannot be empty".to_owned());
    }
    let mut expected_members = expected_members_for_group(&group)?;
    if expected_members
        .iter()
        .any(|member| member.identity == expected_member.identity)
    {
        return Err("MLS device identity is already a group member".to_owned());
    }
    let key_package = KeyPackageIn::tls_deserialize_exact(encoded_key_package)
        .map_err(|error| error.to_string())?
        .validate(provider.crypto(), openmls::prelude::ProtocolVersion::Mls10)
        .map_err(|error| error.to_string())?;
    let (commit, welcome, _) = group
        .add_members(&provider, &signer, &[key_package])
        .map_err(|error| error.to_string())?;
    group
        .merge_pending_commit(&provider)
        .map_err(|error| error.to_string())?;
    expected_members.push(expected_member.clone());
    verify_expected_members(&group, &expected_members)?;
    let commit = encode_message(&commit)?;
    let welcome = encode_message(&welcome)?;
    let updated_state = encode_state(
        &provider,
        snapshot.identity.clone(),
        snapshot.signature_public_key.clone(),
        snapshot.group_id.clone(),
    )?;
    Ok(AddMemberResult {
        state: updated_state,
        commit,
        welcome,
    })
}

pub fn process_commit(
    state: &[u8],
    encoded_commit: &[u8],
    expected_members: &[ExpectedMember],
) -> Result<Vec<u8>, String> {
    let (snapshot, provider) = decode_state(state)?;
    let (mut group, _) = load_group(&snapshot, &provider)?;
    let processed = group
        .process_message(&provider, decode_protocol_message(encoded_commit)?)
        .map_err(|error| error.to_string())?;
    let staged_commit = match processed.into_content() {
        ProcessedMessageContent::StagedCommitMessage(commit) => *commit,
        _ => return Err("Expected an MLS group commit".to_owned()),
    };
    group
        .merge_staged_commit(&provider, staged_commit)
        .map_err(|error| error.to_string())?;
    verify_expected_members(&group, expected_members)?;
    encode_state(
        &provider,
        snapshot.identity.clone(),
        snapshot.signature_public_key.clone(),
        snapshot.group_id.clone(),
    )
}

pub fn remove_member(state: &[u8], leaf_index: u32) -> Result<GroupCommitResult, String> {
    let (snapshot, provider) = decode_state(state)?;
    let (mut group, signer) = load_group(&snapshot, &provider)?;
    let (commit, _, _) = group
        .remove_members(
            &provider,
            &signer,
            &[openmls::prelude::LeafNodeIndex::new(leaf_index)],
        )
        .map_err(|error| error.to_string())?;
    group
        .merge_pending_commit(&provider)
        .map_err(|error| error.to_string())?;
    let commit = encode_message(&commit)?;
    let updated_state = encode_state(
        &provider,
        snapshot.identity.clone(),
        snapshot.signature_public_key.clone(),
        snapshot.group_id.clone(),
    )?;
    Ok(GroupCommitResult {
        state: updated_state,
        commit,
    })
}

pub fn join_group(state: &[u8], encoded_welcome: &[u8]) -> Result<Vec<u8>, String> {
    let (snapshot, provider) = decode_state(state)?;
    if snapshot.group_id.is_some() {
        return Err("MLS device already belongs to a group".to_owned());
    }
    let welcome = match MlsMessageIn::tls_deserialize_exact(encoded_welcome)
        .map_err(|error| error.to_string())?
        .extract()
    {
        MlsMessageBodyIn::Welcome(welcome) => welcome,
        _ => return Err("Expected MLS Welcome message".to_owned()),
    };
    let group =
        StagedWelcome::new_from_welcome(&provider, &MlsGroupJoinConfig::default(), welcome, None)
            .map_err(|error| error.to_string())?
            .into_group(&provider)
            .map_err(|error| error.to_string())?;
    encode_state(
        &provider,
        snapshot.identity.clone(),
        snapshot.signature_public_key.clone(),
        Some(group.group_id().as_slice().to_vec()),
    )
}

pub fn encrypt_application(state: &[u8], plaintext: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    let (snapshot, provider) = decode_state(state)?;
    let (mut group, signer) = load_group(&snapshot, &provider)?;
    let ciphertext = group
        .create_message(&provider, &signer, plaintext)
        .map_err(|error| error.to_string())?;
    Ok((
        encode_state(
            &provider,
            snapshot.identity.clone(),
            snapshot.signature_public_key.clone(),
            snapshot.group_id.clone(),
        )?,
        encode_message(&ciphertext)?,
    ))
}

pub fn decrypt_application(
    state: &[u8],
    encoded_message: &[u8],
) -> Result<(Vec<u8>, Vec<u8>), String> {
    let (snapshot, provider) = decode_state(state)?;
    let (mut group, _) = load_group(&snapshot, &provider)?;
    let processed = group
        .process_message(&provider, decode_protocol_message(encoded_message)?)
        .map_err(|error| error.to_string())?;
    let plaintext = match processed.into_content() {
        ProcessedMessageContent::ApplicationMessage(message) => message.into_bytes(),
        _ => return Err("Expected MLS application message".to_owned()),
    };
    Ok((
        encode_state(
            &provider,
            snapshot.identity.clone(),
            snapshot.signature_public_key.clone(),
            snapshot.group_id.clone(),
        )?,
        plaintext,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    use openmls::prelude::{
        BasicCredential, Ciphersuite, KeyPackage, LeafNodeIndex, MlsGroup, MlsGroupCreateConfig,
        MlsGroupJoinConfig, MlsMessageIn, MlsMessageOut, OpenMlsProvider, ProcessedMessageContent,
        ProtocolMessage, StagedWelcome,
    };
    use openmls_basic_credential::SignatureKeyPair;
    use tls_codec::{Deserialize, Serialize};

    const SUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

    fn client(
        identity: &[u8],
        provider: &OpenMlsRustCrypto,
    ) -> (openmls::prelude::CredentialWithKey, SignatureKeyPair) {
        let credential = BasicCredential::new(identity.to_vec());
        let signer = SignatureKeyPair::new(SUITE.signature_algorithm()).unwrap();
        signer.store(provider.storage()).unwrap();
        (
            openmls::prelude::CredentialWithKey {
                credential: credential.into(),
                signature_key: signer.public().into(),
            },
            signer,
        )
    }

    fn protocol_message(message: MlsMessageOut) -> ProtocolMessage {
        let encoded = message.tls_serialize_detached().unwrap();
        MlsMessageIn::tls_deserialize_exact(&encoded)
            .unwrap()
            .try_into_protocol_message()
            .unwrap()
    }

    #[test]
    fn welcome_join_message_and_removal_follow_mls_epochs() {
        let alice_provider = OpenMlsRustCrypto::default();
        let bob_provider = OpenMlsRustCrypto::default();
        let (alice_credential, alice_signer) = client(b"account:alice/device:1", &alice_provider);
        let (bob_credential, bob_signer) = client(b"account:bob/device:1", &bob_provider);
        let bob_key_package = KeyPackage::builder()
            .build(SUITE, &bob_provider, &bob_signer, bob_credential)
            .unwrap();

        let config = MlsGroupCreateConfig::builder()
            .ciphersuite(SUITE)
            .use_ratchet_tree_extension(true)
            .build();
        let mut alice_group =
            MlsGroup::new(&alice_provider, &alice_signer, &config, alice_credential).unwrap();
        let (_, welcome, _) = alice_group
            .add_members(
                &alice_provider,
                &alice_signer,
                &[bob_key_package.key_package().clone()],
            )
            .unwrap();
        alice_group.merge_pending_commit(&alice_provider).unwrap();

        let welcome_bytes = welcome.tls_serialize_detached().unwrap();
        let welcome = match MlsMessageIn::tls_deserialize_exact(&welcome_bytes)
            .unwrap()
            .extract()
        {
            openmls::prelude::MlsMessageBodyIn::Welcome(welcome) => welcome,
            _ => panic!("expected MLS Welcome"),
        };
        let mut bob_group = StagedWelcome::new_from_welcome(
            &bob_provider,
            &MlsGroupJoinConfig::default(),
            welcome,
            None,
        )
        .unwrap()
        .into_group(&bob_provider)
        .unwrap();

        let encrypted = alice_group
            .create_message(&alice_provider, &alice_signer, b"hello over MLS")
            .unwrap();
        let received = bob_group
            .process_message(&bob_provider, protocol_message(encrypted))
            .unwrap();
        match received.into_content() {
            ProcessedMessageContent::ApplicationMessage(message) => {
                assert_eq!(message.into_bytes(), b"hello over MLS");
            }
            _ => panic!("expected MLS application message"),
        }

        let (removal, _, _) = alice_group
            .remove_members(&alice_provider, &alice_signer, &[LeafNodeIndex::new(1)])
            .unwrap();
        alice_group.merge_pending_commit(&alice_provider).unwrap();
        let after_removal = alice_group
            .create_message(
                &alice_provider,
                &alice_signer,
                b"only for remaining members",
            )
            .unwrap();
        let processed_removal = bob_group
            .process_message(&bob_provider, protocol_message(removal))
            .unwrap();
        let staged_removal = match processed_removal.into_content() {
            ProcessedMessageContent::StagedCommitMessage(commit) => *commit,
            _ => panic!("expected MLS removal commit"),
        };
        bob_group
            .merge_staged_commit(&bob_provider, staged_removal)
            .unwrap();
        assert!(bob_group
            .process_message(&bob_provider, protocol_message(after_removal))
            .is_err());
    }

    #[test]
    fn safety_fingerprint_matches_group_members_and_detects_credential_changes() {
        let (alice_device, _) = create_device(b"alice/device-1").unwrap();
        let (bob_device, bob_key_package) = create_device(b"bob/device-1").unwrap();
        let alice_group = create_group(&alice_device, b"safety-code-test").unwrap();
        let bob_member = device_identity(&bob_device).unwrap();
        let added = add_member(&alice_group, &bob_key_package, &bob_member).unwrap();
        let bob_group = join_group(&bob_device, &added.welcome).unwrap();

        assert_eq!(
            safety_fingerprint(&added.state).unwrap(),
            safety_fingerprint(&bob_group).unwrap()
        );

        let (mallory_device, mallory_key_package) = create_device(b"bob/device-1").unwrap();
        let mallory_member = device_identity(&mallory_device).unwrap();
        let substituted = add_member(&alice_group, &mallory_key_package, &mallory_member).unwrap();
        assert_ne!(
            safety_fingerprint(&added.state).unwrap(),
            safety_fingerprint(&substituted.state).unwrap()
        );
    }

    #[test]
    fn device_binding_proof_authenticates_account_device_and_signing_key() {
        let account_id = b"account-123";
        let device_id = b"device-123";
        let identity = b"halochat:user:account-123:device:device-123";
        let (state, _) = create_device(identity).unwrap();
        let member = device_identity(&state).unwrap();
        let proof = sign_device_binding(&state, account_id, device_id).unwrap();

        assert!(verify_device_binding(
            account_id,
            device_id,
            &member.identity,
            &member.signature_key,
            &proof,
        ));
        assert!(!verify_device_binding(
            b"other-account",
            device_id,
            &member.identity,
            &member.signature_key,
            &proof,
        ));
        let mut substituted_key = member.signature_key.clone();
        substituted_key[0] ^= 1;
        assert!(!verify_device_binding(
            account_id,
            device_id,
            &member.identity,
            &substituted_key,
            &proof,
        ));
    }

    #[test]
    fn opaque_snapshots_support_add_join_encrypt_and_decrypt() {
        let (alice_identity, _) = create_device(b"alice/device-1").unwrap();
        let (bob_identity, bob_key_package) = create_device(b"bob/device-1").unwrap();
        let alice_group = create_group(&alice_identity, b"chat-group-1").unwrap();
        let bob_member = device_identity(&bob_identity).unwrap();
        let added = add_member(&alice_group, &bob_key_package, &bob_member).unwrap();
        let (alice_group, welcome) = (added.state, added.welcome);
        let bob_group = join_group(&bob_identity, &welcome).unwrap();

        let (alice_group, ciphertext) =
            encrypt_application(&alice_group, b"opaque state hello").unwrap();
        let (bob_group, plaintext) = decrypt_application(&bob_group, &ciphertext).unwrap();
        assert_eq!(plaintext, b"opaque state hello");
        assert!(decrypt_application(&bob_group, &ciphertext).is_err());

        let (_, reply) = encrypt_application(&bob_group, b"reply after state restore").unwrap();
        let (_, plaintext) = decrypt_application(&alice_group, &reply).unwrap();
        assert_eq!(plaintext, b"reply after state restore");
    }

    #[test]
    fn sender_state_does_not_replay_its_own_application_message() {
        let (alice_device, _) = create_device(b"alice/device-1").unwrap();
        let (bob_device, bob_key_package) = create_device(b"bob/device-1").unwrap();
        let alice_group = create_group(&alice_device, b"sender-replay-check").unwrap();
        let bob_member = device_identity(&bob_device).unwrap();
        let added = add_member(&alice_group, &bob_key_package, &bob_member).unwrap();
        let (alice_after_send, ciphertext) = encrypt_application(&added.state, b"hello").unwrap();

        assert!(decrypt_application(&alice_after_send, &ciphertext).is_err());
    }

    #[test]
    fn rejects_invalid_state_and_incomplete_operations() {
        assert!(create_device(b"").is_err());
        assert!(create_group(b"not-json", b"group").is_err());

        let (identity, _) = create_device(b"alice/device-1").unwrap();
        assert!(create_group(&identity, b"").is_err());
        let member = device_identity(&identity).unwrap();
        assert!(add_member(&identity, b"invalid-key-package", &member).is_err());
        assert!(encrypt_application(&identity, b"no group").is_err());

        let mut snapshot: serde_json::Value = serde_json::from_slice(&identity).unwrap();
        snapshot["version"] = serde_json::Value::from(STATE_VERSION + 1);
        assert!(create_group(&serde_json::to_vec(&snapshot).unwrap(), b"group").is_err());
    }

    #[test]
    fn state_envelope_encrypts_and_authenticates_snapshots() {
        let (state, _) = create_device(b"alice/device-1").unwrap();
        let key = [7_u8; STATE_KEY_LENGTH];
        let context = b"account:alice/device:1/group:private-chat";
        let envelope = protect_state(&state, &key, context).unwrap();
        assert!(!envelope
            .windows(b"alice/device-1".len())
            .any(|window| window == b"alice/device-1"));
        assert_eq!(unprotect_state(&envelope, &key, context).unwrap(), state);
        assert!(unprotect_state(&envelope, &key, b"another context").is_err());
        assert!(unprotect_state(&envelope, &[8_u8; STATE_KEY_LENGTH], context).is_err());
        assert!(unprotect_state(&envelope, b"short key", context).is_err());

        let mut tampered = envelope;
        tampered[STATE_ENVELOPE_MAGIC.len()] ^= 1;
        assert!(unprotect_state(&tampered, &key, context).is_err());
    }

    #[test]
    fn removed_member_cannot_decrypt_messages_from_the_new_epoch() {
        let (alice_device, _) = create_device(b"alice/device-1").unwrap();
        let (bob_device, bob_key_package) = create_device(b"bob/device-1").unwrap();
        let alice_group = create_group(&alice_device, b"removal-test").unwrap();
        let bob_member = device_identity(&bob_device).unwrap();
        let added = add_member(&alice_group, &bob_key_package, &bob_member).unwrap();
        let bob_group = join_group(&bob_device, &added.welcome).unwrap();

        let removal = remove_member(&added.state, 1).unwrap();
        let (_, ciphertext) =
            encrypt_application(&removal.state, b"message after access ended").unwrap();
        assert!(decrypt_application(&bob_group, &ciphertext).is_err());
    }

    #[test]
    fn incoming_commit_is_merged_only_when_roster_matches_expectation() {
        let (alice_device, _) = create_device(b"alice/device-1").unwrap();
        let (bob_device, bob_key_package) = create_device(b"bob/device-1").unwrap();
        let (charlie_device, charlie_key_package) = create_device(b"charlie/device-1").unwrap();
        let (_, mallory_key_package) = create_device(b"mallory/device-1").unwrap();
        let alice_group = create_group(&alice_device, b"commit-test").unwrap();
        let bob_member = device_identity(&bob_device).unwrap();
        let alice_added = add_member(&alice_group, &bob_key_package, &bob_member).unwrap();
        let bob_group = join_group(&bob_device, &alice_added.welcome).unwrap();

        let charlie_member = device_identity(&charlie_device).unwrap();
        let mut incomplete_member = charlie_member.clone();
        incomplete_member.signature_key.clear();
        assert!(add_member(&alice_added.state, &charlie_key_package, &incomplete_member).is_err());
        assert!(add_member(&alice_added.state, &mallory_key_package, &charlie_member).is_err());
        let alice_updated =
            add_member(&alice_added.state, &charlie_key_package, &charlie_member).unwrap();
        let expected_roster = group_members(&alice_updated.state).unwrap();
        let wrong_roster = vec![device_identity(&bob_device).unwrap()];
        assert!(process_commit(&bob_group, &alice_updated.commit, &wrong_roster).is_err());

        let bob_updated =
            process_commit(&bob_group, &alice_updated.commit, &expected_roster).unwrap();
        assert!(process_commit(&bob_updated, &alice_updated.commit, &expected_roster).is_err());
        let (alice_updated, ciphertext) =
            encrypt_application(&alice_updated.state, b"commit applied before app message")
                .unwrap();
        let (_, plaintext) = decrypt_application(&bob_updated, &ciphertext).unwrap();
        assert_eq!(plaintext, b"commit applied before app message");
        assert!(!alice_updated.is_empty());
    }
}
