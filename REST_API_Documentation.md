# Telegram Drive REST API Reference

Telegram Drive includes an opt-in local REST API for automating file, folder, search, storage, thumbnail, media, and bulk operations. The API is available in the desktop app on Windows, macOS, and Linux. It is disabled by default, binds only to the loopback interface, and requires the desktop app to remain open and signed in.

## Enable the API

1. Open **Settings → Advanced** in the desktop app.
2. Generate an API key and copy it immediately. The app stores only its hash, so the plaintext key cannot be shown again.
3. Choose an unused port. The default is `8550`.
4. Enable the REST API and confirm that its status is running.

Regenerating the API key immediately invalidates the previous key. Keep the key out of source control, shell history, screenshots, and public issue reports.

## Base URL

```text
http://127.0.0.1:8550/api/v1
```

The port is configurable. Replace `8550` in examples if a different port is selected in Settings. Do not expose, proxy, or forward this loopback service to a LAN or the internet.

---

## Authentication

All endpoints except `/health` require an API key passed in the request headers.

| Header | Type | Description |
| :--- | :--- | :--- |
| `X-API-Key` | String | Your Telegram Drive API access key |

### Example Request

```bash
curl -H "X-API-Key: YOUR_API_KEY" \
  http://127.0.0.1:8550/api/v1/files
```

---

## Endpoints

### 1. Health Check
Check API availability, status, and running version.

* **URL:** `/health`
* **Method:** `GET`
* **Auth Required:** No

#### Response (200 OK)
```json
{
  "status": "ok",
  "version": "x.y.z"
}
```

---

### 2. List Files
Retrieve metadata for files stored in Telegram Drive.

* **URL:** `/files`
* **Method:** `GET`
* **Auth Required:** Yes

#### Query Parameters

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `page` | Integer | Page number (default: `1`) |
| `limit` | Integer | Items per page (default: `20`) |
| `folder_id` | Integer | Filter files inside a specific folder |
| `search` | String | Filter files by matching search term in filename |
| `offset_id` | Integer | Message ID offset for pagination |
| `sort` | String | Field to sort by: `name`, `size`, or `created_at` |
| `order` | String | Sort order: `asc` or `desc` |
| `mime_type` | String | Filter files by a specific MIME type |
| `created_after` | String | Include files created after this timestamp; use the same format returned by `created_at` |
| `created_before` | String | Include files created before this timestamp; use the same format returned by `created_at` |
| `size_min` | Integer | Minimum file size in bytes |
| `size_max` | Integer | Maximum file size in bytes |
| `fields` | String | Comma-separated response fields when a reduced representation is needed |

#### Response (200 OK)
```json
{
  "data": [],
  "files": [],
  "page": 1,
  "limit": 20,
  "total": 0
}
```

---

### 3. Get File Details
Retrieve detailed metadata for a specific file.

* **URL:** `/files/{message_id}`
* **Method:** `GET`
* **Auth Required:** Yes

#### Response (200 OK)
```json
{
  "id": 123,
  "folder_id": 456,
  "name": "document.pdf",
  "size": 102400,
  "mime_type": "application/pdf",
  "created_at": "2026-06-05T10:00:00Z"
}
```

---

### 4. Download File
Stream or download a file directly from Telegram Drive.

* **URL:** `/files/{message_id}/download`
* **Method:** `GET`
* **Auth Required:** Yes

---

### 5. Search Files
Search files by filename with optional filtering.

* **URL:** `/files/search`
* **Method:** `GET`
* **Auth Required:** Yes

#### Query Parameters

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `q` | String | **Required.** Search query string |

---

### 6. Upload File
Upload a file to Telegram Drive.

* **URL:** `/files`
* **Method:** `POST`
* **Auth Required:** Yes
* **Content-Type:** `multipart/form-data`

#### Form Fields
* `file`: Exactly one binary file field, up to Telegram's 2,000,000,000-byte upload limit
* `folder_id` (Optional): One integer target folder/channel ID; omit it for Saved Messages

Unknown fields, duplicate fields, malformed multipart bodies, and path-like filenames are rejected or normalized before upload. Bandwidth is reserved atomically and released automatically if staging, Telegram upload, or message creation fails.

#### Example

```bash
curl -X POST \
  -H "X-API-Key: YOUR_API_KEY" \
  -F "file=@./report.pdf" \
  -F "folder_id=456" \
  http://127.0.0.1:8550/api/v1/files
```

The endpoint returns `400` for invalid multipart fields, `413` for an oversized file, and `500` if local staging or Telegram delivery fails.

