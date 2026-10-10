//! Desktop still-image renditions. Decoders are OS/user tools, never bundled.
use crate::process_budget;
use image::{ImageDecoder, ImageEncoder};
use std::{
    collections::HashMap,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, LazyLock},
    time::{Duration, Instant},
};

pub(crate) const OUTPUT_LIMIT: u64 = 8 * 1024 * 1024;
pub(crate) const SOURCE_LIMIT: u64 = 64 * 1024 * 1024;
const PIXEL_LIMIT: u64 = 64_000_000;
const META_LIMIT: usize = 1024 * 1024;
pub(crate) static DECODERS: LazyLock<Arc<tokio::sync::Semaphore>> =
    LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(1)));
#[derive(Clone, Default)]
pub(crate) struct Tools {
    pub sips: Option<PathBuf>,
    pub ffmpeg: Vec<PathBuf>,
    #[cfg(feature = "native-e2e")]
    pub fixture: Option<process_budget::FixtureClock>,
}
impl Tools {
    pub(crate) fn platform(resource: Option<&Path>) -> Self {
        #[cfg(target_os = "macos")]
        let sips = Some(PathBuf::from("/usr/bin/sips"));
        #[cfg(not(target_os = "macos"))]
        let sips = None;
        let mut ffmpeg = Vec::new();
        if let Some(resource) = resource {
            let name = if cfg!(target_os = "windows") {
                "ffmpeg.exe"
            } else {
                "ffmpeg"
            };
            let path = resource.join(name);
            if path.is_file() {
                ffmpeg.push(path);
            }
        }
        ffmpeg.push(PathBuf::from("ffmpeg"));
        Self {
            sips,
            ffmpeg,
            #[cfg(feature = "native-e2e")]
            fixture: None,
        }
    }
}
pub(crate) fn is_name(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|v| v.to_str())
        .is_some_and(|v| v.eq_ignore_ascii_case("heic") || v.eq_ignore_ascii_case("heif"))
}
pub(crate) fn is_mime(mime: Option<&str>) -> bool {
    matches!(mime, Some("image/heic" | "image/heif"))
}
fn invalid() -> String {
    "HEIC_PREVIEW_UNAVAILABLE: Unsupported or oversized still image".into()
}
fn number(bytes: &[u8], offset: usize, length: usize) -> Result<u64, String> {
    let end = offset.checked_add(length).ok_or_else(invalid)?;
    let bytes = bytes.get(offset..end).ok_or_else(invalid)?;
    Ok(bytes
        .iter()
        .fold(0u64, |value, byte| (value << 8) | u64::from(*byte)))
}
struct BoxRef<'a> {
    kind: &'a [u8],
    data: &'a [u8],
}
fn boxes(bytes: &[u8]) -> Result<Vec<BoxRef<'_>>, String> {
    let mut offset = 0usize;
    let mut result = Vec::new();
    while offset < bytes.len() {
        if result.len() >= 4096 {
            return Err(invalid());
        }
        let mut size = number(bytes, offset, 4)? as usize;
        let kind = bytes.get(offset + 4..offset + 8).ok_or_else(invalid)?;
        let header = if size == 1 {
            size = usize::try_from(number(bytes, offset + 8, 8)?).map_err(|_| invalid())?;
            16
        } else {
            8
        };
        if size == 0 {
            size = bytes.len() - offset;
        }
        let end = offset
            .checked_add(size)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(invalid)?;
        if size < header {
            return Err(invalid());
        }
        result.push(BoxRef {
            kind,
            data: &bytes[offset + header..end],
        });
        offset = end;
    }
    Ok(result)
}
fn one<'a>(items: &'a [BoxRef<'a>], kind: &[u8]) -> Result<&'a [u8], String> {
    let mut matching = items.iter().filter(|item| item.kind == kind);
    let data = matching.next().ok_or_else(invalid)?.data;
    if matching.next().is_some() {
        return Err(invalid());
    }
    Ok(data)
}
fn dimensions(data: &[u8]) -> Result<(u32, u32), String> {
    if data.len() != 12 {
        return Err(invalid());
    }
    let width = number(data, 4, 4)? as u32;
    let height = number(data, 8, 4)? as u32;
    if width == 0
        || height == 0
        || width > 16384
        || height > 16384
        || u64::from(width) * u64::from(height) > PIXEL_LIMIT
    {
        return Err(invalid());
    }
    Ok((width, height))
}
fn item_types(root: &[BoxRef<'_>]) -> Result<HashMap<u64, Vec<u8>>, String> {
    let info = one(root, b"iinf")?;
    let version = *info.first().ok_or_else(invalid)?;
    if version > 1 {
        return Err(invalid());
    }
    let width = if version == 0 { 2 } else { 4 };
    let count = number(info, 4, width)?;
    if count > 1024 {
        return Err(invalid());
    }
    let entries = boxes(info.get(4 + width..).ok_or_else(invalid)?)?;
    if entries.len() as u64 != count {
        return Err(invalid());
    }
    let mut types = HashMap::new();
    for entry in entries {
        if entry.kind != b"infe" {
            return Err(invalid());
        }
        let version = *entry.data.first().ok_or_else(invalid)?;
        let width = match version {
            2 => 2,
            3 => 4,
            _ => return Err(invalid()),
        };
        let id = number(entry.data, 4, width)?;
        if number(entry.data, 4 + width, 2)? != 0 {
            return Err(invalid());
        }
        let kind = entry
            .data
            .get(6 + width..10 + width)
            .ok_or_else(invalid)?
            .to_vec();
        if types.insert(id, kind).is_some() {
            return Err(invalid());
        }
    }
    Ok(types)
}
fn primary_grid(
    file: &mut std::fs::File,
    file_len: u64,
    root: &[BoxRef<'_>],
    primary: u64,
    types: &HashMap<u64, Vec<u8>>,
    dimensions: (u32, u32),
) -> Result<Option<usize>, String> {
    // External data references are never followed, including by ImageIO.
    if let Some(dinf) = root.iter().find(|item| item.kind == b"dinf") {
        let children = boxes(dinf.data)?;
        let dref = one(&children, b"dref")?;
        if number(dref, 4, 4)? != 1 {
            return Err(invalid());
        }
        let references = boxes(dref.get(8..).ok_or_else(invalid)?)?;
        if references.len() != 1
            || references[0].kind != b"url "
            || references[0].data != [0, 0, 0, 1]
        {
            return Err(invalid());
        }
    }
    let data = one(root, b"iloc")?;
    let version = *data.first().ok_or_else(invalid)?;
    if version > 2 {
        return Err(invalid());
    }
    let offset_size = number(data, 4, 1)? >> 4;
    let length_size = number(data, 4, 1)? & 15;
    let base_size = number(data, 5, 1)? >> 4;
    let index_size = if version > 0 {
        number(data, 5, 1)? & 15
    } else {
        0
    };
    if [offset_size, length_size, base_size, index_size]
        .iter()
        .any(|size| *size > 8)
    {
        return Err(invalid());
    }
    let id_size = if version < 2 { 2 } else { 4 };
    let count = number(data, 6, id_size)?;
    if count > 1024 {
        return Err(invalid());
    }
    let mut cursor = 6 + id_size;
    let mut payload = None;
    let mut ids = std::collections::HashSet::new();
    for _ in 0..count {
        let id = number(data, cursor, id_size)?;
        cursor += id_size;
        if !ids.insert(id) || !types.contains_key(&id) {
            return Err(invalid());
        }
        let method = if version > 0 {
            let method = number(data, cursor, 2)?;
            cursor += 2;
            method
        } else {
            0
        };
        if method > 1 || number(data, cursor, 2)? != 0 {
            return Err(invalid());
        }
        cursor += 2;
        let base = number(data, cursor, base_size as usize)?;
        cursor += base_size as usize;
        let extents = number(data, cursor, 2)?;
        cursor += 2;
        if extents == 0 || extents > 64 {
            return Err(invalid());
        }
        for _ in 0..extents {
            if version > 0 {
                cursor += index_size as usize;
            }
            let offset = number(data, cursor, offset_size as usize)?;
            cursor += offset_size as usize;
            let length = number(data, cursor, length_size as usize)?;
            cursor += length_size as usize;
            let start = base.checked_add(offset).ok_or_else(invalid)?;
            let end = start.checked_add(length).ok_or_else(invalid)?;
            let idat = root
                .iter()
                .find(|item| item.kind == b"idat")
                .map(|item| item.data);
            let bound = if method == 1 {
                idat.ok_or_else(invalid)?.len() as u64
            } else {
                file_len
            };
            if length == 0 || end > bound {
                return Err(invalid());
            }
            if id == primary && types.get(&id).map(Vec::as_slice) == Some(b"grid") {
                if extents != 1 || !matches!(length, 8 | 12) {
                    return Err(invalid());
                }
                let bytes = if method == 1 {
                    idat.ok_or_else(invalid)?[start as usize..end as usize].to_vec()
                } else {
                    file.seek(SeekFrom::Start(start)).map_err(|_| invalid())?;
                    let mut bytes = vec![0; length as usize];
                    file.read_exact(&mut bytes).map_err(|_| invalid())?;
                    bytes
                };
                if payload.replace(bytes).is_some() {
                    return Err(invalid());
                }
            }
        }
    }
    if cursor != data.len() {
        return Err(invalid());
    }
    match types.get(&primary).map(Vec::as_slice) {
        Some(b"hvc1") => Ok(None),
        Some(b"grid") => {
            let bytes = payload.ok_or_else(invalid)?;
            if bytes[0] != 0 || bytes[1] > 1 {
                return Err(invalid());
            }
            let width = if bytes[1] & 1 != 0 { 4 } else { 2 };
            if bytes.len() != 4 + width * 2
                || (
                    number(&bytes, 4, width)? as u32,
                    number(&bytes, 4 + width, width)? as u32,
                ) != dimensions
            {
                return Err(invalid());
            }
            let tiles = (usize::from(bytes[2]) + 1) * (usize::from(bytes[3]) + 1);
            if tiles > 512 {
                return Err(invalid());
            }
            Ok(Some(tiles))
        }
        _ => Err(invalid()),
    }
}
/// Parse only bounded still-image item/property metadata, never coded pixels.
/// Unsupported layouts fail closed and keep the original available externally.
pub(crate) fn primary_dimensions(input: &Path) -> Result<(u32, u32), String> {
    let meta = std::fs::symlink_metadata(input).map_err(|_| invalid())?;
    if !meta.file_type().is_file() || meta.len() == 0 || meta.len() > SOURCE_LIMIT {
        return Err(invalid());
    }
    let mut file = std::fs::File::open(input).map_err(|_| invalid())?;
    let mut offset = 0u64;
    let mut metadata = None;
    let mut hevc = false;
    for _ in 0..128 {
        if offset == meta.len() {
            break;
        }
        file.seek(SeekFrom::Start(offset)).map_err(|_| invalid())?;
        let mut header = [0u8; 16];
        file.read_exact(&mut header[..8]).map_err(|_| invalid())?;
        let mut size = number(&header, 0, 4)?;
        let header_size = if size == 1 {
            file.read_exact(&mut header[8..]).map_err(|_| invalid())?;
            size = number(&header, 8, 8)?;
            16
        } else {
            8
        };
        if size == 0 {
            size = meta.len() - offset;
        }
        let end = offset
            .checked_add(size)
            .filter(|end| *end <= meta.len())
            .ok_or_else(invalid)?;
        if size < header_size {
            return Err(invalid());
        }
        let length = usize::try_from(size - header_size).map_err(|_| invalid())?;
        if &header[4..8] == b"ftyp" || &header[4..8] == b"meta" {
            if length > META_LIMIT {
                return Err(invalid());
            }
            let mut data = vec![0; length];
            file.read_exact(&mut data).map_err(|_| invalid())?;
            if &header[4..8] == b"ftyp" {
                if data.len() < 8 || data[..4] == *b"avif" || data[..4] == *b"avis" {
                    return Err(invalid());
                }
                hevc = data
                    .chunks_exact(4)
                    .any(|brand| matches!(brand, b"heic" | b"heix" | b"hevc" | b"hevx"));
            } else if metadata.replace(data).is_some() {
                return Err(invalid());
            }
        }
        offset = end;
    }
    if offset != meta.len() || !hevc {
        return Err(invalid());
    }
    let metadata = metadata.ok_or_else(invalid)?;
    let root = boxes(metadata.get(4..).ok_or_else(invalid)?)?;
    let pitm = one(&root, b"pitm")?;
    let primary = number(
        pitm,
        4,
        if pitm.first() == Some(&0) {
            2
        } else if pitm.first() == Some(&1) {
            4
        } else {
            return Err(invalid());
        },
    )?;
    let iprp = boxes(one(&root, b"iprp")?)?;
    let properties = boxes(one(&iprp, b"ipco")?)?;
    let ipma = one(&iprp, b"ipma")?;
    let version = *ipma.first().ok_or_else(invalid)?;
    if version > 1 {
        return Err(invalid());
    }
    let wide = number(ipma, 0, 4)? & 1 != 0;
    let count = number(ipma, 4, 4)?;
    if count > 1024 {
        return Err(invalid());
    }
    let mut cursor = 8;
    let mut associated = HashMap::new();
    for _ in 0..count {
        let id = number(ipma, cursor, if version == 0 { 2 } else { 4 })?;
        cursor += if version == 0 { 2 } else { 4 };
        let length = number(ipma, cursor, 1)?;
        cursor += 1;
        if length > 64 {
            return Err(invalid());
        }
        let mut indices = Vec::new();
        for _ in 0..length {
            let association = number(ipma, cursor, if wide { 2 } else { 1 })?;
            cursor += if wide { 2 } else { 1 };
            let index = (association & if wide { 0x7fff } else { 0x7f }) as usize;
            if index == 0 {
                continue;
            }
            if index > properties.len() {
                return Err(invalid());
            }
            indices.push(index - 1);
        }
        if associated.insert(id, indices).is_some() {
            return Err(invalid());
        }
    }
    if cursor != ipma.len() {
        return Err(invalid());
    }
    // Reject oversized properties even when they belong to an auxiliary item.
    for property in &properties {
        if property.kind == b"ispe" {
            dimensions(property.data)?;
        }
    }
    let item_dimensions = |id| -> Result<(u32, u32), String> {
        let indices = associated.get(&id).ok_or_else(invalid)?;
        let mut result = None;
        for index in indices {
            if properties[*index].kind == b"ispe"
                && result
                    .replace(dimensions(properties[*index].data)?)
                    .is_some()
            {
                return Err(invalid());
            }
        }
        result.ok_or_else(invalid)
    };
    let mut size = item_dimensions(primary)?;
    let types = item_types(&root)?;
    let grid = primary_grid(&mut file, meta.len(), &root, primary, &types, size)?;
    let mut grid_found = false;
    if let Some(iref) = root.iter().find(|item| item.kind == b"iref") {
        let version = *iref.data.first().ok_or_else(invalid)?;
        if version > 1 {
            return Err(invalid());
        }
        let id_size = if version == 0 { 2 } else { 4 };
        let mut pixels = 0u64;
        for reference in boxes(iref.data.get(4..).ok_or_else(invalid)?)? {
            if reference.kind != b"dimg" || number(reference.data, 0, id_size)? != primary {
                continue;
            }
            if grid_found {
                return Err(invalid());
            }
            grid_found = true;
            let count = number(reference.data, id_size, 2)? as usize;
            if count == 0
                || count > 512
                || Some(count) != grid
                || reference.data.len() != id_size + 2 + count * id_size
            {
                return Err(invalid());
            }
            for index in 0..count {
                let id = number(reference.data, id_size + 2 + index * id_size, id_size)?;
                if types.get(&id).map(Vec::as_slice) != Some(b"hvc1") {
                    return Err(invalid());
                }
                let (width, height) = item_dimensions(id)?;
                pixels = pixels
                    .checked_add(u64::from(width) * u64::from(height))
                    .ok_or_else(invalid)?;
                if pixels > 2 * PIXEL_LIMIT {
                    return Err(invalid());
                }
            }
        }
    }
    if grid.is_some() != grid_found {
        return Err(invalid());
    }
    for index in associated.get(&primary).ok_or_else(invalid)? {
        let property = &properties[*index];
        if property.kind == b"irot" {
            if property.data.len() != 1 {
                return Err(invalid());
            }
            if property.data[0] & 1 != 0 {
                size = (size.1, size.0);
            }
        }
        if property.kind == b"clap" {
            return Err(invalid());
        } // Separate clean-aperture layouts are not silently cropped.
    }
    Ok(size)
}
fn fitted((width, height): (u32, u32), (max_width, max_height): (u32, u32)) -> (u32, u32) {
    let scale = (f64::from(max_width) / f64::from(width))
        .min(f64::from(max_height) / f64::from(height))
        .min(1.0);
    (
        (f64::from(width) * scale).round().max(1.0) as u32,
        (f64::from(height) * scale).round().max(1.0) as u32,
    )
}
pub(crate) fn version_eligible(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let Some(version) = text
        .strip_prefix("ffmpeg version ")
        .and_then(|v| v.split_whitespace().next())
    else {
        return false;
    };
    // Release builds may use n8.1 or vendor suffixes. Unversioned N-… master
    // banners cannot establish tile-grid support; never infer it from a date/hash.
    let version = version.strip_prefix('n').unwrap_or(version);
    let Some((major, rest)) = version.split_once('.') else {
        return false;
    };
    if major.is_empty() || !major.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    let minor_end = rest
        .bytes()
        .position(|byte| !byte.is_ascii_digit())
        .unwrap_or(rest.len());
    let suffix = &rest[minor_end..];
    let suffix = if let Some(patch) = suffix.strip_prefix('.') {
        let patch_end = patch
            .bytes()
            .position(|byte| !byte.is_ascii_digit())
            .unwrap_or(patch.len());
        if patch_end == 0 {
            return false;
        }
        &patch[patch_end..]
    } else {
        suffix
    };
    if !suffix.is_empty() && !suffix.starts_with('-') && !suffix.starts_with('+') {
        return false;
    }
    let (Ok(major), Ok(minor)) = (major.parse::<u32>(), rest[..minor_end].parse::<u32>()) else {
        return false;
    };
    major > 8 || (major == 8 && minor >= 1)
}
#[derive(Clone, serde::Serialize)]
pub(crate) struct DecodeReport {
    pub decoder: String,
    pub metrics: process_budget::Metrics,
}
#[cfg(feature = "native-e2e")]
static REPORTS: LazyLock<std::sync::Mutex<Vec<DecodeReport>>> =
    LazyLock::new(|| std::sync::Mutex::new(Vec::new()));
#[cfg(feature = "native-e2e")]
pub(crate) fn reports() -> Vec<DecodeReport> {
    REPORTS.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

struct Partial(PathBuf);
impl Drop for Partial {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
fn create(path: &Path) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(|e| e.to_string())
}
/// The caller owns cache/source/protection leases through this entire job.
pub(crate) fn decode(
    input: &Path,
    destination: &Path,
    tools: &Tools,
    maximum: (u32, u32),
    check: impl Fn() -> Result<(), String>,
) -> Result<DecodeReport, String> {
    check()?;
    let source_dimensions = primary_dimensions(input)?;
    let expected = fitted(source_dimensions, maximum);
    let cap = if maximum == (480, 360) {
        1024 * 1024
    } else {
        OUTPUT_LIMIT
    };
    let temporary = destination.with_extension(format!("{}.part", uuid::Uuid::new_v4()));
    let _partial = Partial(temporary.clone());
    let _cache_partial = crate::workspace::assets::track_decoder_partial(&temporary, destination);
    drop(create(&temporary)?);
    let deadline = Instant::now() + Duration::from_secs(30);
    #[cfg(feature = "native-e2e")]
    let deadline = if tools.fixture.is_some() {
        Instant::now() + Duration::from_secs(480)
    } else {
        deadline
    };
    let mut attempts = Vec::new();
    if let Some(sips) = &tools.sips {
        attempts.push(("sips", sips));
    }
    attempts.extend(tools.ffmpeg.iter().map(|path| ("ffmpeg", path)));
    let mut last = "HEIC_DECODER_UNAVAILABLE".to_string();
    for (name, executable) in attempts {
        check()?;
        if Instant::now() >= deadline {
            return Err("HEIC_DECODE_DEADLINE".into());
        }
        if name == "ffmpeg" {
            let mut probe = Command::new(executable);
            probe.arg("-version");
            #[cfg(feature = "native-e2e")]
            if let Some(clock) = &tools.fixture {
                probe.env(
                    "TD_E2E_COMPLETE",
                    clock.ready.with_extension("probe-complete"),
                );
            }
            let probe_deadline = deadline.min(Instant::now() + Duration::from_secs(2));
            #[cfg(feature = "native-e2e")]
            let probe_deadline = if tools.fixture.is_some() {
                deadline.min(Instant::now() + Duration::from_secs(120))
            } else {
                probe_deadline
            };
            let probe = process_budget::run(probe, probe_deadline, true, &check, None);
            match probe {
                Ok(output) if output.success && version_eligible(&output.stdout) => {}
                Ok(_) => {
                    last = "HEIC_FFMPEG_VERSION_UNSUPPORTED".into();
                    continue;
                }
                Err(error) => {
                    last = error;
                    continue;
                }
            }
        }
        std::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        let mut command = Command::new(executable);
        if name == "sips" {
            command
                .args([
                    "-s",
                    "format",
                    "jpeg",
                    "-Z",
                    &expected.0.max(expected.1).to_string(),
                ])
                .arg(input)
                .arg("--out")
                .arg(&temporary);
        } else {
            // Automatic stream-group selection assembles the primary grid in8.1.
            // Mapping0:v:0 would select an individual tile.
            command
                .args([
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-max_alloc",
                    "268435456",
                    "-threads",
                    "1",
                    "-max_pixels",
                    "64000000",
                    "-protocol_whitelist",
                    "file,pipe",
                    "-probesize",
                    "1048576",
                    "-analyzeduration",
                    "1000000",
                    "-f",
                    "mov",
                    "-enable_drefs",
                    "0",
                    "-use_absolute_path",
                    "0",
                    "-i",
                ])
                .arg(input)
                .args([
                    "-an",
                    "-sn",
                    "-dn",
                    "-frames:v",
                    "1",
                    "-map_metadata",
                    "-1",
                    "-s",
                ])
                //8.1's automatic grid assembly is already a complex graph;
                // output sizing appends its scaler without an incompatible-vf.
                .arg(format!("{}x{}", expected.0, expected.1))
                .args([
                    "-threads",
                    "1",
                    "-filter_threads",
                    "1",
                    "-filter_complex_threads",
                    "1",
                    "-c:v",
                    "mjpeg",
                    "-f",
                    "image2",
                    "-update",
                    "1",
                    "-fs",
                    &cap.to_string(),
                ])
                .arg(&temporary);
        }
        #[cfg(feature = "native-e2e")]
        let output = if let Some(clock) = &tools.fixture {
            process_budget::run_fixture(command, false, &check, Some((&temporary, cap)), clock)
        } else {
            process_budget::run(
                command,
                deadline.min(Instant::now() + Duration::from_secs(20)),
                false,
                &check,
                Some((&temporary, cap)),
            )
        };
        #[cfg(not(feature = "native-e2e"))]
        let output = process_budget::run(
            command,
            deadline.min(Instant::now() + Duration::from_secs(20)),
            false,
            &check,
            Some((&temporary, cap)),
        );
        let output = match output {
            Ok(output) if output.success => output,
            Ok(_) => {
                last = "HEIC_DECODE_FAILED".into();
                continue;
            }
            Err(error) => {
                check()?;
                last = error;
                continue;
            }
        };
        check()?;
        match validate_jpeg(&temporary, destination, expected, maximum, cap) {
            Ok(()) => {
                let report = DecodeReport {
                    decoder: name.into(),
                    metrics: output.metrics,
                };
                #[cfg(feature = "native-e2e")]
                REPORTS
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(report.clone());
                if let Err(error) = check() {
                    let _ = std::fs::remove_file(destination);
                    return Err(error);
                }
                return Ok(report);
            }
            Err(error) => last = error,
        }
    }
    Err(format!("HEIC_PREVIEW_UNAVAILABLE: {last}"))
}
fn validate_jpeg(
    input: &Path,
    output: &Path,
    expected: (u32, u32),
    maximum: (u32, u32),
    cap: u64,
) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(input).map_err(|_| invalid())?;
    if !meta.file_type().is_file() || meta.len() == 0 || meta.len() > cap {
        return Err("HEIC_OUTPUT_LIMIT".into());
    }
    let mut reader = image::ImageReader::open(input)
        .map_err(|_| invalid())?
        .with_guessed_format()
        .map_err(|_| invalid())?;
    if reader.format() != Some(image::ImageFormat::Jpeg) {
        return Err("HEIC_INVALID_JPEG".into());
    }
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(128 * 1024 * 1024);
    limits.max_image_width = Some(maximum.0.max(maximum.1));
    limits.max_image_height = Some(maximum.0.max(maximum.1));
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|_| invalid())?;
    let orientation = decoder.orientation().map_err(|_| invalid())?;
    let profile = decoder.icc_profile().map_err(|_| invalid())?;
    if profile
        .as_ref()
        .is_some_and(|profile| profile.len() > META_LIMIT)
    {
        return Err(invalid());
    }
    let mut image = image::DynamicImage::from_decoder(decoder).map_err(|_| invalid())?;
    image.apply_orientation(orientation);
    let size = (image.width(), image.height());
    if size.0 > maximum.0
        || size.1 > maximum.1
        || size.0.abs_diff(expected.0) > 1
        || size.1.abs_diff(expected.1) > 1
    {
        return Err("HEIC_INCOMPLETE_IMAGE".into());
    }
    if orientation == image::metadata::Orientation::NoTransforms {
        std::fs::rename(input, output).map_err(|e| e.to_string())?;
    } else {
        let mut file = create(output)?;
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut file, 85);
        if let Some(profile) = profile {
            encoder.set_icc_profile(profile).map_err(|_| invalid())?;
        }
        encoder.encode_image(&image).map_err(|_| invalid())?;
        file.flush().map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        if file.metadata().map_err(|e| e.to_string())?.len() > cap {
            let _ = std::fs::remove_file(output);
            return Err("HEIC_OUTPUT_LIMIT".into());
        }
    }
    Ok(())
}
