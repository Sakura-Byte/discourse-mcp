import test from "node:test";
import assert from "node:assert/strict";
import { SlidingWindowRateLimiter } from "../http/rate_limit.js";

test("disabled when max is 0", async () => {
  const lim = new SlidingWindowRateLimiter({ max: 0, windowMs: 1000 });
  assert.equal(lim.enabled, false);
  const w = await lim.acquire();
  assert.equal(w, 0);
});

test("allows max acquires then waits for window", async () => {
  const lim = new SlidingWindowRateLimiter({ max: 3, windowMs: 200 });
  const t0 = Date.now();
  await lim.acquire();
  await lim.acquire();
  await lim.acquire();
  // 4th must wait until first ages out (~200ms)
  const waited = await lim.acquire();
  const elapsed = Date.now() - t0;
  assert.ok(waited >= 150, `expected wait >=150, got ${waited}`);
  assert.ok(elapsed >= 150, `expected elapsed >=150, got ${elapsed}`);
});

test("minInterval enforces gap", async () => {
  const lim = new SlidingWindowRateLimiter({ max: 10, windowMs: 5000, minIntervalMs: 80 });
  const t0 = Date.now();
  await lim.acquire();
  await lim.acquire();
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 70, `expected gap, elapsed=${elapsed}`);
});
