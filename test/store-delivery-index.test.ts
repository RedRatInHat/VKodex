import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "better-sqlite3";
import { BridgeStore } from "../src/bridge/store.js";

test("the delivery queue reads pending rows through an index, not the full historical outbox", t => {
  const store = new BridgeStore();
  t.after(() => store.close());
  const db = (store as unknown as { db: Database }).db;
  const plans = [
    `SELECT * FROM bridge_delivery WHERE revision > delivered_revision
      AND kind IN ('send', 'commentary', 'panel', 'activity', 'delete')
      ORDER BY CASE kind WHEN 'send' THEN 0 WHEN 'panel' THEN 1 WHEN 'commentary' THEN 2 WHEN 'activity' THEN 3 ELSE 4 END, id`,
    `SELECT COUNT(*) AS count FROM bridge_delivery WHERE revision > delivered_revision
      AND kind IN ('send', 'commentary')`,
  ];
  for (const sql of plans) {
    const detail = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map(row => row.detail).join("\n");
    assert.match(detail, /USING INDEX bridge_delivery_pending/u);
    assert.doesNotMatch(detail, /SCAN bridge_delivery/u);
  }
});
