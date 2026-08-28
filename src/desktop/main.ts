import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray, type OpenDialogOptions } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { access, realpath, stat, truncate } from "node:fs/promises";
import { request } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateOwnerToken,
  loadDevspaceFiles,
  setDevspaceConfigValues,
  writeDevspaceAuth,
} from "../user-config.js";
import { terminateProcessTree } from "../process-platform.js";
import { loadConfig } from "../config.js";
import { SqliteOAuthStore } from "../oauth-store.js";
import { getLocalAgentProviderAvailabilitySnapshot } from "../local-agent-availability.js";
import { buildLocalAgentProviderStatuses } from "../local-agent-catalog.js";
import { LOCAL_AGENT_PROVIDERS } from "../local-agent-profiles.js";
import type {
  DesktopConfigInput,
  DesktopConfigView,
  DesktopProviderInput,
  DesktopDiagnostics,
  DesktopLogCleanup,
  DesktopOwnerPasswordReset,
  DesktopServiceState,
  DesktopSnapshot,
} from "./types.js";

const DESKTOP_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const HEALTH_CHECK_TIMEOUT_MS = 1_500;
const START_TIMEOUT_MS = 30_000;
const EXISTING_SERVICE_GRACE_MS = 3_000;
const STOP_TIMEOUT_MS = 5_000;
// 服务输出仅保留最近 100 行，避免高频健康检查日志长期占用桌面端界面和内存。
const MAX_OUTPUT_LINES = 100;

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let isQuitting = false;
let serverProcess: ChildProcess | undefined;
let serviceState: DesktopServiceState = "stopped";
let lastMessage: string | null = null;
const outputLines: string[] = [];
let stopRequested = false;

type HealthCheckResult =
  | { ok: true; status: "healthy" }
  | {
      ok: false;
      status: "connection_refused" | "timeout" | "http_error" | "invalid_response" | "network_error";
      detail: string;
    };

interface StartupHealthResult {
  healthy: boolean;
  lastHealth: HealthCheckResult;
  processFailure?: string;
}

function projectRoot(): string {
  return app.isPackaged ? app.getAppPath() : resolve(DESKTOP_DIRECTORY, "../..");
}

function desktopHtmlPath(): string {
  return join(DESKTOP_DIRECTORY, "index.html");
}

function preloadPath(): string {
  return join(DESKTOP_DIRECTORY, "preload.cjs");
}

function applicationIconPath(): string {
  return join(projectRoot(), "build", "icon.ico");
}

function applicationIcon() {
  const icon = nativeImage.createFromPath(applicationIconPath());
  return icon.isEmpty() ? nativeImage.createEmpty() : icon;
}

function serverEntryPath(): string {
  return join(projectRoot(), "dist", "cli.js");
}

function bundledNodePath(): string {
  return join(projectRoot(), "dist", "desktop-runtime", process.platform === "win32" ? "node.exe" : "node");
}

async function resolveServerNodeExecutable(): Promise<string> {
  if (process.env.DEVSPACE_NODE_EXECUTABLE) return process.env.DEVSPACE_NODE_EXECUTABLE;

  try {
    await access(bundledNodePath());
    return bundledNodePath();
  } catch {
    if (app.isPackaged) {
      throw new Error("桌面包缺少内置 Node 运行时，请重新执行 npm run desktop:dist。");
    }
    return "node";
  }
}

function normalizePublicBaseUrl(value: unknown): string | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  if (typeof value !== "string") {
    throw new Error("公网基础地址必须是字符串。");
  }

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("公网基础地址必须是有效的 http 或 https URL。");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("公网基础地址仅支持 http 或 https 协议。");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("公网基础地址不能包含查询参数或片段。");
  }

  const normalized = parsed.toString().replace(/\/+$/, "");
  if (new URL(normalized).pathname.replace(/\/+$/, "").endsWith("/mcp")) {
    throw new Error("请输入公网基础地址，不要包含 /mcp 后缀。");
  }

  return normalized;
}

function normalizePort(value: unknown): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("端口必须是 1 到 65535 之间的整数。");
  }
  return port;
}

