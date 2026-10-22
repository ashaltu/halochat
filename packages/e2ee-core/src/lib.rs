//! Protocol-level MLS test harness for HaloChat.
//!
//! This crate deliberately does not claim to be the production E2EE boundary.
//! It validates the selected upstream protocol against HaloChat's basic group
//! messaging needs. Production use still requires authenticated HaloChat device
//! credentials, encrypted durable state, platform bindings, and ordered delivery.

#[cfg(test)]
mod tests {
    use openmls::prelude::{
        BasicCredential, Ciphersuite, KeyPackage, LeafNodeIndex, MlsGroup, MlsGroupCreateConfig,
        MlsGroupJoinConfig, MlsMessageIn, MlsMessageOut, OpenMlsProvider, ProcessedMessageContent,
        ProtocolMessage, StagedWelcome,
    };
    use openmls_basic_credential::SignatureKeyPair;
    use openmls_rust_crypto::OpenMlsRustCrypto;
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
}
