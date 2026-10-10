import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDiagnosticLogger, type LoggingConfig } from "./logger.js";

const logging: LoggingConfig = {
  level: "warn",
  format: "json",
  requests: true,
  assets: false,
  toolCalls: true,
  shellCommands: false,
  trustProxy: false,
};

test("diagnostic logger persists enabled warning and error events as JSON lines", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-diagnostic-log-test-"));
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = () => {};
  console.error = () => {};
  t.after(async () => {
    console.warn = originalWarn;
    console.error = originalError;
    await rm(stateDir, { recursive: true, force: true });
  });

  const logger = createDiagnosticLogger(logging, stateDir);
  logger.log("info", "ignored_info");
  logger.log("warn", "mcp_http_stream_disconnected", { requestId: "request-1" });
  logger.log("error", "mcp_transport_error", { error: "connection reset" });
  await logger.flush();

  const entries = (await readFile(logger.filePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  assert.deepEqual(entries.map((entry) => entry.event), [
    "mcp_http_stream_disconnected",
    "mcp_transport_error",
  ]);
  assert.equal(entries[0]?.requestId, "request-1");
  assert.equal(entries[1]?.error, "connection reset");
});
