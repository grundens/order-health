// Round 3 integration tests for the order-layer classification (Units 1 + 2), driven
// through computeOrders against a SEEDED read-only board (no live NAV / Shopify). They
// prove: a Happy Return is excluded from awaiting_ship grading, and an FS-floored
// awaiting_ship order classifies fs_floor_at_zero with the FS + warehouse numbers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeOrders } from './writers.js';
import { agoIso, greenDtcOrder, happyReturnOrder, makeSeededSources, stuckStagingDtcOrder } from './seededBoard.js';
import type { OosHeldOrder } from '@order-health/shared';

// A middleware OOS-held backlog row. `held` builds one with sensible defaults so a
// test only spells out the fields it cares about (order_name, status, class).
function heldRow(over: Partial<OosHeldOrder> & Pick<OosHeldOrder, 'order_id' | 'order_name'>): OosHeldOrder {
  return {
    held_class: 'transient',
    status: 'needs_operator',
    attempts: 9,
    first_seen_at: '2026-07-19T11:35:13.000Z',
    last_attempt_at: '2026-07-20T11:35:13.000Z',
    last_detail: 're-check window expired without recovery',
    age_s: null,
    nav_bucket: null,
    remediation_tool_id: null,
    ...over,
  };
}

test('Unit 2: a Happy Return is reclassified out of awaiting_ship (green, classification return)', async () => {
  const now = Date.now();
  const sources = makeSeededSources({ now, orders: [happyReturnOrder('HR-HR23YXMM', now)] });
  const orders = await computeOrders(sources);
  const hr = orders.find((o) => o.nav_order_no === 'HR-HR23YXMM');
  assert.ok(hr);
  assert.equal(hr.order_verdict, 'green'); // not a red stall
  assert.notEqual(hr.current_stage, 'awaiting_ship');
  assert.equal(hr.classification, 'return');
  assert.match(hr.awaiting_ship_detail?.why ?? '', /Return|not an outbound/);
});

test('Unit 1: an FS-floored awaiting_ship order classifies fs_floor_at_zero with the numbers', async () => {
  const now = Date.now();
  const sources = makeSeededSources({
    now,
    orders: [stuckStagingDtcOrder('1002', now)], // 5-day-old unshipped DTC => awaiting_ship red
    orderLines: [{ orderNo: '1002', sku: 'A', location: 'TAC', outstandingQty: 1 }],
    inventoryAvailability: [{ sku: 'A', location: 'TAC', availableQty: 278 }], // warehouse stocked
    fsInventory: [{ sku: 'A', available: -1, onHand: 0, committed: 1 }], // FS floored negative
  });
  const orders = await computeOrders(sources);
  const o = orders.find((x) => x.nav_order_no === '1002');
  assert.ok(o);
  assert.equal(o.order_verdict, 'red'); // still a real stall
  assert.equal(o.classification, 'fs_floor_at_zero');
  assert.equal(o.awaiting_ship_detail?.fs_available, -1);
  assert.equal(o.awaiting_ship_detail?.nav_warehouse_on_hand, 278);
  assert.equal(o.awaiting_ship_detail?.sample_sku, 'A');
  assert.match(o.awaiting_ship_detail?.why ?? '', /FS floor-at-zero|re-floor/);
});

// --- Round 4: the ORDER VERDICT follows ownership, not the stage dot ---------
// This is the fix for "100% of these are Holman delay": an order whose 940 was sent and
// 997-acknowledged is not stuck, whatever its ship stage looks like. It is a risk once
// it passes Holman's window, so amber, owned by Holman, never red and never re-driven.

test('Round 4: an acked 940 past Holman\'s window grades AMBER with a Holman label, not red', async () => {
  const now = Date.now();
  const sources = makeSeededSources({
    now,
    orders: [stuckStagingDtcOrder('SP-322263-1', now)], // stage grading would call this red
    orderLines: [{ orderNo: 'SP-322263-1', sku: 'C', location: 'HF1FTZ', outstandingQty: 1 }],
    inventoryAvailability: [{ sku: 'C', location: 'HF1FTZ', availableQty: 12 }],
    fsInventory: [{ sku: 'C', available: 4, onHand: 4, committed: 0 }], // FS healthy: not the floor bug
    ediHandoff: [{ orderNo: 'SP-322263-1', sent: 1, acked: 1 }],
  });
  const orders = await computeOrders(sources);
  const o = orders.find((x) => x.nav_order_no === 'SP-322263-1');
  assert.ok(o);
  assert.equal(o.order_verdict, 'amber');
  assert.equal(o.handoff?.state, 'holman_delayed');
  assert.equal(o.handoff?.owner, 'holman');
  assert.equal(o.handoff?.label, 'Holman delay');
  // Not "stuck": the oldest-stuck headline must not count someone else's backlog.
  assert.equal(o.oldest_stuck_age_s, null);
});

