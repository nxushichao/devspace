import { randomUUID } from "node:crypto";
import type { EventStore } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

interface StoredMcpEvent {
  streamId: string;
  message: JSONRPCMessage;
  storedAt: number;
}

export interface BoundedMcpEventStoreOptions {
  maxEvents?: number;
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_EVENTS = 2_000;
const DEFAULT_TTL_MS = 30 * 60 * 1_000;

/**
 * 为 Streamable HTTP 提供进程内的短时事件重放能力。
 * 这里刻意限制数量和保留时间，避免断开的 MCP 会话长期占用内存。
 */
export class BoundedMcpEventStore implements EventStore {
  private readonly events = new Map<string, StoredMcpEvent>();
  private readonly maxEvents: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: BoundedMcpEventStoreOptions = {}) {
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;

    if (!Number.isInteger(this.maxEvents) || this.maxEvents < 1) {
      throw new Error("MCP event store maxEvents must be a positive integer.");
    }
    if (!Number.isFinite(this.ttlMs) || this.ttlMs < 1) {
      throw new Error("MCP event store ttlMs must be a positive number.");
    }
  }

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const now = this.now();
    this.prune(now);

    while (this.events.size >= this.maxEvents) {
      const oldestEventId = this.events.keys().next().value as string | undefined;
      if (!oldestEventId) break;
      this.events.delete(oldestEventId);
    }

    const eventId = randomUUID();
    this.events.set(eventId, { streamId, message, storedAt: now });
    return eventId;
  }

  async getStreamIdForEventId(eventId: string): Promise<string | undefined> {
    this.prune(this.now());
    return this.events.get(eventId)?.streamId;
  }

  async replayEventsAfter(
    lastEventId: string,
    { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> },
  ): Promise<string> {
    this.prune(this.now());
    const lastEvent = this.events.get(lastEventId);
    if (!lastEvent) return "";

    let foundLastEvent = false;
    for (const [eventId, event] of this.events) {
      if (event.streamId !== lastEvent.streamId) continue;
      if (eventId === lastEventId) {
        foundLastEvent = true;
        continue;
      }
      if (foundLastEvent) {
        await send(eventId, event.message);
      }
    }
    return lastEvent.streamId;
  }

  private prune(now: number): void {
    const cutoff = now - this.ttlMs;
    for (const [eventId, event] of this.events) {
      // Map 保持插入顺序；遇到仍有效的事件后，后续事件也都是新的。
      if (event.storedAt >= cutoff) break;
      this.events.delete(eventId);
    }
  }
}
