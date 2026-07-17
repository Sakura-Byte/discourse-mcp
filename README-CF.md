# discourse-mcp-cf

Local fork of [discourse/discourse-mcp](https://github.com/discourse/discourse-mcp) that routes all Discourse API HTTP traffic through **[impers](https://github.com/lexiforest/impers)** (Node bindings for curl-impersonate / curl_cffi-style TLS fingerprints).

Use this when the target Discourse site sits behind Cloudflare (or similar) that blocks Node's native `fetch` TLS fingerprint.

## Differences from upstream

| Area | Upstream | This fork |
|------|----------|-----------|
| HTTP client | `fetch` | `impers` + browser impersonate |
| Default fingerprint | n/a | `chrome120` (best match for official libcurl-impersonate releases on uscardforum) |
| Config | — | `impersonate` in profile / `--impersonate` |
| Startup | silent | fails if libcurl-impersonate is not loaded (override with `DISCOURSE_MCP_REQUIRE_IMPERSONATE=0`) |
| Package name | `@discourse/mcp` | `discourse-mcp-cf` |

Everything else (tools, resources, profile `auth_pairs`, User API keys, write safety) matches upstream.

## libcurl-impersonate resolution

1. **impers native order** (no vendor override):
   - `LIBCURL_IMPERSONATE_PATH`
   - `LIBCURL_PATH`
   - Common install paths (Homebrew, `/usr/local/lib`, …)
   - Auto-download from GitHub API into `~/.cache/impers/libcurl-impersonate/{platform}-{arch}/`
   - System `libcurl` (no impersonate)
2. **If still not impersonate** (common when GitHub API is rate-limited), this fork tries **`gh`**:
   - `gh` installed + logged in → `gh release download` into the same impers cache dir
   - `gh` installed but not logged in → interactive `gh auth login` when TTY is available; otherwise print instructions
   - no `gh` → install/`gh auth login` hints + manual download path to the cache dir

Optional:

- `IMPER_DOWNLOAD_LIBCURL=0` — disable impers' own GitHub download step
- `DISCOURSE_MCP_REQUIRE_IMPERSONATE=0` — allow starting with plain system libcurl (CF sites will fail)

## Setup

Requires **Node.js >= 24**.

```bash
cd /path/to/discourse-mcp-cf
npm install
npm run build
```

## Grok Build

```toml
[mcp_servers.discourse]
command = "node"
args = [
  "/ABS/PATH/discourse-mcp-cf/dist/index.js",
  "--profile",
  "/Users/YOU/.grok/discourse-uscardforum.json",
]
enabled = true
startup_timeout_sec = 60
```

Profile example:

```json
{
  "site": "https://www.uscardforum.com/",
  "impersonate": "chrome120",
  "auth_pairs": [
    {
      "site": "https://www.uscardforum.com/",
      "user_api_key": "...",
      "user_api_client_id": "discourse-mcp"
    }
  ],
  "read_only": false,
  "allow_writes": true
}
```

## Verify

```bash
node dist/index.js --profile ~/.grok/discourse-uscardforum.json
# stderr should show: libcurl-impersonate loaded ...

grok mcp doctor discourse
```