test('Round 4: a released order with stock and no 940 at all stays RED and is ours', async () => {
  const now = Date.now();
  const sources = makeSeededSources({
    now,
    orders: [{ ...stuckStagingDtcOrder('SP-999999-1', now), navStatus: 1 }],
    orderLines: [{ orderNo: 'SP-999999-1', sku: 'D', location: 'HF1FTZ', outstandingQty: 1 }],
    inventoryAvailability: [{ sku: 'D', location: 'HF1FTZ', availableQty: 9 }],
    fsInventory: [{ sku: 'D', available: 5, onHand: 5, committed: 0 }],
    ediHandoff: [],
  });
  const orders = await computeOrders(sources);
  const o = orders.find((x) => x.nav_order_no === 'SP-999999-1');
  assert.ok(o);
  assert.equal(o.order_verdict, 'red');
  assert.equal(o.handoff?.state, 'handoff_failed');
  assert.equal(o.handoff?.owner, 'grundens_ops');
});

test('Unit 1: an in-stock awaiting_ship order with FS available >= 0 classifies genuine_3pl_delay', async () => {
  const now = Date.now();
  const sources = makeSeededSources({
    now,
    orders: [stuckStagingDtcOrder('1003', now)],
    orderLines: [{ orderNo: '1003', sku: 'B', location: 'TAC', outstandingQty: 1 }],
    inventoryAvailability: [{ sku: 'B', location: 'TAC', availableQty: 40 }],
    fsInventory: [{ sku: 'B', available: 8, onHand: 8, committed: 0 }], // FS healthy
  });
  const orders = await computeOrders(sources);
  const o = orders.find((x) => x.nav_order_no === '1003');
  assert.equal(o?.classification, 'genuine_3pl_delay');
});

// --- OOS-held full drops appear as individual rows in the main list ----------
// A full-order drop (allocator tagged every line OutOfStock) never reaches NAV, so it
// is on no NAV board and the aggregate OOS-held pipe was the ONLY place it showed. It
// now rides as its own red line_dropped row so it is findable and counts as stuck.

test('OOS-held: a full drop with no NAV order appears as an individual red line_dropped row', async () => {
  const now = Date.now();
  // computeOrders reads the wall clock internally, so the row is aged against real
  // now; seed first_seen_at 5 days back so the computed age lands near 5 * 86400s.
  const sources = makeSeededSources({
    now,
    orders: [greenDtcOrder('SP-100000-1', now)], // an unrelated healthy NAV order
    oosHeld: [heldRow({ order_id: '7226144522489', order_name: 'SP-323019', first_seen_at: agoIso(5 * 86400, now) })],
  });
  const orders = await computeOrders(sources);
  const dropped = orders.find((o) => o.shopify_order_name === 'SP-323019');
  assert.ok(dropped, 'the dropped order should be its own row');
  assert.equal(dropped.order_verdict, 'red');
  assert.equal(dropped.nav_order_no, null); // never reached NAV
  assert.equal(dropped.shopify_order_id, '7226144522489');
  assert.equal(dropped.handoff?.state, 'line_dropped');
  assert.equal(dropped.handoff?.owner, 'grundens_ops');
  assert.ok(dropped.oldest_stuck_age_s !== null && Math.abs(dropped.oldest_stuck_age_s - 5 * 86400) < 120); // aged from first_seen_at
  // The healthy NAV order is untouched and still present.
  assert.ok(orders.find((o) => o.nav_order_no === 'SP-100000-1'));
});

test('OOS-held: a held row whose order IS in NAV (partial drop) is not double-added', async () => {
  const now = Date.now();
  const sources = makeSeededSources({
    now,
    // greenDtcOrder sets shopifyOrderName '#SP-322673'; the held row carries the same
    // name, so the order is already on the board and must not be appended again.
    orders: [{ ...greenDtcOrder('SP-322673-1', now), shopifyOrderName: 'SP-322673' }],
    oosHeld: [heldRow({ order_id: '7223883268345', order_name: 'SP-322673' })],
  });
  const orders = await computeOrders(sources);
  const rows = orders.filter((o) => o.shopify_order_name === 'SP-322673');
  assert.equal(rows.length, 1, 'the order already in NAV is not duplicated by the held read');
});

test('OOS-held: a resolved held row is not surfaced as a row', async () => {
  const now = Date.now();
  const sources = makeSeededSources({
    now,
    oosHeld: [heldRow({ order_id: '999', order_name: 'SP-000001', status: 'resolved' })],
  });
  const orders = await computeOrders(sources);
  assert.equal(orders.find((o) => o.shopify_order_name === 'SP-000001'), undefined);
});
