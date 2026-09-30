import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "better-sqlite3";
import { BridgeStore, TRANSFER_SCAN_SQL } from "../src/bridge/store.js";

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
  const peerPlans = [
    { sql: `SELECT MAX(id) AS id FROM bridge_delivery WHERE peer_id = 42
        AND kind IN ('send', 'commentary', 'panel', 'activity')`, index: "bridge_delivery_peer_order" },
    { sql: `SELECT MAX(CASE WHEN json_valid(handle) THEN json_extract(handle, '$.conversationMessageId') END) AS id FROM bridge_delivery
        WHERE peer_id = 42 AND handle IS NOT NULL`, index: "bridge_delivery_peer_message" },
  ];
  for (const { sql, index } of peerPlans) {
    const detail = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map(row => row.detail).join("\n");
    assert.match(detail, new RegExp(`USING INDEX ${index}`, "u"));
    assert.doesNotMatch(detail, /SCAN bridge_delivery/u);
  }
  const transferDetail = (db.prepare(`EXPLAIN QUERY PLAN ${TRANSFER_SCAN_SQL}`).all() as { detail: string }[])
    .map(row => row.detail).join("\n");
  assert.match(transferDetail, /USING INDEX/u);
  assert.doesNotMatch(transferDetail, /SCAN bridge_values/u);
});

test("peer ordering uses confirmed message handles while ignoring a malformed historical handle", t => {
  const store = new BridgeStore();
  t.after(() => store.close());
  const db = (store as unknown as { db: Database }).db;
  db.prepare(`INSERT INTO bridge_delivery(key, peer_id, kind, view, handle)
    VALUES (?, 42, 'send', '{"text":"ok"}', ?)`).run("valid", '{"conversationMessageId":17}');
  db.prepare(`INSERT INTO bridge_delivery(key, peer_id, kind, view, handle)
    VALUES (?, 42, 'send', '{"text":"old"}', ?)`).run("corrupt", "incomplete-json");
  assert.equal(store.latestPeerMessage(42), 17);
  assert.equal(store.latestPeerDeliveryOrder(42), 2);
  store.observePeerMessage(42, 19);
  assert.equal(store.latestPeerMessage(42), 19);
});
