import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDailyScanLimit, ScanStore } from "../scanCache.js";

test("scan cache keys separate images and target languages", () => {
  const store = new ScanStore(":memory:");
  try {
    assert.equal(store.cacheKey("image", "English"), store.cacheKey("image", " english "));
    assert.notEqual(store.cacheKey("image", "English"), store.cacheKey("other", "English"));
    assert.notEqual(store.cacheKey("image", "English"), store.cacheKey("image", "Japanese"));
  } finally {
    store.close();
  }
});

test("successful scans are reused until their TTL expires", () => {
  const store = new ScanStore(":memory:", 1_000);
  try {
    const key = store.cacheKey("receipt-photo", "English");
    assert.equal(store.cached(key), undefined);
    store.remember(key, { merchant: "Cafe", total: 12 }, 1_000);
    assert.deepEqual(store.cached(key, 1_999), { merchant: "Cafe", total: 12 });
    assert.equal(store.cached(key, 2_000), undefined);
    store.remember(key, { merchant: "Cafe", total: 12 }, 3_000);
    assert.deepEqual(store.cached(key, 3_500), { merchant: "Cafe", total: 12 });
  } finally {
    store.close();
  }
});

test("a corrupt cache row is discarded instead of breaking every scan", () => {
  const dir = mkdtempSync(join(tmpdir(), "deochipei-scan-"));
  const file = join(dir, "cache.db");
  const store = new ScanStore(file);
  const key = store.cacheKey("receipt-photo", "English");
  store.remember(key, { merchant: "Cafe" });
  store.close();

  const raw = new DatabaseSync(file);
  raw.prepare("UPDATE scan_cache SET value = ? WHERE key = ?").run("{not json", key);
  raw.close();

  const reopened = new ScanStore(file);
  try {
    assert.equal(reopened.cached(key), undefined);
    // A later successful scan can occupy the same key again.
    reopened.remember(key, { merchant: "Cafe" });
    assert.deepEqual(reopened.cached(key), { merchant: "Cafe" });
  } finally {
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daily quota is per account, per UTC day, and does not extend when rejected", () => {
  const store = new ScanStore(":memory:");
  try {
    const morning = Date.UTC(2026, 9, 29, 8, 0, 0);
    assert.deepEqual(store.consumeDaily("alice", 2, morning), { allowed: true, used: 1, limit: 2, retryAfterSec: 0 });
    assert.deepEqual(store.consumeDaily("alice", 2, morning + 1), { allowed: true, used: 2, limit: 2, retryAfterSec: 0 });
    const blocked = store.consumeDaily("alice", 2, morning + 2);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.used, 2);
    assert.equal(blocked.retryAfterSec, 16 * 60 * 60);
    // Rejections are not counted, and another account has its own allowance.
    assert.equal(store.consumeDaily("alice", 2, morning + 3).allowed, false);
    assert.equal(store.consumeDaily("bob", 2, morning + 3).allowed, true);

    // The allowance resets at UTC midnight, not on a rolling 24-hour window.
    const tomorrow = Date.UTC(2026, 9, 30, 0, 1, 0);
    assert.equal(store.consumeDaily("alice", 2, tomorrow).allowed, true);
  } finally {
    store.close();
  }
});

test("a zero daily limit means unlimited and invalid env values fall back", () => {
  const store = new ScanStore(":memory:");
  try {
    for (let i = 0; i < 100; i++) {
      assert.equal(store.consumeDaily("alice", 0).allowed, true);
    }
  } finally {
    store.close();
  }
  assert.equal(parseDailyScanLimit(""), 60);
  assert.equal(parseDailyScanLimit("25"), 25);
  assert.equal(parseDailyScanLimit("0"), 0);
  for (const bad of ["-1", "2.5", "many", "Infinity"]) {
    assert.equal(parseDailyScanLimit(bad), 60, bad);
  }
});
