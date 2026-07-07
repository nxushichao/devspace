import type { DesktopApi, DesktopConfigInput, DesktopSnapshot } from "./types.js";

declare global {
  interface Window {
    devspaceDesktop: DesktopApi;
  }
}

const statusBadge = requiredElement<HTMLSpanElement>("status-badge");
const statusTitle = requiredElement<HTMLElement>("status-title");
const statusDescription = requiredElement<HTMLElement>("status-description");
const endpointValue = requiredElement<HTMLElement>("endpoint-value");
const processValue = requiredElement<HTMLElement>("process-value");
const publicEndpointValue = requiredElement<HTMLElement>("public-endpoint-value");
const startButton = requiredElement<HTMLButtonElement>("start-button");
const stopButton = requiredElement<HTMLButtonElement>("stop-button");
const saveButton = requiredElement<HTMLButtonElement>("save-button");
const resetOwnerPasswordButton = requiredElement<HTMLButtonElement>("reset-owner-password-button");
const hideOwnerPasswordButton = requiredElement<HTMLButtonElement>("hide-owner-password-button");
const clearLogsButton = requiredElement<HTMLButtonElement>("clear-logs-button");
const diagnosticsButton = requiredElement<HTMLButtonElement>("diagnostics-button");
const openConfigButton = requiredElement<HTMLButtonElement>("open-config-button");
const rootList = requiredElement<HTMLElement>("root-list");
const addRootButton = requiredElement<HTMLButtonElement>("add-root-button");
const portInput = requiredElement<HTMLInputElement>("port-input");
const publicBaseUrlInput = requiredElement<HTMLInputElement>("public-base-url-input");
const configPathValue = requiredElement<HTMLElement>("config-path-value");
const authValue = requiredElement<HTMLElement>("auth-value");
const ownerPasswordResult = requiredElement<HTMLElement>("owner-password-result");
const ownerPasswordValue = requiredElement<HTMLElement>("owner-password-value");
const logOutput = requiredElement<HTMLPreElement>("log-output");
const diagnosticOutput = requiredElement<HTMLPreElement>("diagnostic-output");
const notice = requiredElement<HTMLElement>("notice");