#### Response (200 OK)
```json
{
  "id": 123,
  "folder_id": 456,
  "name": "uploaded_file.txt",
  "size": 1024,
  "mime_type": "text/plain",
  "created_at": "2026-06-16T01:00:00Z"
}
```

---

### 7. Delete File
Delete a specific file.

* **URL:** `/files/{message_id}`
* **Method:** `DELETE`
* **Auth Required:** Yes

#### Query Parameters
* `folder_id` (Optional): ID of folder containing the file

---

### 8. Copy File
Forward a file/message to another folder.

* **URL:** `/files/{message_id}/copy`
* **Method:** `POST`
* **Auth Required:** Yes

#### Request Body
```json
{
  "folder_id": 789,
  "source_folder_id": 456
}
```

---

### 9. Update File (Rename / Move)
Rename (edit description) or move a file.

* **URL:** `/files/{message_id}`
* **Method:** `PATCH`
* **Auth Required:** Yes

#### Request Body (All fields optional)
```json
{
  "name": "new_name.txt",
  "folder_id": 789,
  "source_folder_id": 456
}
```

---

### 10. Folder Management

#### List Folders
* **URL:** `/folders`
* **Method:** `GET`

#### Create Folder
* **URL:** `/folders`
* **Method:** `POST`
* Request Body: `{"name": "New Folder"}`

#### Rename Folder
* **URL:** `/folders/{folder_id}`
* **Method:** `PATCH`
* Request Body: `{"name": "New Folder Name"}`

#### Delete Folder
* **URL:** `/folders/{folder_id}`
* **Method:** `DELETE`

---

### 11. Storage Stats & Analytics

#### Storage Stats
Retrieve total storage consumed, file counts, and breakdown by folders and MIME types.
* **URL:** `/storage/stats`
* **Method:** `GET`

#### Response (200 OK)
```json
{
  "total_storage_used_bytes": 10485760,
  "total_file_count": 12,
  "folders": [
    { "id": 456, "name": "Documents", "file_count": 5, "size_bytes": 5242880 }
  ],
  "mime_types": [
    { "mime_type": "application/pdf", "file_count": 5, "size_bytes": 5242880 }
  ]
}
```

#### Duplicate Files Finder
List groups of files with identical filenames and sizes.
* **URL:** `/storage/duplicates`
* **Method:** `GET`

#### Empty Folders
List folders that do not contain any files.
* **URL:** `/folders/empty`
* **Method:** `GET`

---

### 12. File Media & Thumbnails

#### Get File Thumbnail
Return the raw binary image data for a file's thumbnail.
* **URL:** `/files/{message_id}/thumbnail`
* **Method:** `GET`
* Query Param: `folder_id` (Optional)

#### Get Extended Media Info
Return video duration, resolution, audio title, or audio performer metadata.
* **URL:** `/files/{message_id}/media-info`
* **Method:** `GET`
* Query Param: `folder_id` (Optional)

---

### 13. Bulk Operations
Perform action operations (such as move, delete, or archive) across multiple files.

* **URL:** `/files/bulk`
* **Method:** `POST`
* **Auth Required:** Yes

#### Bulk Archive (Zip Download)
Download selected files as a zip archive stream.
```json
{
  "action": "archive",
  "file_ids": [123, 124, 125],
  "folder_id": 456
}
```

#### Bulk Delete
```json
{
  "action": "delete",
  "file_ids": [123, 124, 125],
  "folder_id": 456
}
```

#### Bulk Move
```json
{
  "action": "move",
  "file_ids": [123],
  "folder_id": 111,
  "payload": {
    "folder_id": 222
  }
}
```

---

## Security and limitations

- The API listens only on `127.0.0.1` and is intended for trusted software running on the same computer.
- Treat the API key as a password. Any local process or user with the key can use the enabled operations.
- Telegram Drive stores only a hash of the key and does not write the plaintext key to application logs.
- Encrypted files fail closed for plaintext REST access, including download, thumbnail, media-info, rename/move, copy, and delete operations that are not safely supported for encrypted objects.
- Telegram service limits, channel permissions, proxy/VPN settings, bandwidth limits, and flood waits still apply.
- Folder Sync, WebDAV, and the REST API operate on the same Telegram channels. Allow one operation to finish before changing the same file through another integration.
- Disabling the server or regenerating its key revokes access. The server is unavailable when the desktop app is closed or signed out.

See the [Folder Sync guide](SYNC_GUIDE.md), [WebDAV guide](WEBDAV_GUIDE.md), and [Privacy Policy](PRIVACY.md) for related behavior.

---

## Error Responses

The API returns standardized JSON error formats on failure:

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid API key"
  }
}
```
