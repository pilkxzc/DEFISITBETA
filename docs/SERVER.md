# Backend Server

> Self-hosted Express + SQLite backend for profile sync, authentication, and update delivery.

---

## Overview

The DEFIS backend is a lightweight Node.js server that handles:

- User authentication (JWT)
- Profile, bookmark, note, and history storage
- Global app configuration sync
- Update version management and binary distribution

It's designed to run on a VPS alongside the Electron app or separately for team deployments.

---

## Setup

```bash
cd page/defis-server
npm install
npm start
# → Listening on http://0.0.0.0:3717
# → Admin credentials written to .admin-credentials (first run only)
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DEFIS_PORT` | `3717` | Port to listen on |
| `DEFIS_DB` | `./defis.db` | SQLite database path |
| `DEFIS_ORIGINS` | — | Extra CORS origins (comma-separated) |
| `JWT_SECRET` | auto-generated | JWT signing secret (set for multi-instance) |

Create a `.env` file in `page/defis-server/`:

```bash
DEFIS_PORT=3717
DEFIS_DB=/data/defis.db
JWT_SECRET=your-long-random-secret
```

### First Run

On first start the server creates:
- `defis.db` — SQLite database with full schema
- `.admin-credentials` — file containing the auto-generated admin email and password

Print credentials:
```bash
cat page/defis-server/.admin-credentials
```

---

## REST API Reference

All authenticated endpoints require an `Authorization: Bearer <token>` header.

### Authentication

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/auth/login` | No | Login, returns JWT |
| `POST` | `/api/auth/register` | Admin | Register new user |
| `GET` | `/api/auth/validate` | Yes | Validate current token |
| `POST` | `/api/auth/refresh` | Yes | Refresh token |

**Login**
```http
POST /api/auth/login
Content-Type: application/json

{ "email": "user@example.com", "password": "secret" }
```
```json
{ "token": "eyJ...", "user": { "id": 1, "email": "user@example.com", "role": "admin" } }
```

---

### Profiles

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/profiles` | List all profiles |
| `POST` | `/api/profiles` | Create profile |
| `PUT` | `/api/profiles/:id` | Update profile |
| `DELETE` | `/api/profiles/:id` | Delete profile |

**Profile schema:**
```json
{
  "id": "uuid",
  "name": "Work Account",
  "proxy": "socks5://user:pass@1.2.3.4:1080",
  "userAgent": "Mozilla/5.0...",
  "fingerprint": { "canvasSeed": 847291, "timezone": "Europe/Kyiv", ... },
  "color": "#5B4CF6",
  "notes": "",
  "createdAt": "2025-01-01T00:00:00Z"
}
```

---

### Bookmarks

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/bookmarks?profileId=<id>` | Get bookmarks for profile |
| `POST` | `/api/bookmarks` | Add bookmark |
| `DELETE` | `/api/bookmarks/:id` | Remove bookmark |

---

### Notes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/notes/:profileId` | Get notes for profile |
| `PUT` | `/api/notes/:profileId` | Save notes (full replace) |
| `GET` | `/api/notes/share/:token` | Public share view (no auth) |
| `POST` | `/api/notes/:profileId/share` | Generate share link |

---

### History

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/history?profileId=<id>&limit=50` | Get browse history |
| `POST` | `/api/history` | Add history entry |
| `DELETE` | `/api/history?profileId=<id>` | Clear history for profile |

---

### Config

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/config` | Get global app config |
| `PUT` | `/api/config` | Update global app config |

Config stores agent settings (provider, model, API keys) and UI preferences.

---

### Version / Updates

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/version/latest` | No | Latest published version |
| `GET` | `/api/version/download/:platform` | No | Download binary |
| `POST` | `/api/version/upload` | Admin | Upload release binary |
| `POST` | `/api/version` | Admin | Publish version metadata |

**Latest version response:**
```json
{
  "version": "1.0.4",
  "notes": "Bug fixes and performance improvements",
  "forceUpdate": false,
  "publishedAt": "2025-02-22T00:00:00Z",
  "downloads": {
    "win32": "/api/version/download/win32",
    "linux": "/api/version/download/linux",
    "arch": "/api/version/download/arch"
  }
}
```

---

## Database Schema

```sql
-- Users
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'user',   -- 'user' | 'admin'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Profiles
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,         -- UUID
  user_id INTEGER REFERENCES users(id),
  name TEXT NOT NULL,
  data TEXT NOT NULL,          -- JSON blob (proxy, fingerprint, color, ...)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Bookmarks
CREATE TABLE bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT REFERENCES profiles(id),
  url TEXT NOT NULL,
  title TEXT,
  favicon TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Notes
CREATE TABLE notes (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id),
  content TEXT,               -- Rich text HTML
  share_token TEXT UNIQUE,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- History
CREATE TABLE history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT REFERENCES profiles(id),
  url TEXT NOT NULL,
  title TEXT,
  visited_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Config
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT               -- JSON value
);

-- Versions
CREATE TABLE versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT UNIQUE NOT NULL,
  notes TEXT,
  force_update INTEGER DEFAULT 0,
  published_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## Production Deployment

### Systemd Service

```ini
[Unit]
Description=DEFIS Browser Server
After=network.target

[Service]
Type=simple
User=defis
WorkingDirectory=/opt/defis/page/defis-server
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
Environment=DEFIS_PORT=3717
Environment=DEFIS_DB=/data/defis/defis.db
Environment=JWT_SECRET=<your-secret>

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable defis-server
sudo systemctl start defis-server
```

### Reverse Proxy (Nginx)

```nginx
server {
    listen 443 ssl;
    server_name defis.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3717;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
    }
}
```

---

## Rate Limiting

The server implements in-memory rate limiting:

- **Auth endpoints:** 10 requests / minute per IP
- **Upload endpoints:** 5 requests / minute per IP
- **All other endpoints:** 300 requests / minute per IP

Rate limit buckets reset on server restart. For production, consider using a Redis-backed rate limiter.
