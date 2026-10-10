import type { Request } from "express";
import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";
export type LogFormat = "json" | "pretty";

export interface LoggingConfig {
  level: LogLevel;
  format: LogFormat;
  requests: boolean;
  assets: boolean;
  toolCalls: boolean;
  shellCommands: boolean;
  trustProxy: boolean;
}

type LogFields = Record<string, unknown>;

export interface DiagnosticLogger {
  filePath: string;
  log(
    level: Exclude<LogLevel, "silent">,
    event: string,
    fields?: LogFields,
  ): void;
  flush(): Promise<void>;
}

const MAX_DIAGNOSTIC_LOG_BYTES = 5 * 1024 * 1024;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export function shouldLog(config: LoggingConfig, level: Exclude<LogLevel, "silent">): boolean {
  return LEVEL_WEIGHT[config.level] >= LEVEL_WEIGHT[level];
}

export function logEvent(
  config: LoggingConfig,
  level: Exclude<LogLevel, "silent">,
  event: string,
  fields: LogFields = {},
): void {
  if (!shouldLog(config, level)) return;

  const entry = buildLogEntry(level, event, fields);
  writeConsoleEntry(config, level, entry);
}

export function createDiagnosticLogger(
  config: LoggingConfig,
  stateDir: string,
): DiagnosticLogger {
  const filePath = join(stateDir, "logs", "devspace-diagnostics.log");
  let writeQueue = Promise.resolve();

  return {
    filePath,
    log(level, event, fields = {}) {
      if (!shouldLog(config, level)) return;

      const entry = buildLogEntry(level, event, fields);
      writeConsoleEntry(config, level, entry);
      const line = `${JSON.stringify(entry)}\n`;

      // 文件写入串行化，避免并发 rotate/append 导致 Windows 下文件竞争或日志乱序。
      writeQueue = writeQueue
        .then(() => appendDiagnosticLine(filePath, line))
        .catch((error) => {
          console.error(JSON.stringify({
            ts: new Date().toISOString(),
            level: "error",
            event: "diagnostic_log_write_failed",
            filePath,
            error: error instanceof Error ? error.message : String(error),
          }));
        });
    },
    async flush() {
      await writeQueue;
    },
  };
}

function buildLogEntry(
  level: Exclude<LogLevel, "silent">,
  event: string,
  fields: LogFields,
): LogFields {
  return {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
}

function writeConsoleEntry(
  config: LoggingConfig,
  level: Exclude<LogLevel, "silent">,
  entry: LogFields,
): void {
  const line = config.format === "pretty" ? formatPretty(entry) : JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

async function appendDiagnosticLine(filePath: string, line: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });

  try {
    const metadata = await stat(filePath);
    if (metadata.size + Buffer.byteLength(line) > MAX_DIAGNOSTIC_LOG_BYTES) {
      const backupPath = `${filePath}.1`;
      await rm(backupPath, { force: true });
      await rename(filePath, backupPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await appendFile(filePath, line, { encoding: "utf8", mode: 0o600 });
}

export function requestIp(req: Request): string | undefined {
  // 客户端 IP 统一交给 Express 的 trust proxy 规则解析，避免日志层和限流层各自信任不同的转发头。
  return req.ip ?? req.socket.remoteAddress;
}

export function requestPath(req: Request): string {
  return req.path || req.url.split("?")[0] || req.url;
}

export function sessionIdPrefix(sessionId: string | undefined): string | undefined {
  return sessionId ? sessionId.slice(0, 8) : undefined;
}

export function commandPreview(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function formatPretty(entry: LogFields): string {
  const ts = String(entry.ts);
  const level = String(entry.level).toUpperCase();
  const event = String(entry.event);
  const rest = Object.entries(entry)
    .filter(([key, value]) => !["ts", "level", "event"].includes(key) && value !== undefined)
    .map(([key, value]) => `${key}=${formatPrettyValue(value)}`)
    .join(" ");

  return rest ? `${ts} ${level} ${event} ${rest}` : `${ts} ${level} ${event}`;
}

function formatPrettyValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}