async function normalizeAllowedRoots(value: unknown): Promise<string[]> {
  if (!Array.isArray(value)) {
    throw new Error("允许访问目录必须是目录列表。");
  }

  const roots: string[] = [];
  const seen = new Set<string>();

  for (const rawRoot of value) {
    if (typeof rawRoot !== "string" || !rawRoot.trim()) continue;

    const candidate = resolve(projectRoot(), rawRoot.trim());
    let resolvedRoot: string;
    try {
      resolvedRoot = await realpath(candidate);
    } catch {
      throw new Error(`允许访问目录不存在：${candidate}`);
    }

    let metadata;
    try {
      metadata = await stat(resolvedRoot);
    } catch {
      throw new Error(`无法读取允许访问目录：${resolvedRoot}`);
    }
    if (!metadata.isDirectory()) {
      throw new Error(`允许访问路径必须是目录：${resolvedRoot}`);
    }

    const key = process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot;
    if (!seen.has(key)) {
      seen.add(key);
      roots.push(resolvedRoot);
    }
  }

  if (roots.length === 0) {
    throw new Error("至少需要配置一个允许访问的项目目录。");
  }

  return roots;
}

function normalizeBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} 必须是布尔值。`);
  return value;
}

function normalizeString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 不能为空。`);
  return value.trim();
}

function normalizeStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是列表。`);
  return Array.from(new Set(value.map((entry) => {
    if (typeof entry !== "string") throw new Error(`${label} 中包含无效值。`);
    return entry.trim();
  }).filter(Boolean)));
}

function normalizeProvider(value: unknown): DesktopProviderInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Subagent Provider 配置无效。");
  }
  const provider = value as Record<string, unknown>;
  const id = provider.id;
  if (typeof id !== "string" || !LOCAL_AGENT_PROVIDERS.includes(id as (typeof LOCAL_AGENT_PROVIDERS)[number])) {
    throw new Error(`不支持的 Subagent Provider：${String(id)}`);
  }
  const model = typeof provider.model === "string" && provider.model.trim() ? provider.model.trim() : undefined;
  const effort = typeof provider.effort === "string" && provider.effort.trim() ? provider.effort.trim() : undefined;
  return {
    id: id as DesktopProviderInput["id"],
    enabled: normalizeBoolean(provider.enabled, `${id} enabled`),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

async function normalizeConfigInput(input: DesktopConfigInput): Promise<DesktopConfigInput> {
  if (input.toolMode !== "codex" && input.toolMode !== "claude") {
    throw new Error("工具模式必须是 codex 或 claude。");
  }
  if (!["silent", "error", "warn", "info", "debug"].includes(input.logging.level)) {
    throw new Error("日志等级无效。");
  }
  if (input.logging.format !== "json" && input.logging.format !== "pretty") {
    throw new Error("日志格式无效。");
  }

  const providers = input.subagents.providers.map(normalizeProvider);
  if (new Set(providers.map((provider) => provider.id)).size !== providers.length) {
    throw new Error("Subagent Provider 不能重复配置。");
  }

  return {
    allowedRoots: await normalizeAllowedRoots(input.allowedRoots),
    port: normalizePort(input.port),
    publicBaseUrl: normalizePublicBaseUrl(input.publicBaseUrl),
    toolMode: input.toolMode,
    uiEnabled: normalizeBoolean(input.uiEnabled, "UI enabled"),
    skills: {
      enabled: normalizeBoolean(input.skills.enabled, "Skills enabled"),
      paths: normalizeStringList(input.skills.paths, "Skills 路径"),
      agentDir: normalizeString(input.skills.agentDir, "Agent 目录"),
    },
    subagents: {
      enabled: normalizeBoolean(input.subagents.enabled, "Subagents enabled"),
      providers,
    },
    logging: {
      level: input.logging.level,
      format: input.logging.format,
      requests: normalizeBoolean(input.logging.requests, "HTTP 请求日志"),
      assets: normalizeBoolean(input.logging.assets, "静态资源日志"),
      toolCalls: normalizeBoolean(input.logging.toolCalls, "Tool 调用日志"),
      shellCommands: normalizeBoolean(input.logging.shellCommands, "Shell 命令日志"),
    },
  };
}

function readConfigView(): DesktopConfigView {
  const files = loadDevspaceFiles();
  const port = normalizePort(files.config.server.port ?? 7676);
  const allowedRoots = Array.isArray(files.config.workspaces.allowedRoots)
    ? files.config.workspaces.allowedRoots.filter((root): root is string => typeof root === "string")
    : [];
  const providerStatuses = buildLocalAgentProviderStatuses(
    files.config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(),
  );

  return {
    allowedRoots,
    port,
    publicBaseUrl: normalizePublicBaseUrl(files.config.server.publicBaseUrl),
    toolMode: files.config.tools.mode,
    uiEnabled: files.config.ui.enabled,
    skills: {
      enabled: files.config.skills.enabled,
      paths: files.config.skills.paths,
      agentDir: files.config.skills.agentDir,
    },
    subagents: {
      enabled: files.config.subagents.enabled,
      providers: providerStatuses.map((provider) => ({
        id: provider.id,
        enabled: provider.enabled,
        available: provider.available,
        usable: provider.usable,
        model: provider.model,
        effort: provider.effort,
        reason: provider.reason,
        note: provider.note,
      })),
    },
    logging: { ...files.config.logging },
    configPath: files.configPath,
    authConfigured: Boolean(files.auth.ownerToken?.trim()),
  };
}

function localUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

function publicUrl(baseUrl: string | null): string | null {
  return baseUrl ? `${baseUrl.replace(/\/+$/, "")}/mcp` : null;
}

function readLogText(entry: Record<string, unknown>, key: string): string | undefined {
  const value = entry[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readLogNumber(entry: Record<string, unknown>, key: string): number | undefined {
  const value = entry[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function logTime(entry: Record<string, unknown>): string {
  const timestamp = readLogText(entry, "ts");
  if (!timestamp) return "--:--:--";

  const date = new Date(timestamp);
  return Number.isNaN(date.valueOf())
    ? timestamp
    : date.toLocaleTimeString("zh-CN", { hour12: false });
}

function formatDesktopLogEntry(source: "stdout" | "stderr", line: string): string | null {
  let entry: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return source === "stderr" ? `[服务错误] ${line}` : null;
    }
    entry = parsed as Record<string, unknown>;
  } catch {
    // 普通 stdout 是启动提示，不属于 ChatGPT 调用记录；stderr 则保留以便排错。
    return source === "stderr" ? `[服务错误] ${line}` : null;
  }

  const event = readLogText(entry, "event");
  const time = logTime(entry);
  if (event === "tool_call") {
    const tool = readLogText(entry, "tool") ?? "未知工具";
    const status = entry.success === true ? "成功" : "失败";
    const parts = [`[${time}] GPT 调用`, tool, status];
    const duration = readLogNumber(entry, "durationMs");
    if (duration !== undefined) parts.push(`${duration} ms`);
    const path = readLogText(entry, "path") ?? readLogText(entry, "workingDirectory");
    if (path) parts.push(path);
    const commandLength = readLogNumber(entry, "commandLength");
    if (commandLength !== undefined) parts.push(`命令 ${commandLength} 字符`);
    const error = readLogText(entry, "error");
    if (error) parts.push(`错误：${error}`);
    return parts.join(" · ");
  }

  if (event === "mcp_session_created") {
    return `[${time}] ChatGPT 已连接 MCP`;
  }
  if (event === "mcp_session_closed") {
    return `[${time}] ChatGPT MCP 会话已关闭`;
  }
  if (event === "auth_denied") {
    return `[${time}] MCP 授权被拒绝：${readLogText(entry, "reason") ?? "未知原因"}`;
  }
  if (event === "mcp_request_error") {
    return `[${time}] MCP 请求失败：${readLogText(entry, "error") ?? "未知错误"}`;
  }

  // HTTP 请求、健康检查和其他底层事件不属于 GPT 工具调用日志。
  return source === "stderr" || entry.level === "error"
    ? `[${time}] 服务错误：${readLogText(entry, "error") ?? event ?? line}`
    : null;
}

function appendOutput(source: "stdout" | "stderr", chunk: Buffer | string): void {
  const lines = String(chunk)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => formatDesktopLogEntry(source, line))
    .filter((line): line is string => line !== null);

  if (lines.length === 0) return;
  outputLines.push(...lines);
  if (outputLines.length > MAX_OUTPUT_LINES) {
    outputLines.splice(0, outputLines.length - MAX_OUTPUT_LINES);
  }
}

async function clearProjectLogFiles(): Promise<{ files: number; bytes: number }> {
  const logFiles = [
    join(projectRoot(), "logs", "devspace.out.log"),
    join(projectRoot(), "logs", "devspace.err.log"),
  ];
  let files = 0;
  let bytes = 0;

  for (const logFile of logFiles) {
    try {
      const metadata = await stat(logFile);
      if (!metadata.isFile() || metadata.size === 0) continue;

      // 仅截断 DevSpace 自己的已知日志文件，保留文件句柄与目录结构，避免影响外部查看日志的脚本。
      await truncate(logFile, 0);
      files += 1;
      bytes += metadata.size;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw new Error(`无法清理日志文件 ${logFile}：${errorMessage(error)}`);
    }
  }

  return { files, bytes };
}

async function clearLogs(): Promise<DesktopLogCleanup> {
  const memoryEntries = outputLines.length;
  outputLines.length = 0;
  const disk = await clearProjectLogFiles();
  lastMessage = "GPT 调用日志已清空。";
  broadcastOutput();

  return {
    memoryEntries,
    diskFiles: disk.files,
    diskBytes: disk.bytes,
    snapshot: await getSnapshot(),
  };
}

function requestHealthDetail(port: number): Promise<HealthCheckResult> {
  return new Promise((resolveHealth) => {
    let settled = false;
    const finish = (result: HealthCheckResult) => {
      if (settled) return;
      settled = true;
      resolveHealth(result);
    };

    const client = request(
      {
        host: "127.0.0.1",
        port,
        path: "/healthz",
        method: "GET",
        timeout: HEALTH_CHECK_TIMEOUT_MS,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          if (response.statusCode !== 200) {
            finish({
              ok: false,
              status: "http_error",
              detail: `HTTP ${response.statusCode ?? "未知"}`,
            });
            return;
          }

          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ok?: unknown; name?: unknown };
            if (body.ok === true && body.name === "devspace") {
              finish({ ok: true, status: "healthy" });
              return;
            }
            finish({
              ok: false,
              status: "invalid_response",
              detail: "返回内容不是 DevSpace 健康检查响应",
            });
          } catch (error) {
            finish({
              ok: false,
              status: "invalid_response",
              detail: `无法解析健康检查响应：${errorMessage(error)}`,
            });
          }
        });
      },
    );

    client.on("timeout", () => {
      client.destroy();
      finish({
        ok: false,
        status: "timeout",
        detail: `${HEALTH_CHECK_TIMEOUT_MS} ms 内未收到响应`,
      });
    });
    client.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") {
        finish({
          ok: false,
          status: "connection_refused",
          detail: "端口当前没有服务监听",
        });
        return;
      }
      finish({
        ok: false,
        status: "network_error",
        detail: error.code ? `${error.code}: ${error.message}` : error.message,
      });
    });
    client.end();
  });
}

async function requestHealth(port: number): Promise<boolean> {
  return (await requestHealthDetail(port)).ok;
}

function healthCheckDescription(result: HealthCheckResult): string {
  if (result.ok) return "健康检查已通过";
  switch (result.status) {
    case "connection_refused":
      return "端口未监听";
    case "timeout":
      return `健康检查超时（${result.detail}）`;
    case "http_error":
      return `健康检查返回异常状态（${result.detail}）`;
    case "invalid_response":
      return `健康检查响应无效（${result.detail}）`;
    case "network_error":
      return `健康检查网络异常（${result.detail}）`;
  }
}

async function stabilizeExistingServiceHealth(port: number): Promise<HealthCheckResult> {
  let health = await requestHealthDetail(port);
  if (health.ok || health.status === "connection_refused") return health;

  // 端口已有监听但 DevSpace 暂时没有及时响应时，给旧实例一个短暂恢复窗口，避免直接再启动第二个服务争抢端口。
  const deadline = Date.now() + EXISTING_SERVICE_GRACE_MS;
  while (Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    health = await requestHealthDetail(port);
    if (health.ok || health.status === "connection_refused") return health;
  }
  return health;
}

function summarizeStartupStderr(stderr: string): string | null {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  // 优先展示最可能直接指向根因的错误行，避免把完整 Node 堆栈塞进状态提示。
  const preferred = lines.find((line) => /EADDRINUSE|better-sqlite3|Unable to read|owner token|Error:/i.test(line))
    ?? lines[0];
  return preferred.length > 500 ? `${preferred.slice(0, 497)}...` : preferred;
}

async function getSnapshot(): Promise<DesktopSnapshot> {
  let config: DesktopConfigView;
  try {
    config = readConfigView();
  } catch (error) {
    return {
      state: "error",
      managedByDesktop: Boolean(serverProcess),
      pid: serverProcess?.pid,
      localUrl: "",
      publicUrl: null,
      config: {
        allowedRoots: [],
        port: 7676,
        publicBaseUrl: null,
        toolMode: "codex",
        uiEnabled: true,
        skills: { enabled: true, paths: [], agentDir: "~/.codex" },
        subagents: {
          enabled: false,
          providers: LOCAL_AGENT_PROVIDERS.map((id) => ({
            id,
            enabled: false,
            available: false,
            usable: false,
            reason: "配置读取失败",
          })),
        },
        logging: {
          level: "info",
          format: "json",
          requests: true,
          assets: false,
          toolCalls: true,
          shellCommands: false,
        },
        configPath: "",
        authConfigured: false,
      },
      message: errorMessage(error),
      output: [...outputLines],
    };
  }

  const healthy = await requestHealth(config.port);
  const state: DesktopServiceState = serverProcess
    ? healthy
      ? "running"
      : "starting"
    : healthy
      ? "running"
      : serviceState;

  return {
    state,
    managedByDesktop: Boolean(serverProcess),
    pid: serverProcess?.pid,
    localUrl: localUrl(config.port),
    publicUrl: publicUrl(config.publicBaseUrl),
    config,
    message: lastMessage,
    output: [...outputLines],
  };
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function hideMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
}

function runTrayAction(action: () => Promise<unknown>): void {
  void action().catch((error) => {
    lastMessage = errorMessage(error);
    serviceState = "error";
    broadcastStatus();
  });
}

function updateTrayMenu(snapshot?: DesktopSnapshot): void {
  if (!tray) return;

  const state = snapshot?.state ?? serviceState;
  const managedByDesktop = snapshot?.managedByDesktop ?? Boolean(serverProcess);
  const stateLabel = state === "running" ? "正在运行" : state === "starting" ? "正在启动" : state === "error" ? "需要处理" : "已停止";
  tray.setToolTip(`DevSpace Desktop · ${stateLabel}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示 DevSpace Desktop", click: showMainWindow },
    { type: "separator" },
    {
      label: "启动 DevSpace",
      enabled: state !== "running" && state !== "starting",
      click: () => runTrayAction(startService),
    },
    {
      label: "停止 DevSpace",
      enabled: managedByDesktop && state !== "stopped",
      click: () => runTrayAction(stopService),
    },
    { type: "separator" },
    {
      label: "退出 DevSpace Desktop",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
}

