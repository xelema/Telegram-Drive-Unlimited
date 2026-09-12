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
async fn api_protection_uses_current_owned_header_and_plain_replacements_stay_available() {
    let fixture = Fixture::new(22);
    let (old, size, _) = vault_header("A-private.mp4", 7);
    let (current, _, _) = vault_header("B-private.mp4", 8);
    let identity = RemoteEnvelopeIdentity {
        owner: 11,
        folder: None,
        message: 42,
        document: 100,
        ciphertext_size: size,
    };
    envelope_cache::write(&Store::open(&fixture.root, 11).unwrap(), &identity, &old).unwrap();
    envelope_cache::write(
        &Store::open(&fixture.root, 22).unwrap(),
        &RemoteEnvelopeIdentity {
            owner: 22,
            ..identity
        },
        &current,
    )
    .unwrap();
    let protected = media("private.tdenc", 100, size);
    let response = api_protected_response(
        &fixture.account,
        &fixture.client,
        None,
        42,
        &protected,
        "TDENC2",
        "Protected API downloads remain disabled",
    )
    .await
    .unwrap();
    assert_eq!(response.status().as_u16(), 409);
    let ordinary = media("ordinary.mp4", 101, size);
    assert!(api_protected_response(
        &fixture.account,
        &fixture.client,
        None,
        42,
        &ordinary,
        "",
        "Protected"
    )
    .await
    .is_none());
    sign_in(&fixture.root, 33);
    assert_eq!(
        api_protected_response(
            &fixture.account,
            &fixture.client,
            None,
            42,
            &ordinary,
            "",
            "Protected"
        )
        .await
        .unwrap()
        .status()
        .as_u16(),
        503
    );
}

#[tokio::test]
async fn api_response_discards_old_account_metadata_after_an_await() {
    let fixture = Fixture::new(11);
    let (entered, started) = tokio::sync::oneshot::channel();
    let (release, resumed) = tokio::sync::oneshot::channel();
    let response = async {
        entered.send(()).unwrap();
        resumed.await.unwrap();
        account_response(&fixture.account, HttpResponse::Ok().body("A-private.mp4"))
    };
    let switch = async {
        started.await.unwrap();
        sign_in(&fixture.root, 22);
        release.send(()).unwrap();
    };
    let (response, ()) = tokio::join!(response, switch);
    assert_eq!(response.status().as_u16(), 409);
    let body = actix_web::body::to_bytes(response.into_body())
        .await
        .unwrap();
    assert!(!String::from_utf8_lossy(&body).contains("A-private"));
}

#[tokio::test]
async fn api_archive_stream_stops_before_returning_more_old_account_bytes() {
    use futures::StreamExt;
    let fixture = Fixture::new(11);
    let path = fixture.root.join("synthetic-archive.zip");
    tokio::fs::write(&path, vec![17; 32_768]).await.unwrap();
    let mut stream = CleanupStream {
        account: fixture.account.clone(),
        file: tokio::fs::File::open(&path).await.unwrap(),
        path,
    };
    assert_eq!(stream.next().await.unwrap().unwrap().len(), 16_384);
    sign_in(&fixture.root, 22);
    assert_eq!(
        stream.next().await.unwrap().unwrap_err().kind(),
        std::io::ErrorKind::PermissionDenied
    );
}
