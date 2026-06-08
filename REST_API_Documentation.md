# Telegram Drive REST API Documentation

A clean and professional REST API specification for interacting with Telegram Drive programmatically.

## Base URL

```http
http://localhost:8550/api/v1
```

---

## Authentication

All endpoints (except `/health`) require an API key passed via request headers.

| Header | Type | Description |
| :--- | :--- | :--- |
| `X-API-Key` | String | Your Telegram Drive API access key |

### Example Request

```bash
curl -H "X-API-Key: YOUR_API_KEY" \
  http://localhost:8550/api/v1/files
```

---

## Endpoints

### 1. Health Check
Check API availability, status, and running version.

* **URL:** `/health`
* **Method:** `GET`
* **Auth Required:** No

#### Example Request
```bash
curl http://localhost:8550/api/v1/health
```

#### Response (200 OK)
```json
{
  "status": "ok",
  "version": "1.8.4"
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
| `order` | String | Sort order: `asc` (ascending) or `desc` (descending) |
| `mime_type` | String | Filter files by a specific MIME type |
| `created_after` | String | Filter files created after date (ISO format) |
| `created_before` | String | Filter files created before date (ISO format) |
| `size_min` | Integer | Minimum file size in bytes |
| `size_max` | Integer | Maximum file size in bytes |
| `fields` | String | Comma-separated list of fields to include in response |

#### Example Request
```bash
curl -H "X-API-Key: YOUR_API_KEY" \
  "http://localhost:8550/api/v1/files?page=1&limit=20"
```

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

#### Example Request
```bash
curl -H "X-API-Key: YOUR_API_KEY" \
  http://localhost:8550/api/v1/files/123
```

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

#### Features Supported
* **HTTP Range Requests** (e.g., seeking in videos/audios)
* **Resumable Downloads**
* **Direct Content Streaming**

#### Example Request
```bash
curl -H "X-API-Key: YOUR_API_KEY" \
  -o file.bin \
  http://localhost:8550/api/v1/files/123/download
```

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
| `folder_id` | Integer | Optional folder ID filter |
| `recursive` | Boolean | Perform recursive search across folders |

#### Example Request
```bash
curl -H "X-API-Key: YOUR_API_KEY" \
  "http://localhost:8550/api/v1/files/search?q=python"
```

#### Response (200 OK)
```json
[
  {
    "id": 123,
    "name": "python-guide.pdf",
    "size": 204800
  }
]
```

---

### 6. Bulk Operations
Perform action operations (such as move or delete) across multiple files.

* **URL:** `/files/bulk`
* **Method:** `POST`
* **Auth Required:** Yes

#### Bulk Delete Request Body
```json
{
  "action": "delete",
  "file_ids": [123, 124, 125]
}
```

#### Example Delete Request
```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"action":"delete","file_ids":[123,124]}' \
  http://localhost:8550/api/v1/files/bulk
```

#### Bulk Move Request Body
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

#### Example Move Request
```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"action":"move","file_ids":[123],"folder_id":111,"payload":{"folder_id":222}}' \
  http://localhost:8550/api/v1/files/bulk
```

#### Response (200 OK)
```json
{
  "success": true,
  "count": 1
}
```

---

## Error Responses

The API returns standardized JSON error formats on failure:

### Unauthorized (Invalid API Key)
* **Status:** `401 Unauthorized`
```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid API key"
  }
}
```

### Missing API Key
* **Status:** `401 Unauthorized`
```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Missing X-API-Key header"
  }
}
```

### File Not Found
* **Status:** `404 Not Found`
```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "File not found"
  }
}
```

### Invalid Request Action
* **Status:** `400 Bad Request`
```json
{
  "error": {
    "code": "INVALID_ACTION",
    "message": "Unsupported bulk action"
  }
}
```