function createTray(): void {
  if (tray) return;

  tray = new Tray(applicationIcon());
  tray.on("click", showMainWindow);
  tray.on("double-click", showMainWindow);
  updateTrayMenu();
}

function broadcastOutput(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("desktop:output", [...outputLines]);
}

function broadcastStatus(): void {
  void getSnapshot().then((snapshot) => {
    updateTrayMenu(snapshot);
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("desktop:status", snapshot);
  });
}

async function waitForStartupHealth(
  port: number,
  timeoutMs: number,
  processFailure: () => string | null,
): Promise<StartupHealthResult> {
  const deadline = Date.now() + timeoutMs;
  let lastHealth = await requestHealthDetail(port);
  while (Date.now() < deadline) {
    if (lastHealth.ok) return { healthy: true, lastHealth };
    const failure = processFailure();
    if (failure) return { healthy: false, lastHealth, processFailure: failure };
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    lastHealth = await requestHealthDetail(port);
  }
  const failure = processFailure();
  return {
    healthy: false,
    lastHealth,
    ...(failure ? { processFailure: failure } : {}),
  };
}

async function assertServerBuild(): Promise<void> {
  try {
    await access(serverEntryPath());
  } catch {
    throw new Error("找不到已构建的 DevSpace 服务。请先执行 npm run build 或重新安装桌面版。");
  }
}

function serverEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

async function startService(): Promise<DesktopSnapshot> {
  const config = readConfigView();
  if (!config.authConfigured || config.allowedRoots.length === 0) {
    throw new Error("请先保存至少一个允许访问的项目目录，以生成完整的 DevSpace 配置。");
  }
  const existingHealth = await stabilizeExistingServiceHealth(config.port);
  if (existingHealth.ok) {
    serviceState = "running";
    lastMessage = serverProcess
      ? "DevSpace 已由桌面端启动并正在运行。"
      : "检测到已有 DevSpace 服务正在运行；桌面端不会接管或停止外部进程。";
    broadcastStatus();
    return getSnapshot();
  }
  if (serverProcess) {
    lastMessage = "DevSpace 正在启动，请稍后重试。";
    return getSnapshot();
  }
  if (existingHealth.status !== "connection_refused") {
    serviceState = "error";
    lastMessage = `端口 ${config.port} 已有进程监听，但没有得到有效的 DevSpace 响应：${healthCheckDescription(existingHealth)}。请退出旧版 DevSpace Desktop、停止占用该端口的进程，或更换端口后重试。`;
    broadcastStatus();
    throw new Error(lastMessage);
  }

  await assertServerBuild();
  serviceState = "starting";
  lastMessage = "正在启动 DevSpace 服务…";
  outputLines.length = 0;
  stopRequested = false;
  broadcastStatus();

  const nodeExecutable = await resolveServerNodeExecutable();
  const child = spawn(nodeExecutable, [serverEntryPath(), "serve"], {
    cwd: projectRoot(),
    env: serverEnvironment(),
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  serverProcess = child;
  let startupFailure: string | null = null;
  let startupStderr = "";

  child.stdout?.on("data", (chunk: Buffer) => {
    appendOutput("stdout", chunk);
    broadcastOutput();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    startupStderr = `${startupStderr}${String(chunk)}`.slice(-8_000);
    appendOutput("stderr", chunk);
    broadcastOutput();
  });
  child.on("error", (error) => {
    appendOutput("stderr", error.message);
    startupFailure = `无法启动 DevSpace：${error.message}`;
    lastMessage = startupFailure;
    serviceState = "error";
    serverProcess = undefined;
    broadcastStatus();
  });
  child.on("exit", (code, signal) => {
    if (serverProcess === child) {
      serverProcess = undefined;
    }
    if (stopRequested) {
      serviceState = "stopped";
      lastMessage = "DevSpace 已停止。";
    } else if (code === 0) {
      serviceState = "stopped";
      lastMessage = "DevSpace 已退出。";
      startupFailure ??= "DevSpace 在完成启动前已退出。";
    } else {
      serviceState = "error";
      const detail = summarizeStartupStderr(startupStderr);
      startupFailure ??= `DevSpace 启动进程已退出（代码 ${code ?? "未知"}${signal ? `，信号 ${signal}` : ""}）${detail ? `：${detail}` : "。"}`;
      lastMessage = startupFailure;
    }
    broadcastStatus();
  });

  const started = await waitForStartupHealth(config.port, START_TIMEOUT_MS, () => startupFailure);
  if (!started.healthy) {
    if (started.processFailure) {
      serviceState = "error";
      lastMessage = started.processFailure;
      broadcastStatus();
      throw new Error(lastMessage);
    }
    if (serverProcess === child) {
      stopRequested = true;
      terminateProcessTree(child, "SIGTERM", process.platform !== "win32");
      await waitForProcessExit(child);
      serverProcess = undefined;
      stopRequested = false;
    }
    serviceState = "error";
    lastMessage = `DevSpace 未能在 ${Math.round(START_TIMEOUT_MS / 1_000)} 秒内通过健康检查。最后状态：${healthCheckDescription(started.lastHealth)}。启动进程已停止，请查看服务输出和运行环境诊断。`;
    broadcastStatus();
    throw new Error(lastMessage);
  }

  serviceState = "running";
  lastMessage = "DevSpace 已启动。";
  broadcastStatus();
  return getSnapshot();
}

async function waitForProcessExit(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit();
      return;
    }

    const timeout = setTimeout(resolveExit, STOP_TIMEOUT_MS);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}

async function stopService(): Promise<DesktopSnapshot> {
  const child = serverProcess;
  if (!child) {
    const snapshot = await getSnapshot();
    if (snapshot.state === "running") {
      throw new Error("当前服务不是由桌面端启动，无法安全停止。请在原启动终端中停止该进程。");
    }
    serviceState = "stopped";
    lastMessage = "DevSpace 当前未运行。";
    broadcastStatus();
    return getSnapshot();
  }

  stopRequested = true;
  serviceState = "starting";
  lastMessage = "正在停止 DevSpace 服务…";
  broadcastStatus();
  terminateProcessTree(child, "SIGTERM", process.platform !== "win32");
  await waitForProcessExit(child);

  if (serverProcess === child) {
    serverProcess = undefined;
    serviceState = "stopped";
    lastMessage = "DevSpace 已停止。";
  }
  broadcastStatus();
  return getSnapshot();
}

async function saveConfig(input: DesktopConfigInput): Promise<DesktopSnapshot> {
  const normalized = await normalizeConfigInput(input);
  const currentConfig = readConfigView();
  const files = loadDevspaceFiles();
  const wasManagedRunning = Boolean(serverProcess) && await requestHealth(currentConfig.port);
  const reconnectRequired = currentConfig.toolMode !== normalized.toolMode;

  // 使用 JSONC 的定点编辑接口，只修改桌面配置中心负责的字段，保留用户注释和未来新增配置。
  setDevspaceConfigValues([
    { path: ["server", "host"], value: "127.0.0.1" },
    { path: ["server", "port"], value: normalized.port },
    { path: ["server", "publicBaseUrl"], value: normalized.publicBaseUrl },
    { path: ["workspaces", "allowedRoots"], value: normalized.allowedRoots },
    { path: ["tools", "mode"], value: normalized.toolMode },
    { path: ["ui", "enabled"], value: normalized.uiEnabled },
    { path: ["skills", "enabled"], value: normalized.skills.enabled },
    { path: ["skills", "paths"], value: normalized.skills.paths },
    { path: ["skills", "agentDir"], value: normalized.skills.agentDir },
    { path: ["subagents"], value: normalized.subagents },
    { path: ["logging", "level"], value: normalized.logging.level },
    { path: ["logging", "format"], value: normalized.logging.format },
    { path: ["logging", "requests"], value: normalized.logging.requests },
    { path: ["logging", "assets"], value: normalized.logging.assets },
    { path: ["logging", "toolCalls"], value: normalized.logging.toolCalls },
    { path: ["logging", "shellCommands"], value: normalized.logging.shellCommands },
  ]);

  if (!files.auth.ownerToken?.trim()) {
    writeDevspaceAuth({ ownerToken: generateOwnerToken() });
  }

  lastMessage = wasManagedRunning
    ? "配置已保存，正在重启由桌面端管理的服务以应用新配置。"
    : reconnectRequired
      ? "配置已保存。工具模式已变化，请在 ChatGPT 中断开并重新连接 DevSpace MCP。"
      : "配置已保存。";
  broadcastStatus();

  if (wasManagedRunning) {
    await stopService();
    const restarted = await startService();
    if (reconnectRequired) {
      lastMessage = "配置已应用并完成服务重启。工具模式已变化，请在 ChatGPT 中断开并重新连接 DevSpace MCP。";
      broadcastStatus();
      return getSnapshot();
    }
    return restarted;
  }

  const snapshot = await getSnapshot();
  if (snapshot.state === "running" && !snapshot.managedByDesktop) {
    lastMessage = reconnectRequired
      ? "配置已保存；当前是外部启动的服务，请重启该服务，并在 ChatGPT 中重新连接 DevSpace MCP。"
      : "配置已保存；当前检测到外部启动的服务，重启该服务后配置才会生效。";
  }
  broadcastStatus();
  return getSnapshot();
}

async function resetOwnerPassword(): Promise<DesktopOwnerPasswordReset> {
  if (process.env.DEVSPACE_OAUTH_OWNER_TOKEN?.trim()) {
    throw new Error("当前 Owner password 由 DEVSPACE_OAUTH_OWNER_TOKEN 环境变量覆盖，请在该环境变量中重置。");
  }

  const files = loadDevspaceFiles();
  if (!files.auth.ownerToken?.trim()) {
    throw new Error("尚未创建 Owner password。请先保存服务配置。");
  }

  const stateDir = loadConfig().stateDir;
  const oauthStore = new SqliteOAuthStore(stateDir);
  try {
    oauthStore.revokeAllTokens();
  } finally {
    oauthStore.close();
  }

  const ownerToken = generateOwnerToken();
  writeDevspaceAuth({ ...files.auth, ownerToken });
  const restartManagedService = Boolean(serverProcess);
  let restartRequired = false;
  lastMessage = "Owner password 已重置，所有已授权客户端都需要重新登录。";

  if (restartManagedService) {
    await stopService();
    try {
      await startService();
      lastMessage = "Owner password 已重置，已撤销旧 OAuth 会话并自动重启 DevSpace。";
    } catch (error) {
      restartRequired = true;
      lastMessage = `Owner password 已重置且旧 OAuth 会话已撤销，但 DevSpace 自动重启失败：${errorMessage(error)}`;
    }
  } else if (await requestHealth(readConfigView().port)) {
    restartRequired = true;
    lastMessage = "Owner password 已重置，旧 OAuth 会话已撤销；检测到外部启动的 DevSpace，请在原终端手动重启以加载新密码。";
  }

  const snapshot = await getSnapshot();
  broadcastStatus();
  return { ownerToken, restartRequired, snapshot };
}

async function chooseDirectory(): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: "选择允许 ChatGPT 访问的项目目录",
    properties: ["openDirectory", "createDirectory"],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : result.filePaths[0] ?? null;
}

