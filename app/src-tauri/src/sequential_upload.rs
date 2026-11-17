//! Fork policy (CHANGELOG 3.9.9, "Unlimited uploads"): a large file is sent to
//! Telegram one part at a time. Free accounts receive FLOOD_PREMIUM_WAIT when
//! several parts of one file are in flight, which the Telegram client library
//! does by default. This replaces the patched copy of that library the fork
//! used to depend on, so the application builds against upstream's revision.
//!
//! Small files keep the library's single-request form: it already sends their
//! parts one after another and needs a checksum of the whole file.
use crate::resumable_upload::{PartSink, TelegramSink, UploadedParts, PART_BYTES};
use grammers_client::{types::media::Uploaded, Client};
use tokio::io::{AsyncRead, AsyncReadExt};

/// Files larger than this use Telegram's multi-part form, as in the library.
const BIG_FILE_BYTES: usize = 10 * 1024 * 1024;

/// Drop-in replacement for `Client::upload_stream`: the same size and naming
/// contract, with the parts of a large file sent one at a time.
pub async fn upload_stream<R: AsyncRead + Unpin>(
    client: &Client,
    stream: &mut R,
    size: usize,
    name: String,
) -> Result<Uploaded, std::io::Error> {
    if size <= BIG_FILE_BYTES {
        return client.upload_stream(stream, size, name).await;
    }
    let name = if name.is_empty() { "a".into() } else { name };
    upload_parts(&TelegramSink(client.clone()), stream, size as u64, name)
        .await
        .map(UploadedParts::into_uploaded)
        .map_err(std::io::Error::other)
}

/// Send the first `total_bytes` of `stream` as numbered parts, each confirmed
/// before the next is read. The stream may be longer, but not shorter.
pub async fn upload_parts<S: PartSink, R: AsyncRead + Unpin>(
    sink: &S,
    stream: &mut R,
    total_bytes: u64,
    name: String,
) -> Result<UploadedParts, String> {
    if total_bytes == 0 {
        return Err("An empty file has no parts".into());
    }
    let total_parts = i32::try_from(total_bytes.div_ceil(PART_BYTES as u64))
        .map_err(|_| "The file has too many parts".to_string())?;
    let file_id = rand::random();
    let mut remaining = total_bytes;
    for part in 0..total_parts {
        let length = remaining.min(PART_BYTES as u64) as usize;
        let mut bytes = vec![0; length];
        stream.read_exact(&mut bytes).await.map_err(|error| {
            if error.kind() == std::io::ErrorKind::UnexpectedEof {
                "The source ended before the upload was complete".to_string()
            } else {
                error.to_string()
            }
        })?;
        sink.save_part(file_id, part, total_parts, bytes).await?;
        remaining -= length as u64;
    }
    Ok(UploadedParts {
        file_id,
        total_parts,
        name,
        resumed_parts: 0,
    })
}
