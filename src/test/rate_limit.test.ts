import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SlidingWindowRateLimiter,
  rateLimitStatePathForOrigin,
  defaultRateLimitStateDir,
} from "../http/rate_limit.js";

test("disabled when max is 0", async () => {
  const lim = new SlidingWindowRateLimiter({ max: 0, windowMs: 1000 });
  assert.equal(lim.enabled, false);
  const w = await lim.acquire();
  assert.equal(w, 0);
});

test("in-memory: allows max acquires then waits for window", async () => {
  const lim = new SlidingWindowRateLimiter({ max: 3, windowMs: 200 });
  const t0 = Date.now();
  await lim.acquire();
  await lim.acquire();
  await lim.acquire();
  const waited = await lim.acquire();
  const elapsed = Date.now() - t0;
  assert.ok(waited >= 150, `expected wait >=150, got ${waited}`);
  assert.ok(elapsed >= 150, `expected elapsed >=150, got ${elapsed}`);
});

test("in-memory: minInterval enforces gap", async () => {
  const lim = new SlidingWindowRateLimiter({ max: 10, windowMs: 5000, minIntervalMs: 80 });
  const t0 = Date.now();
  await lim.acquire();
  await lim.acquire();
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 70, `expected gap, elapsed=${elapsed}`);
});

test("defaultRateLimitStateDir is not under .grok", () => {
  const dir = defaultRateLimitStateDir();
  assert.ok(!dir.includes(`${join(".grok")}`), dir);
  assert.ok(dir.includes("discourse-mcp"), dir);
});

test("file-backed: two instances share the same window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dmcp-rl-"));
  try {
    const statePath = rateLimitStatePathForOrigin("https://example.com", dir);
    const a = new SlidingWindowRateLimiter({ max: 3, windowMs: 400, statePath });
    const b = new SlidingWindowRateLimiter({ max: 3, windowMs: 400, statePath });

    await a.acquire();
    await b.acquire();
    await a.acquire();
    // 4th across both instances must wait
    const t0 = Date.now();
    const waited = await b.acquire();
    const elapsed = Date.now() - t0;
    assert.ok(waited >= 150 || elapsed >= 150, `shared window wait waited=${waited} elapsed=${elapsed}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file-backed: concurrent acquires from two limiters stay within max", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dmcp-rl-"));
  try {
    const statePath = rateLimitStatePathForOrigin("https://forum.example", dir);
    const opts = { max: 5, windowMs: 2000, statePath };
    const a = new SlidingWindowRateLimiter(opts);
    const b = new SlidingWindowRateLimiter(opts);

    // Fire 10 concurrent acquires; all should eventually complete without throwing
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? a : b).acquire())
    );
    assert.equal(results.length, 10);
    // At least some should have waited (only 5 slots)
    assert.ok(results.some((w) => w > 0), `expected some waits, got ${results.join(",")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