function collectCommandOutput(command: string, args: string[]): Promise<DesktopDiagnostics> {
  return new Promise((resolveResult) => {
    let settled = false;
    const finish = (result: DesktopDiagnostics) => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };
    const child = spawn(command, args, {
      cwd: projectRoot(),
      env: serverEnvironment(),
      windowsHide: true,
    });
    const lines: string[] = [];

    child.stdout?.on("data", (chunk: Buffer) => lines.push(String(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => lines.push(String(chunk)));
    child.on("error", (error) => {
      finish({ ok: false, output: `无法运行环境诊断：${error.message}` });
    });
    child.on("exit", (code) => {
      finish({
        ok: code === 0,
        output: lines.join("").trim() || (code === 0 ? "诊断完成，没有额外输出。" : `诊断命令退出，代码 ${code ?? "未知"}。`),
      });
    });
  });
}

async function runDiagnostics(): Promise<DesktopDiagnostics> {
  await assertServerBuild();
  const nodeExecutable = await resolveServerNodeExecutable();
  return collectCommandOutput(nodeExecutable, [serverEntryPath(), "doctor"]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1_160,
    height: 820,
    minWidth: 920,
    minHeight: 680,
    title: "DevSpace Desktop",
    icon: applicationIcon(),
    backgroundColor: "#0b1220",
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on("minimize", () => {
    hideMainWindow();
  });
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    hideMainWindow();
  });

  mainWindow.webContents.once("did-finish-load", () => {
    // 仅在显式测试环境中自动退出，方便校验桌面入口而不启动 MCP 服务。
    if (process.env.DEVSPACE_DESKTOP_SMOKE_TEST === "1") {
      isQuitting = true;
      app.quit();
    }
  });
  void mainWindow.loadFile(desktopHtmlPath());
}

