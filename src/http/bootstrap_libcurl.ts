/**
 * Fallback installer for libcurl-impersonate when impers' built-in GitHub
 * download fails (e.g. unauthenticated API rate limit).
 *
 * Uses the same cache layout as impers so resolveLibrary() picks it up:
 *   ~/.cache/impers/libcurl-impersonate/{platform}-{arch}/
 *
 * Flow when impersonate lib is missing:
 *   1. If `gh` is available and logged in → download via `gh release download`
 *   2. If `gh` exists but not logged in → prompt `gh auth login` (TTY) or print instructions
 *   3. If no `gh` → install/login instructions + manual download path
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync, copyFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Logger } from "../util/logger.js";

const REPO = "lexiforest/curl-impersonate";

export type BootstrapResult =
  | { ok: true; method: "gh"; cacheDir: string; asset: string }
  | { ok: false; reason: string; hint: string };

/** Mirror impers getCacheRoot() */
export function getImpersCacheRoot(): string {
  if (process.env.IMPER_CACHE_DIR) {
    return process.env.IMPER_CACHE_DIR;
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA;
    if (!base) {
      throw new Error("LOCALAPPDATA/APPDATA not set; cannot locate impers cache");
    }
    return join(base, "impers", "libcurl-impersonate");
  }
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "impers", "libcurl-impersonate");
}

/** Mirror impers getCacheDir(cacheRoot, platform, arch) */
export function getImpersCacheDir(): string {
  return join(getImpersCacheRoot(), `${process.platform}-${process.arch}`);
}

/** Glob pattern for gh release download --pattern (matches release asset names). */
export function libcurlAssetPattern(): string {
  const { platform, arch } = process;
  if (platform === "darwin") {
    return arch === "arm64"
      ? "libcurl-impersonate-*arm64-macos.tar.gz"
      : "libcurl-impersonate-*x86_64-macos.tar.gz";
  }
  if (platform === "linux") {
    // Prefer glibc builds; musl hosts can override via LIBCURL_IMPERSONATE_PATH
    return arch === "arm64"
      ? "libcurl-impersonate-*aarch64-linux-gnu.tar.gz"
      : "libcurl-impersonate-*x86_64-linux-gnu.tar.gz";
  }
  if (platform === "win32") {
    return arch === "arm64"
      ? "libcurl-impersonate-*arm64-win32.tar.gz"
      : "libcurl-impersonate-*x86_64-win32.tar.gz";
  }
  throw new Error(`Unsupported platform for libcurl-impersonate bootstrap: ${platform}/${arch}`);
}

function run(
  cmd: string,
  args: string[],
  opts: { inherit?: boolean; cwd?: string } = {}
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    cwd: opts.cwd,
    stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  return {
    status: r.status,
    stdout: (r.stdout as string) || "",
    stderr: (r.stderr as string) || "",
  };
}

export function hasGhCli(): boolean {
  const r = run("gh", ["--version"]);
  return r.status === 0;
}

export function isGhLoggedIn(): boolean {
  const r = run("gh", ["auth", "status"]);
  return r.status === 0;
}

function isTty(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function flattenLibrariesIntoCache(cacheDir: string): void {
  const libExt =
    process.platform === "darwin" ? ".dylib" : process.platform === "win32" ? ".dll" : ".so";

  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) out.push(...walk(p));
      else out.push(p);
    }
    return out;
  };

  for (const file of walk(cacheDir)) {
    const base = basename(file);
    // Keep libcurl-impersonate* and companion shared libs at cache root
    const isLib =
      base.startsWith("libcurl-impersonate") ||
      base.includes(libExt) ||
      base.endsWith(".dll") ||
      base.endsWith(".so") ||
      base.endsWith(".dylib");
    if (!isLib) continue;
    const dest = join(cacheDir, base);
    if (file === dest) continue;
    try {
      copyFileSync(file, dest);
    } catch {
      // ignore copy races / same-file
    }
  }
}

function manualInstallHint(cacheDir: string, pattern: string): string {
  const releaseUrl = `https://github.com/${REPO}/releases/latest`;
  return [
    "",
    "Manual install:",
    `  1. Open ${releaseUrl}`,
    `  2. Download the asset matching: ${pattern}`,
    `  3. Extract into: ${cacheDir}`,
    `     (so that libcurl-impersonate*.dylib / .so / .dll lives directly in that folder)`,
    `  4. Or set LIBCURL_IMPERSONATE_PATH to the full path of the library file`,
    "",
    "With GitHub CLI (recommended):",
    "  brew install gh   # or https://cli.github.com/",
    "  gh auth login",
    `  gh release download -R ${REPO} -p '${pattern}' -D /tmp/curl-imp-dl --clobber`,
    `  mkdir -p '${cacheDir}' && tar -xzf /tmp/curl-imp-dl/libcurl-impersonate-*.tar.gz -C '${cacheDir}'`,
    "",
  ].join("\n");
}

