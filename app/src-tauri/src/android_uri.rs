//! Streaming reader for Android content:// URIs.
//!
//! Instead of copying the whole picked file into the app cache before uploading
//! (which needs free space equal to the file size and fails on a full phone),
//! this streams the file straight from the ContentResolver InputStream. A
//! dedicated OS thread with the JVM attached reads fixed chunks via JNI and
//! pushes them through a bounded channel; the async side pulls chunks as a
//! tokio AsyncRead, one split part at a time.

#![cfg(target_os = "android")]

use sha2::{Digest, Sha256};
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, ReadBuf};
use tokio::sync::mpsc;

const CHUNK: usize = 512 * 1024;
const CHANNEL_DEPTH: usize = 4; // ~2 MB in flight, bounds memory + gives backpressure

/// Async reader over a content:// URI. Persists across all split parts of one
/// upload; call `begin_part` before each part to bound how many bytes it yields
/// (grammers reads exactly that many, so the part looks like a whole stream).
pub struct AndroidUriStream {
    rx: mpsc::Receiver<io::Result<Vec<u8>>>,
    current: Vec<u8>,
    pos: usize,
    part_remaining: u64,
    counter: Arc<AtomicU64>,
    hasher: Option<Sha256>,
    done: bool,
    _thread: std::thread::JoinHandle<()>,
}

impl AndroidUriStream {
    /// Start a new part: yield at most `len` bytes, optionally hashing them.
    pub fn begin_part(&mut self, len: u64, hash: bool) {
        self.part_remaining = len;
        self.hasher = hash.then(Sha256::default);
    }

    /// SHA-256 hex of the bytes read for the part just finished (None if hashing off).
    pub fn finalize_hash(&mut self) -> Option<String> {
        self.hasher.take().map(|h| format!("{:x}", h.finalize()))
    }
}

impl AsyncRead for AndroidUriStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.part_remaining == 0 {
            return Poll::Ready(Ok(())); // part boundary: looks like EOF to the uploader
        }
        // Refill the current chunk if drained
        if self.pos >= self.current.len() {
            if self.done {
                return Poll::Ready(Ok(()));
            }
            match self.rx.poll_recv(cx) {
                Poll::Ready(Some(Ok(chunk))) => {
                    if chunk.is_empty() {
                        self.done = true;
                        return Poll::Ready(Ok(()));
                    }
                    self.current = chunk;
                    self.pos = 0;
                }
                Poll::Ready(Some(Err(e))) => return Poll::Ready(Err(e)),
                Poll::Ready(None) => {
                    self.done = true;
                    return Poll::Ready(Ok(()));
                }
                Poll::Pending => return Poll::Pending,
            }
        }
        let want = buf.remaining()
            .min(self.current.len() - self.pos)
            .min(self.part_remaining as usize);
        let start = self.pos;
        let slice = self.current[start..start + want].to_vec();
        buf.put_slice(&slice);
        self.pos += want;
        self.part_remaining -= want as u64;
        self.counter.fetch_add(want as u64, Ordering::Relaxed);
        if let Some(h) = self.hasher.as_mut() {
            h.update(&slice);
        }
        Poll::Ready(Ok(()))
    }
}

/// Opens a content:// URI and returns (stream, total size, display name).
/// The size and name come from a ContentResolver query; the byte stream is fed
/// by a background thread reading the ContentResolver InputStream.
pub fn open_android_uri_stream(
    raw_uri: &str,
    counter: Arc<AtomicU64>,
) -> Result<(AndroidUriStream, u64, String), String> {
    let ctx_obj = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx_obj.vm().cast()) }
        .map_err(|e| format!("JavaVM: {}", e))?;
    let mut env = vm.attach_current_thread().map_err(|e| format!("attach: {}", e))?;
    let ctx = unsafe { jni::objects::JObject::from_raw(ctx_obj.context().cast()) };

    // Parse the RAW uri (encoded) so the grant matches
    let uri_class = env.find_class("android/net/Uri").map_err(|e| e.to_string())?;
    let j_uri = env.new_string(raw_uri).map_err(|e| e.to_string())?;
    let uri = env
        .call_static_method(
            &uri_class,
            "parse",
            "(Ljava/lang/String;)Landroid/net/Uri;",
            &[jni::objects::JValue::from(&j_uri)],
        )
        .map_err(|e| format!("Uri.parse: {}", e))?
        .l()
        .map_err(|e| e.to_string())?;

    let resolver = env
        .call_method(&ctx, "getContentResolver", "()Landroid/content/ContentResolver;", &[])
        .map_err(|e| format!("getContentResolver: {}", e))?
        .l()
        .map_err(|e| e.to_string())?;

    // Query size + display name
    let (size, name) = query_size_and_name(&mut env, &resolver, &uri).unwrap_or((0, "upload".to_string()));

    // Open the input stream
    let input_stream = match env.call_method(
        &resolver,
        "openInputStream",
        "(Landroid/net/Uri;)Ljava/io/InputStream;",
        &[jni::objects::JValue::from(&uri)],
    ) {
        Ok(v) => v.l().map_err(|e| e.to_string())?,
        Err(e) => {
            let _ = env.exception_clear();
            return Err(format!("openInputStream: {}", e));
        }
    };
    if input_stream.is_null() {
        return Err("openInputStream returned null".to_string());
    }

    // Move the stream to a background thread as a global ref
    let stream_global = env
        .new_global_ref(&input_stream)
        .map_err(|e| format!("global ref: {}", e))?;

    let (tx, rx) = mpsc::channel::<io::Result<Vec<u8>>>(CHANNEL_DEPTH);
    let thread = std::thread::spawn(move || {
        read_stream_thread(stream_global, tx);
    });

    Ok((
        AndroidUriStream {
            rx,
            current: Vec::new(),
            pos: 0,
            part_remaining: 0,
            counter,
            hasher: None,
            done: false,
            _thread: thread,
        },
        size,
        name,
    ))
}

