use super::*;
use crate::workspace::{
    envelope_cache::{
        self,
        test_support::{media, sign_in, vault_header, Fixture},
        RemoteEnvelopeIdentity,
    },
    store::Store,
};

#[tokio::test]
async fn webdav_index_clears_prior_account_nodes_and_rejects_late_publication() {
    let fixture = Fixture::new(11);
    let mut index = DavIndex::default();
    index.bind(&fixture.account).unwrap();
    index.nodes.insert("/A-private".into(), DavNode::Root);
    index.refreshed.insert("/".into(), Instant::now());
    index.bind(&fixture.account).unwrap();
    assert!(index.nodes.contains_key("/A-private"));
    sign_in(&fixture.root, 22);
    let current = AccountGuard::open(&fixture.root, Some("22")).unwrap();
    index.bind(&current).unwrap();
    assert!(index.nodes.is_empty());
    assert!(index.refreshed.is_empty());
    index.nodes.insert("/B-current".into(), DavNode::Root);
    assert!(index.bind(&fixture.account).is_err());
    assert!(index.nodes.contains_key("/B-current"));
}

#[tokio::test]
async fn webdav_request_rejects_a_result_completed_after_account_switch() {
    let fixture = Fixture::new(11);
    let (entered, started) = tokio::sync::oneshot::channel();
    let (release, resumed) = tokio::sync::oneshot::channel();
    let request = scoped_dav_request(&fixture.account, async {
        entered.send(()).unwrap();
        resumed.await.unwrap();
        Ok("A-private metadata")
    });
    let switch = async {
        started.await.unwrap();
        sign_in(&fixture.root, 22);
        release.send(()).unwrap();
    };
    let (result, ()) = tokio::join!(request, switch);
    assert!(matches!(result, Err(FsError::Forbidden)));
}

#[tokio::test]
async fn webdav_directory_handles_cannot_reveal_previous_account_entries() {
    let fixture = Fixture::new(11);
    let entry = TelegramDavDirEntry {
        account: fixture.account.clone(),
        name: b"A-private".to_vec(),
        metadata: DavMetadata::directory(UNIX_EPOCH),
    };
    assert_eq!(entry.name(), b"A-private");
    sign_in(&fixture.root, 22);
    assert!(entry.name().is_empty());
    assert!(matches!(entry.metadata().await, Err(FsError::Forbidden)));
}

#[tokio::test]
async fn webdav_protection_uses_the_current_document_and_owner() {
    let fixture = Fixture::new(22);
    let (header, size, _) = vault_header("B-private.mp4", 8);
    let identity = RemoteEnvelopeIdentity {
        owner: 22,
        folder: None,
        message: 42,
        document: 100,
        ciphertext_size: size,
    };
    envelope_cache::write(&Store::open(&fixture.root, 22).unwrap(), &identity, &header).unwrap();
    assert!(protected_media(
        &fixture.account,
        &fixture.client,
        None,
        42,
        &media("private.tdenc", 100, size),
        "TDENC2"
    )
    .await
    .unwrap());
    assert!(!protected_media(
        &fixture.account,
        &fixture.client,
        None,
        42,
        &media("ordinary.mp4", 101, size),
        ""
    )
    .await
    .unwrap());
    sign_in(&fixture.root, 33);
    assert!(matches!(
        protected_media(
            &fixture.account,
            &fixture.client,
            None,
            42,
            &media("ordinary.mp4", 101, size),
            ""
        )
        .await,
        Err(FsError::Forbidden)
    ));
}