let currentSnapshot: DesktopSnapshot | null = null;
let busy = false;
let initialized = false;

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing desktop control: ${id}`);
  return element as T;
}

function stateText(snapshot: DesktopSnapshot): string {
  if (snapshot.state === "running") {
    return snapshot.managedByDesktop ? "正在运行" : "外部服务正在运行";
  }
  if (snapshot.state === "starting") return "正在启动";
  if (snapshot.state === "error") return "需要处理";
  return "已停止";
}

function stateDescription(snapshot: DesktopSnapshot): string {
  if (snapshot.message) return snapshot.message;
  if (snapshot.state === "running") {
    return snapshot.managedByDesktop
      ? "桌面端正在管理 DevSpace 服务。"
      : "端口上已有 DevSpace 服务；桌面端不会接管该进程。";
  }
  if (snapshot.state === "starting") return "DevSpace 正在初始化，请稍候。";
  if (snapshot.state === "error") return "请检查配置、运行环境和服务输出。";
  return "配置完成后，可直接从这里启动 MCP 服务。";
}

function updateStateClass(snapshot: DesktopSnapshot): void {
  statusBadge.classList.remove("running", "stopped", "starting", "error");
  statusBadge.classList.add(snapshot.state);
}

function setBusy(nextBusy: boolean): void {
  busy = nextBusy;
  const snapshot = currentSnapshot;
  const running = snapshot?.state === "running";
  const ownsRunningProcess = running && snapshot?.managedByDesktop;

  startButton.disabled = nextBusy || running || snapshot?.state === "starting";
  stopButton.disabled = nextBusy || !ownsRunningProcess;
  saveButton.disabled = nextBusy;
  resetOwnerPasswordButton.disabled = nextBusy || !snapshot?.config.authConfigured;
  hideOwnerPasswordButton.disabled = nextBusy;
  clearLogsButton.disabled = nextBusy;
  diagnosticsButton.disabled = nextBusy;
  openConfigButton.disabled = nextBusy;
  addRootButton.disabled = nextBusy;
  rootList.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach((element) => {
    element.disabled = nextBusy;
  });
}

function showNotice(message: string, kind: "success" | "error" | "info" = "info"): void {
  notice.textContent = message;
  notice.className = `notice ${kind}`;
  notice.hidden = false;
}

function hideNotice(): void {
  notice.hidden = true;
  notice.textContent = "";
  notice.className = "notice";
}

function hideOwnerPassword(): void {
  ownerPasswordValue.textContent = "";
  ownerPasswordResult.hidden = true;
}

function showOwnerPassword(ownerToken: string): void {
  ownerPasswordValue.textContent = ownerToken;
  ownerPasswordResult.hidden = false;
}

function createRootRow(value = ""): HTMLElement {
  const row = document.createElement("div");
  row.className = "root-row";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "root-input";
  input.value = value;
  input.placeholder = "例如 E:\\code\\my-projects";
  input.setAttribute("aria-label", "允许访问的项目目录");

  const browseButton = document.createElement("button");
  browseButton.type = "button";
  browseButton.className = "secondary compact";
  browseButton.textContent = "选择";
  browseButton.addEventListener("click", async () => {
    try {
      const selected = await window.devspaceDesktop.chooseDirectory();
      if (selected) input.value = selected;
    } catch (error) {
      showNotice(errorMessage(error), "error");
    }
  });

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "icon-button";
  removeButton.textContent = "×";
  removeButton.title = "移除此目录";
  removeButton.setAttribute("aria-label", "移除此目录");
  removeButton.addEventListener("click", () => {
    const rows = rootList.querySelectorAll(".root-row");
    if (rows.length === 1) {
      input.value = "";
      return;
    }
    row.remove();
  });

  row.append(input, browseButton, removeButton);
  return row;
}

function renderRoots(roots: string[]): void {
  rootList.replaceChildren();
  const values = roots.length > 0 ? roots : [""];
  values.forEach((root) => rootList.append(createRootRow(root)));
}

function readConfigInput(): DesktopConfigInput {
  const allowedRoots = Array.from(rootList.querySelectorAll<HTMLInputElement>(".root-input"))
    .map((input) => input.value.trim())
    .filter(Boolean);
  const port = Number(portInput.value);
  const publicBaseUrl = publicBaseUrlInput.value.trim() || null;

  return { allowedRoots, port, publicBaseUrl };
}

function renderOutput(output: string[]): void {
  logOutput.textContent = output.length > 0
    ? output.join("\n")
    : "等待 ChatGPT 通过 MCP 调用 DevSpace 工具…";
}

function renderSnapshot(snapshot: DesktopSnapshot, options: { preserveForm?: boolean } = {}): void {
  currentSnapshot = snapshot;
  const preserveForm = options.preserveForm ?? initialized;

  statusBadge.textContent = stateText(snapshot);
  statusTitle.textContent = stateText(snapshot);
  statusDescription.textContent = stateDescription(snapshot);
  updateStateClass(snapshot);

  endpointValue.textContent = snapshot.localUrl || "配置读取失败";
  publicEndpointValue.textContent = snapshot.publicUrl ?? "未配置公网地址";
  processValue.textContent = snapshot.pid
    ? `${snapshot.managedByDesktop ? "桌面端进程" : "外部进程"} · PID ${snapshot.pid}`
    : snapshot.managedByDesktop
      ? "桌面端正在初始化进程"
      : "未由桌面端管理";

  configPathValue.textContent = snapshot.config.configPath || "无法读取配置路径";
  authValue.textContent = snapshot.config.authConfigured ? "已配置（不会在界面中显示密码）" : "尚未创建；保存配置时将自动生成";

  if (!preserveForm) {
    renderRoots(snapshot.config.allowedRoots);
    portInput.value = String(snapshot.config.port);
    publicBaseUrlInput.value = snapshot.config.publicBaseUrl ?? "";
    initialized = true;
  }

  renderOutput(snapshot.output);

  setBusy(busy);
}

async function withBusy(action: () => Promise<void>): Promise<void> {
  if (busy) return;
  hideNotice();
  setBusy(true);
  try {
    await action();
  } catch (error) {
    showNotice(errorMessage(error), "error");
  } finally {
    setBusy(false);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function refresh(options: { preserveForm?: boolean } = {}): Promise<void> {
  const snapshot = await window.devspaceDesktop.getSnapshot();
  renderSnapshot(snapshot, options);
}

startButton.addEventListener("click", () => withBusy(async () => {
  const snapshot = await window.devspaceDesktop.startService();
  renderSnapshot(snapshot, { preserveForm: true });
  showNotice("DevSpace 已启动。", "success");
}));

stopButton.addEventListener("click", () => withBusy(async () => {
  const snapshot = await window.devspaceDesktop.stopService();
  renderSnapshot(snapshot, { preserveForm: true });
  showNotice("DevSpace 已停止。", "success");
}));

saveButton.addEventListener("click", () => withBusy(async () => {
  const input = readConfigInput();
  const snapshot = await window.devspaceDesktop.saveConfig(input);
  renderSnapshot(snapshot, { preserveForm: false });
  showNotice("配置已保存。", "success");
}));

diagnosticsButton.addEventListener("click", () => withBusy(async () => {
  diagnosticOutput.textContent = "正在运行环境诊断…";
  const diagnostics = await window.devspaceDesktop.runDiagnostics();
  diagnosticOutput.textContent = diagnostics.output;
  showNotice(diagnostics.ok ? "环境诊断通过。" : "环境诊断发现问题，请查看输出。", diagnostics.ok ? "success" : "error");
}));

openConfigButton.addEventListener("click", () => withBusy(async () => {
  await window.devspaceDesktop.openConfigDirectory();
}));

resetOwnerPasswordButton.addEventListener("click", () => {
  const confirmed = window.confirm(
    "重置后，所有已授权的 ChatGPT 或其他 MCP 客户端都需要重新登录。新密码仅显示一次，是否继续？",
  );
  if (!confirmed) return;

  void withBusy(async () => {
    hideOwnerPassword();
    const result = await window.devspaceDesktop.resetOwnerPassword();
    renderSnapshot(result.snapshot, { preserveForm: true });
    showOwnerPassword(result.ownerToken);
    showNotice(
      result.restartRequired
        ? "密码已重置。请保存下方新密码，并按提示手动重启外部 DevSpace 服务。"
        : "密码已重置。请立即保存下方新密码。",
      "success",
    );
  });
});

hideOwnerPasswordButton.addEventListener("click", hideOwnerPassword);

clearLogsButton.addEventListener("click", () => {
  const confirmed = window.confirm(
    "清空当前 GPT 调用日志吗？当前界面的记录会立即移除；项目 logs 目录中的 DevSpace 日志文件也会被截断。",
  );
  if (!confirmed) return;

  void withBusy(async () => {
    const result = await window.devspaceDesktop.clearLogs();
    renderSnapshot(result.snapshot, { preserveForm: true });
    const diskMessage = result.diskFiles > 0
      ? `，并清理 ${result.diskFiles} 个落盘日志文件（释放 ${formatBytes(result.diskBytes)}）`
      : "；当前项目未发现可清理的落盘 DevSpace 日志";
    showNotice(`已清空 ${result.memoryEntries} 条当前会话调用记录${diskMessage}。`, "success");
  });
});

addRootButton.addEventListener("click", () => {
  rootList.append(createRootRow());
});

window.devspaceDesktop.onStatus((snapshot) => {
  renderSnapshot(snapshot, { preserveForm: true });
});

window.devspaceDesktop.onOutput(renderOutput);

void refresh({ preserveForm: false }).catch((error) => {
  showNotice(`无法读取桌面端状态：${errorMessage(error)}`, "error");
});

window.setInterval(() => {
  if (!busy) {
    void refresh({ preserveForm: true }).catch(() => {
      // 状态轮询失败时保留当前页面，避免短暂网络错误清空用户正在填写的表单。
    });
  }
}, 2_500);