fn query_size_and_name(
    env: &mut jni::JNIEnv,
    resolver: &jni::objects::JObject,
    uri: &jni::objects::JObject,
) -> Option<(u64, String)> {
    let cursor = env
        .call_method(
            resolver,
            "query",
            "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
            &[
                jni::objects::JValue::from(uri),
                jni::objects::JValue::from(&jni::objects::JObject::null()),
                jni::objects::JValue::from(&jni::objects::JObject::null()),
                jni::objects::JValue::from(&jni::objects::JObject::null()),
                jni::objects::JValue::from(&jni::objects::JObject::null()),
            ],
        )
        .ok()?
        .l()
        .ok()?;
    if cursor.is_null() {
        return None;
    }
    let moved = env
        .call_method(&cursor, "moveToFirst", "()Z", &[])
        .ok()?
        .z()
        .ok()?;
    let mut size = 0u64;
    let mut name = "upload".to_string();
    if moved {
        if let Some(v) = column_index(env, &cursor, "_size") {
            if let Ok(l) = env.call_method(&cursor, "getLong", "(I)J", &[jni::objects::JValue::from(v)]) {
                if let Ok(l) = l.j() {
                    if l > 0 {
                        size = l as u64;
                    }
                }
            }
        }
        if let Some(v) = column_index(env, &cursor, "_display_name") {
            if let Ok(s) = env.call_method(&cursor, "getString", "(I)Ljava/lang/String;", &[jni::objects::JValue::from(v)]) {
                if let Ok(obj) = s.l() {
                    if !obj.is_null() {
                        let js: jni::objects::JString = obj.into();
                        if let Ok(rust) = env.get_string(&js) {
                            name = rust.into();
                        }
                    }
                }
            }
        }
    }
    let _ = env.call_method(&cursor, "close", "()V", &[]);
    Some((size, name))
}

fn column_index(env: &mut jni::JNIEnv, cursor: &jni::objects::JObject, col: &str) -> Option<i32> {
    let j_col = env.new_string(col).ok()?;
    let idx = env
        .call_method(
            cursor,
            "getColumnIndex",
            "(Ljava/lang/String;)I",
            &[jni::objects::JValue::from(&j_col)],
        )
        .ok()?
        .i()
        .ok()?;
    if idx >= 0 {
        Some(idx)
    } else {
        None
    }
}

/// Background thread: attach the JVM, read the InputStream in CHUNK-sized blocks
/// and forward them; a final empty Vec signals clean EOF.
fn read_stream_thread(stream_global: jni::objects::GlobalRef, tx: mpsc::Sender<io::Result<Vec<u8>>>) {
    let ctx_obj = ndk_context::android_context();
    let vm = match unsafe { jni::JavaVM::from_raw(ctx_obj.vm().cast()) } {
        Ok(vm) => vm,
        Err(_) => {
            let _ = tx.blocking_send(Err(io::Error::other("JavaVM (reader thread)")));
            return;
        }
    };
    let mut env = match vm.attach_current_thread() {
        Ok(e) => e,
        Err(_) => {
            let _ = tx.blocking_send(Err(io::Error::other("attach (reader thread)")));
            return;
        }
    };

    let byte_array = match env.new_byte_array(CHUNK as i32) {
        Ok(a) => a,
        Err(_) => {
            let _ = tx.blocking_send(Err(io::Error::other("alloc byte[]")));
            return;
        }
    };
    let stream = stream_global.as_obj();

    loop {
        let n = match env.call_method(
            stream,
            "read",
            "([B)I",
            &[jni::objects::JValue::from(&byte_array)],
        ) {
            Ok(v) => v.i().unwrap_or(-1),
            Err(_) => {
                let _ = env.exception_clear();
                let _ = tx.blocking_send(Err(io::Error::other("InputStream.read failed")));
                break;
            }
        };
        if n < 0 {
            let _ = tx.blocking_send(Ok(Vec::new())); // EOF
            break;
        }
        if n == 0 {
            continue;
        }
        let mut buf = vec![0i8; n as usize];
        if env.get_byte_array_region(&byte_array, 0, &mut buf).is_err() {
            let _ = tx.blocking_send(Err(io::Error::other("get_byte_array_region")));
            break;
        }
        let bytes: Vec<u8> = buf.into_iter().map(|b| b as u8).collect();
        if tx.blocking_send(Ok(bytes)).is_err() {
            break; // receiver dropped (cancelled)
        }
    }
    let _ = env.call_method(stream, "close", "()V", &[]);
}
