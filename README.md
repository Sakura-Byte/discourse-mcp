# discourse-mcp (Cloudflare-friendly fork)

Fork of the official [discourse/discourse-mcp](https://github.com/discourse/discourse-mcp) that routes Discourse API traffic through **[impers](https://github.com/lexiforest/impers)** (curl-impersonate / curl_cffi-style TLS fingerprints).

Use this when the target forum sits behind **Cloudflare** (or similar) and the stock MCP gets `403 Just a moment...` from Node's native `fetch`.

| | Upstream `@discourse/mcp` | This fork |
|--|---------------------------|-----------|
| HTTP | `fetch` | `impers` + browser impersonate |
| Default fingerprint | — | `chrome120` (override with `--impersonate` / profile) |
| CF 403 | fails immediately | **delayed retry** (same profile, backoff) |
| Images | markdown `upload://` only | **`discourse_read_image`** returns MCP `image` content (base64) for vision models |
| HTTP rate limit | write tools ~1/s only | Optional **sliding window** on all HTTP (`rate_limit_*` profile fields) |
| libcurl-impersonate | — | impers resolve order; if missing, **`gh` download fallback** |

Requires **Node.js >= 24**.

---

## Install in Grok Build

### 1. Profile (auth)

Create `~/.grok/discourse-profile.json` (example for a User API key):

```json
{
  "site": "https://www.example.com/",
  "impersonate": "chrome120",
  "auth_pairs": [
    {
      "site": "https://www.example.com/",
      "user_api_key": "YOUR_USER_API_KEY",
      "user_api_client_id": "discourse-mcp"
    }
  ],
  "read_only": false,
  "allow_writes": true,
  "log_level": "info",
  "rate_limit_max": 15,
  "rate_limit_window_ms": 60000,
  "rate_limit_min_interval_ms": 200
}
```

### HTTP sliding-window rate limit

Measured on uscardforum (Cloudflare / edge):

| Observation | Value |
|-------------|--------|
| Burst until first **429** | **~20** sequential requests |
| Recovery after full burst | **~40s** of continued 429 on probes, then OK |
| Sustained 1 req / 0.8–1.2s | Still hits 429 after **~20** → **not pure RPS** |
| Sustained 1 rps in earlier run | Can stay green for short runs, but window still caps at ~20 |

So the dominant pattern is **~20 requests per rolling ~60s window**, not a fixed RPS ceiling. Client-side limit should be a **sliding window**.

Profile / CLI:

| Field | Meaning |
|-------|---------|
| `rate_limit_max` | Max requests in the window (`0` = off, default) |
| `rate_limit_window_ms` | Window length (default `60000`) |
| `rate_limit_min_interval_ms` | Optional min gap between requests |

uscardforum-safe defaults used locally: **15 / 60s** + **200ms** min interval (margin under the ~20 hard edge).

Generate a User API key (no admin required):

```bash
npx -y github:Sakura-Byte/discourse-mcp generate-user-api-key \
  --site https://www.example.com/ \
  --save-to ~/.grok/discourse-profile.json
```

### 2. `~/.grok/config.toml`

```toml
[mcp_servers.discourse]
command = "npx"
args = [
  "-y",
  "github:Sakura-Byte/discourse-mcp",
  "--profile",
  "/Users/YOU/.grok/discourse-profile.json",
]
enabled = true
startup_timeout_sec = 120
```

> First launch may download npm deps and `libcurl-impersonate` (or use `gh` if GitHub API is rate-limited). Prefer a longer `startup_timeout_sec`.

### 3. Refresh MCP

- New Grok session, or `/mcps` → `r` refresh  
- Check: `grok mcp doctor discourse`

---

## Install in other MCP clients

### Claude Desktop / Cursor-style JSON

```json
{
  "mcpServers": {
    "discourse": {
      "command": "npx",
      "args": [
        "-y",
        "github:Sakura-Byte/discourse-mcp",
        "--profile",
        "/absolute/path/to/profile.json"
      ]
    }
  }
}
```

### Local clone

```bash
git clone https://github.com/Sakura-Byte/discourse-mcp.git
cd discourse-mcp
npm install   # runs prepare → tsc build
node dist/index.js --profile /path/to/profile.json
```

Grok / client:

```toml
[mcp_servers.discourse]
command = "node"
args = ["/ABS/PATH/discourse-mcp/dist/index.js", "--profile", "/path/to/profile.json"]
enabled = true
startup_timeout_sec = 60
```

---

## libcurl-impersonate

Resolution order (impers native):

1. `LIBCURL_IMPERSONATE_PATH`
2. `LIBCURL_PATH`
3. Common install paths
4. GitHub download into `~/.cache/impers/libcurl-impersonate/{platform}-{arch}/`
5. System libcurl (no impersonate)

If step 4 fails (e.g. API rate limit), this fork tries **`gh`**:

| Situation | Behaviour |
|-----------|-----------|
| `gh` installed + logged in | `gh release download` into the same cache dir |
| `gh` installed, not logged in | Interactive `gh auth login` if TTY; else print instructions |
| no `gh` | Install/login hints + manual extract path |

```bash
brew install gh && gh auth login   # recommended once
```

Override: `DISCOURSE_MCP_REQUIRE_IMPERSONATE=0` allows starting without impersonate (CF sites will usually fail).

---

## CLI / profile flags (same as upstream + extras)

| Flag / field | Meaning |
|--------------|---------|
| `--profile path.json` | Load config from file |
| `--site URL` | Tether to one site |
| `--auth_pairs '[...]'` | Per-site API / User API keys |
| `--allow_writes --read_only=false` | Enable write tools |
| `--impersonate chrome120` | Browser fingerprint (also in profile) |
| `--log_level debug` | Verbose HTTP |

### Reading images (for vision models)

MCP tools should return images as **Image Content** blocks (not only a base64 string inside JSON text):

```json
{
  "content": [
    { "type": "text", "text": "{...metadata...}" },
    { "type": "image", "data": "<base64>", "mimeType": "image/jpeg" }
  ]
}
```

Use **`discourse_read_image`**:

```json
{ "post_id": 8564338, "max_images": 2 }
```

```json
{ "url": "upload://q9cFN6AzFPTkcn4CVcNmkuXNDTi.jpeg" }
```

```json
{ "url": "https://asset-cdn.example.com/.../photo.jpeg" }
```

Typical flow: `discourse_read_post` → see `![alt](upload://...)` in `raw` → `discourse_read_image` with `post_id` or that `upload://` URL.

See upstream docs for the rest of the tool list (search, read topic/post, create post/topic, drafts, …).

---

## Upstream

Based on [discourse/discourse-mcp](https://github.com/discourse/discourse-mcp) (MIT).  
Cloudflare / impers / `gh` bootstrap changes live in this fork only.
