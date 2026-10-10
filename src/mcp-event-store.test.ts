import assert from "node:assert/strict";
import test from "node:test";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { BoundedMcpEventStore } from "./mcp-event-store.js";

function resultMessage(id: number): JSONRPCMessage {
  return { jsonrpc: "2.0", id, result: { id } };
}

test("MCP event store replays only later events from the same stream", async () => {
  const store = new BoundedMcpEventStore();
  const first = await store.storeEvent("stream-a", resultMessage(1));
  const second = await store.storeEvent("stream-a", resultMessage(2));
  await store.storeEvent("stream-b", resultMessage(3));
  const fourth = await store.storeEvent("stream-a", resultMessage(4));
  const replayed: Array<{ eventId: string; message: JSONRPCMessage }> = [];

  const streamId = await store.replayEventsAfter(first, {
    send: async (eventId, message) => {
      replayed.push({ eventId, message });
    },
  });

  assert.equal(streamId, "stream-a");
  assert.deepEqual(replayed.map((entry) => entry.eventId), [second, fourth]);
});

test("MCP event store bounds retained events and expires stale replay points", async () => {
  let now = 1_000;
  const store = new BoundedMcpEventStore({
    maxEvents: 2,
    ttlMs: 100,
    now: () => now,
  });

  const first = await store.storeEvent("stream-a", resultMessage(1));
  const second = await store.storeEvent("stream-a", resultMessage(2));
  const third = await store.storeEvent("stream-a", resultMessage(3));

  assert.equal(await store.getStreamIdForEventId(first), undefined);
  assert.equal(await store.getStreamIdForEventId(second), "stream-a");
  assert.equal(await store.getStreamIdForEventId(third), "stream-a");

  now += 101;
  assert.equal(await store.getStreamIdForEventId(second), undefined);
  assert.equal(await store.replayEventsAfter(third, { send: async () => {} }), "");
});