function ensureGhLoggedIn(logger: Logger): void {
  if (isGhLoggedIn()) return;

  logger.error("GitHub CLI (gh) is installed but not logged in.");
  if (isTty()) {
    logger.info("Launching `gh auth login` (interactive)...");
    const r = run("gh", ["auth", "login"], { inherit: true });
    if (r.status !== 0 || !isGhLoggedIn()) {
      throw new Error(
        "gh auth login did not complete successfully.\n" +
          "Run in a terminal: gh auth login\n" +
          "Then restart this MCP server." +
          manualInstallHint(getImpersCacheDir(), libcurlAssetPattern())
      );
    }
    logger.info("gh auth login succeeded.");
    return;
  }

  // Non-interactive (e.g. launched by Grok) — cannot prompt
  throw new Error(
    "gh is installed but not logged in, and this process has no interactive TTY.\n" +
      "In a terminal run:\n" +
      "  gh auth login\n" +
      "Then restart Grok / the Discourse MCP server." +
      manualInstallHint(getImpersCacheDir(), libcurlAssetPattern())
  );
}

/**
 * Download libcurl-impersonate into the impers cache using `gh`.
 * Call only when impers failed to load an impersonate library.
 */
export function bootstrapLibcurlWithGh(logger: Logger): BootstrapResult {
  const cacheDir = getImpersCacheDir();
  const pattern = libcurlAssetPattern();

  if (!hasGhCli()) {
    const hint = [
      "GitHub CLI (gh) is not installed on this machine.",
      "Install and login, then restart:",
      "  macOS:  brew install gh && gh auth login",
      "  Linux:  see https://github.com/cli/cli#installation && gh auth login",
      "  Windows: winget install GitHub.cli && gh auth login",
      manualInstallHint(cacheDir, pattern),
    ].join("\n");
    return { ok: false, reason: "gh_not_found", hint };
  }

  try {
    ensureGhLoggedIn(logger);
  } catch (e: any) {
    return {
      ok: false,
      reason: "gh_not_logged_in",
      hint: e?.message || String(e),
    };
  }

  const tmp = join(tmpdir(), `impers-libcurl-${process.pid}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  logger.info(`Downloading ${pattern} from ${REPO} via gh → ${cacheDir}`);

  const dl = run(
    "gh",
    [
      "release",
      "download",
      "-R",
      REPO,
      "-p",
      pattern,
      "-D",
      tmp,
      "--clobber",
    ],
    {}
  );

  if (dl.status !== 0) {
    const err = (dl.stderr || dl.stdout || "gh release download failed").trim();
    rmSync(tmp, { recursive: true, force: true });
    return {
      ok: false,
      reason: "gh_download_failed",
      hint: `gh release download failed: ${err}` + manualInstallHint(cacheDir, pattern),
    };
  }

  const archives = readdirSync(tmp).filter((n) => n.endsWith(".tar.gz") || n.endsWith(".tgz") || n.endsWith(".zip"));
  if (archives.length === 0) {
    rmSync(tmp, { recursive: true, force: true });
    return {
      ok: false,
      reason: "no_asset",
      hint: `No archive found after gh download for pattern ${pattern}` + manualInstallHint(cacheDir, pattern),
    };
  }

  const asset = archives[0];
  const archivePath = join(tmp, asset);

  if (asset.endsWith(".zip")) {
    const unzip = run("unzip", ["-o", archivePath, "-d", cacheDir]);
    if (unzip.status !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      return {
        ok: false,
        reason: "extract_failed",
        hint: `Failed to unzip ${asset}: ${unzip.stderr}` + manualInstallHint(cacheDir, pattern),
      };
    }
  } else {
    const tar = run("tar", ["-xzf", archivePath, "-C", cacheDir]);
    if (tar.status !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      return {
        ok: false,
        reason: "extract_failed",
        hint: `Failed to extract ${asset}: ${tar.stderr}` + manualInstallHint(cacheDir, pattern),
      };
    }
  }

  flattenLibrariesIntoCache(cacheDir);
  rmSync(tmp, { recursive: true, force: true });

  // Sanity: at least one libcurl-impersonate* file
  const files = readdirSync(cacheDir);
  const hasLib = files.some((f) => f.startsWith("libcurl-impersonate"));
  if (!hasLib) {
    return {
      ok: false,
      reason: "missing_lib_after_extract",
      hint:
        `Extracted archive but no libcurl-impersonate* found in ${cacheDir}` +
        manualInstallHint(cacheDir, pattern),
    };
  }

  logger.info(`libcurl-impersonate installed via gh: ${cacheDir} (asset ${asset})`);
  return { ok: true, method: "gh", cacheDir, asset };
}

export function formatBootstrapFailure(result: Extract<BootstrapResult, { ok: false }>): string {
  return [
    "Could not obtain libcurl-impersonate.",
    `Reason: ${result.reason}`,
    result.hint,
  ].join("\n");
}
