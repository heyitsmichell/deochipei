import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTrustProxy, RateLimiter } from "../ratelimit.js";

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "deochipei-rate-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("allows up to the limit, then says how long to wait, then recovers", () => {
  const limiter = new RateLimiter(":memory:");
  const t = 1_000_000;
  for (let i = 0; i < 3; i++) assert.equal(limiter.hit("b", "k", 10_000, 3, t + i * 1000).allowed, true);
  const denied = limiter.hit("b", "k", 10_000, 3, t + 4000);
  assert.deepEqual(denied, { allowed: false, retryAfterSec: 6 }); // oldest hit leaves the window at t + 10s
  // A rejected request isn't recorded, so it doesn't push recovery later.
  assert.equal(limiter.hit("b", "k", 10_000, 3, t + 9000).allowed, false);
  assert.equal(limiter.hit("b", "k", 10_000, 3, t + 10_001).allowed, true);
  limiter.close();
});

test("keys and buckets are counted separately", () => {
  const limiter = new RateLimiter(":memory:");
  assert.equal(limiter.hit("ai", "user:a", 60_000, 1).allowed, true);
  assert.equal(limiter.hit("ai", "user:a", 60_000, 1).allowed, false);
  assert.equal(limiter.hit("ai", "user:b", 60_000, 1).allowed, true);
  assert.equal(limiter.hit("join", "user:a", 60_000, 1).allowed, true);
  limiter.reset();
  assert.equal(limiter.hit("ai", "user:a", 60_000, 1).allowed, true);
  limiter.close();
});

test("limits survive a restart", () => withDir(async (dir) => {
  const file = join(dir, "trips.db");
  const first = new RateLimiter(file);
  first.hit("ai", "user:a", 60_000, 2);
  first.hit("ai", "user:a", 60_000, 2);
  first.close();
  const second = new RateLimiter(file);
  assert.equal(second.hit("ai", "user:a", 60_000, 2).allowed, false);
  second.close();
}));

test("separate server processes share one limit exactly", () => withDir(async (dir) => {
  const file = join(dir, "trips.db");
  new RateLimiter(file).close(); // create the schema once up front
  const worker = fileURLToPath(new URL("./rate-writer.ts", import.meta.url));
  const runs = ["a", "b", "c"].map(async () => {
    const child = spawn(process.execPath, ["--import", "tsx", worker, file, "25"], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
    return Number(out.trim());
  });
  const allowed = (await Promise.all(runs)).reduce((a, b) => a + b, 0);
  assert.equal(allowed, 20); // 75 attempts across 3 processes, limit 20
}));

test("old rows are purged so idle keys don't pile up", () => withDir(async (dir) => {
  const file = join(dir, "trips.db");
  const limiter = new RateLimiter(file);
  for (let i = 0; i < 50; i++) limiter.hit("b", `k${i}`, 1000, 5, 1_000_000);
  limiter.hit("b", "later", 1000, 5, 1_000_000 + 120_000);
  limiter.close();
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM rate_hits").get()!.n), 1);
  db.close();
}));

test("TRUST_PROXY parsing", () => {
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy("false"), false);
  assert.equal(parseTrustProxy("true"), true);
  assert.equal(parseTrustProxy("1"), 1);
  assert.equal(parseTrustProxy("loopback"), "loopback");
});
