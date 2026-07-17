/**
 * Sliding-window rate limiter for outbound HTTP.
 *
 * - In-memory (default): per process only.
 * - File-backed: shared across all MCP processes/clients on this machine
 *   via a state JSON + exclusive lockfile under ~/.cache/discourse-mcp/rate-limit
 *   (NOT under ~/.grok — applies to every client that runs this package).
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface SlidingWindowOptions {
  /** Max requests in the rolling window. 0 / undefined = disabled. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Optional minimum interval between requests (ms). */
  minIntervalMs?: number;
  /**
   * If set, persist timestamps to this JSON path and coordinate via
   * `${statePath}.lock` so multiple processes share one window.
   */
  statePath?: string;
  /** Lock stale age before steal (ms). Default 30s. */
  lockStaleMs?: number;
  /** Max time to wait for lock (ms). Default 15s. */
  lockTimeoutMs?: number;
}

type StateFile = { v: 1; timestamps: number[] };

/** Default cache dir for cross-process rate limit state (client-agnostic). */
export function defaultRateLimitStateDir(): string {
  if (process.env.DISCOURSE_MCP_RATE_LIMIT_DIR) {
    return process.env.DISCOURSE_MCP_RATE_LIMIT_DIR;
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA || join(homedir(), "AppData", "Local");
    return join(base, "discourse-mcp", "rate-limit");
  }
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "discourse-mcp", "rate-limit");
}

/** Stable state file path for a site origin. */
export function rateLimitStatePathForOrigin(origin: string, stateDir?: string): string {
  const dir = stateDir || defaultRateLimitStateDir();
  const hash = createHash("sha1").update(origin).digest("hex");
  return join(dir, `${hash}.json`);
}

export function originFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl;
  }
}

export class SlidingWindowRateLimiter {
  private timestamps: number[] = [];
  private chain: Promise<void> = Promise.resolve();
  private fileMode: boolean;
  private warnedFileFallback = false;

  constructor(
    private readonly opts: SlidingWindowOptions,
    private readonly onWarn?: (msg: string) => void
  ) {
    this.fileMode = Boolean(opts.statePath);
  }

  get enabled(): boolean {
    return this.opts.max > 0 && this.opts.windowMs > 0;
  }

  get statePath(): string | undefined {
    return this.opts.statePath;
  }

  /**
   * Serialize acquires in-process; file lock serializes across processes.
   */
  async acquire(): Promise<number> {
    if (!this.enabled) return 0;

    let waited = 0;
    const run = async () => {
      if (this.fileMode && this.opts.statePath) {
        try {
          waited = await this.waitAndRecordFile(this.opts.statePath);
          return;
        } catch (e: any) {
          if (!this.warnedFileFallback) {
            this.warnedFileFallback = true;
            this.onWarn?.(
              `File rate-limit failed (${e?.message || e}); falling back to in-process limiter for this process`
            );
          }
          // Fall through to memory for this and future acquires in this process
          this.fileMode = false;
        }
      }
      waited = await this.waitAndRecordMemory();
    };

    const prev = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      await run();
    } finally {
      release();
    }
    return waited;
  }

  private async waitAndRecordMemory(): Promise<number> {
    let totalWait = 0;
    for (;;) {
      const now = Date.now();
      const windowMs = this.opts.windowMs;
      this.timestamps = this.timestamps.filter((t) => now - t < windowMs);

      let waitMs = 0;
      const minInterval = this.opts.minIntervalMs ?? 0;
      if (minInterval > 0 && this.timestamps.length > 0) {
        const sinceLast = now - this.timestamps[this.timestamps.length - 1];
        if (sinceLast < minInterval) {
          waitMs = Math.max(waitMs, minInterval - sinceLast);
        }
      }

      if (this.timestamps.length >= this.opts.max) {
        const oldest = this.timestamps[0];
        waitMs = Math.max(waitMs, windowMs - (now - oldest) + 1);
      }

      if (waitMs <= 0) {
        this.timestamps.push(Date.now());
        return totalWait;
      }

      await sleep(waitMs);
      totalWait += waitMs;
    }
  }

  private async waitAndRecordFile(statePath: string): Promise<number> {
    let totalWait = 0;
    mkdirSync(dirname(statePath), { recursive: true });

    for (;;) {
      const waitMs = await withFileLock(
        `${statePath}.lock`,
        {
          staleMs: this.opts.lockStaleMs ?? 30_000,
          timeoutMs: this.opts.lockTimeoutMs ?? 15_000,
        },
        () => {
          const now = Date.now();
          const windowMs = this.opts.windowMs;
          let timestamps = readState(statePath).timestamps.filter((t) => now - t < windowMs);

          let wait = 0;
          const minInterval = this.opts.minIntervalMs ?? 0;
          if (minInterval > 0 && timestamps.length > 0) {
            const sinceLast = now - timestamps[timestamps.length - 1];
            if (sinceLast < minInterval) {
              wait = Math.max(wait, minInterval - sinceLast);
            }
          }
          if (timestamps.length >= this.opts.max) {
            wait = Math.max(wait, windowMs - (now - timestamps[0]) + 1);
          }

          if (wait > 0) {
            return wait;
          }

          timestamps.push(Date.now());
          writeState(statePath, { v: 1, timestamps });
          return 0;
        }
      );

      if (waitMs <= 0) {
        return totalWait;
      }
      await sleep(waitMs);
      totalWait += waitMs;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readState(path: string): StateFile {
  try {
    if (!existsSync(path)) return { v: 1, timestamps: [] };
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as StateFile;
    if (!parsed || !Array.isArray(parsed.timestamps)) return { v: 1, timestamps: [] };
    return {
      v: 1,
      timestamps: parsed.timestamps.filter((t) => typeof t === "number" && Number.isFinite(t)),
    };
  } catch {
    return { v: 1, timestamps: [] };
  }
}

function writeState(path: string, state: StateFile): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), "utf8");
  renameSync(tmp, path);
}

function withFileLock<T>(
  lockPath: string,
  opts: { staleMs: number; timeoutMs: number },
  fn: () => T
): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tryOnce = () => {
      try {
        // Exclusive create
        const fd = openSync(lockPath, "wx");
        try {
          writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
          closeSync(fd);
        } catch {
          try {
            closeSync(fd);
          } catch {
            /* ignore */
          }
        }

        try {
          const result = fn();
          resolve(result);
        } catch (e) {
          reject(e);
        } finally {
          try {
            unlinkSync(lockPath);
          } catch {
            /* ignore */
          }
        }
        return;
      } catch (e: any) {
        if (e?.code !== "EEXIST") {
          reject(e);
          return;
        }
        // Stale lock recovery
        try {
          const st = statSync(lockPath);
          if (Date.now() - st.mtimeMs > opts.staleMs) {
            let stalePid: number | null = null;
            try {
              const txt = readFileSync(lockPath, "utf8");
              const line = txt.split("\n")[0];
              const n = Number(line);
              if (Number.isFinite(n)) stalePid = n;
            } catch {
              /* ignore */
            }
            if (stalePid === null || !pidAlive(stalePid)) {
              try {
                unlinkSync(lockPath);
              } catch {
                /* ignore */
              }
            }
          }
        } catch {
          /* ignore */
        }

        if (Date.now() - started > opts.timeoutMs) {
          reject(new Error(`Timed out waiting for rate-limit lock: ${lockPath}`));
          return;
        }
        setTimeout(tryOnce, 20 + Math.floor(Math.random() * 30));
      }
    };
    tryOnce();
  });
}

function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