function registerIpcHandlers(): void {
  ipcMain.handle("desktop:get-snapshot", () => getSnapshot());
  ipcMain.handle("desktop:start-service", () => startService());
  ipcMain.handle("desktop:stop-service", () => stopService());
  ipcMain.handle("desktop:save-config", (_event, input: DesktopConfigInput) => saveConfig(input));
  ipcMain.handle("desktop:reset-owner-password", () => resetOwnerPassword());
  ipcMain.handle("desktop:clear-logs", () => clearLogs());
  ipcMain.handle("desktop:choose-directory", () => chooseDirectory());
  ipcMain.handle("desktop:run-diagnostics", () => runDiagnostics());
  ipcMain.handle("desktop:open-config-directory", async () => {
    const config = readConfigView();
    const opened = await shell.openPath(dirname(config.configPath));
    if (opened) throw new Error(`无法打开配置目录：${opened}`);
  });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  // 同一用户下已有 DevSpace Desktop 时直接退出新实例，避免多个桌面进程争抢同一个 MCP 端口。
  isQuitting = true;
  app.quit();
} else {
  app.on("second-instance", () => {
    if (app.isReady()) {
      showMainWindow();
      return;
    }
    app.once("ready", showMainWindow);
  });

  app.whenReady().then(() => {
    // Windows 默认菜单栏对桌面控制台没有可用操作，统一移除以避免占用界面空间。
    Menu.setApplicationMenu(null);
    registerIpcHandlers();
    createTray();
    createWindow();

    app.on("activate", showMainWindow);
  });

  app.on("before-quit", () => {
    isQuitting = true;
    tray?.destroy();
    tray = undefined;
    if (serverProcess) {
      stopRequested = true;
      terminateProcessTree(serverProcess, "SIGTERM", process.platform !== "win32");
    }
  });
}
