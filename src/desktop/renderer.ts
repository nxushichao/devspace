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
const toolModeSelect = requiredElement<HTMLSelectElement>("tool-mode-select");
const uiEnabledInput = requiredElement<HTMLInputElement>("ui-enabled-input");
const subagentsEnabledInput = requiredElement<HTMLInputElement>("subagents-enabled-input");
const providerGrid = requiredElement<HTMLElement>("provider-grid");
const skillsEnabledInput = requiredElement<HTMLInputElement>("skills-enabled-input");
const agentDirInput = requiredElement<HTMLInputElement>("agent-dir-input");
const chooseAgentDirButton = requiredElement<HTMLButtonElement>("choose-agent-dir-button");
const skillPathList = requiredElement<HTMLElement>("skill-path-list");
const addSkillPathButton = requiredElement<HTMLButtonElement>("add-skill-path-button");
const logLevelSelect = requiredElement<HTMLSelectElement>("log-level-select");
const logFormatSelect = requiredElement<HTMLSelectElement>("log-format-select");
const logRequestsInput = requiredElement<HTMLInputElement>("log-requests-input");
const logAssetsInput = requiredElement<HTMLInputElement>("log-assets-input");
const logToolCallsInput = requiredElement<HTMLInputElement>("log-tool-calls-input");
const logShellCommandsInput = requiredElement<HTMLInputElement>("log-shell-commands-input");
const configPathValue = requiredElement<HTMLElement>("config-path-value");
const authValue = requiredElement<HTMLElement>("auth-value");
const ownerPasswordResult = requiredElement<HTMLElement>("owner-password-result");
const ownerPasswordValue = requiredElement<HTMLElement>("owner-password-value");
const logOutput = requiredElement<HTMLPreElement>("log-output");
const diagnosticOutput = requiredElement<HTMLPreElement>("diagnostic-output");
const notice = requiredElement<HTMLElement>("notice");
const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-tab-target]"));
const tabPanels = Array.from(document.querySelectorAll<HTMLElement>("[data-tab-panel]"));

type DesktopTabId = "status" | "config" | "subagents" | "skills" | "logs";
const DESKTOP_TAB_IDS: readonly DesktopTabId[] = ["status", "config", "subagents", "skills", "logs"];

let currentSnapshot: DesktopSnapshot | null = null;
let busy = false;
let initialized = false;

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing desktop control: ${id}`);
  return element as T;
}

function isDesktopTabId(value: string | undefined): value is DesktopTabId {
  return value !== undefined && DESKTOP_TAB_IDS.includes(value as DesktopTabId);
}

function tabFromHash(): DesktopTabId | null {
  const value = window.location.hash.replace(/^#/, "");
  return isDesktopTabId(value) ? value : null;
}

function activateTab(tabId: DesktopTabId, options: { focus?: boolean; updateHash?: boolean } = {}): void {
  const activeButton = tabButtons.find((button) => button.dataset.tabTarget === tabId);
  if (!activeButton) return;

  for (const button of tabButtons) {
    const selected = button === activeButton;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  }

  for (const panel of tabPanels) {
    panel.hidden = panel.dataset.tabPanel !== tabId;
  }

  if (options.updateHash !== false && window.location.hash !== `#${tabId}`) {
    // 使用 hash 保存当前页签，但不触发页面滚动或完整导航。
    window.history.replaceState(null, "", `#${tabId}`);
  }
  if (options.focus) activeButton.focus();
}

function handleTabKeydown(event: KeyboardEvent, currentButton: HTMLButtonElement): void {
  const currentIndex = tabButtons.indexOf(currentButton);
  if (currentIndex === -1) return;

  let nextIndex: number | null = null;
  if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabButtons.length;
  if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabButtons.length) % tabButtons.length;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = tabButtons.length - 1;
  if (nextIndex === null) return;

  event.preventDefault();
  const nextButton = tabButtons[nextIndex];
  const nextTab = nextButton?.dataset.tabTarget;
  if (nextButton && isDesktopTabId(nextTab)) {
    activateTab(nextTab, { focus: true });
  }
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
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("[data-config-control]").forEach((element) => {
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

function createSkillPathRow(value = ""): HTMLElement {
  const row = document.createElement("div");
  row.className = "path-row";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "skill-path-input";
  input.value = value;
  input.placeholder = "例如 E:\\agents\\skills";
  input.dataset.configControl = "true";

  const browseButton = document.createElement("button");
  browseButton.type = "button";
  browseButton.className = "secondary compact";
  browseButton.textContent = "选择";
  browseButton.dataset.configControl = "true";
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
  removeButton.title = "移除此 Skills 目录";
  removeButton.dataset.configControl = "true";
  removeButton.addEventListener("click", () => row.remove());

  row.append(input, browseButton, removeButton);
  return row;
}

function renderSkillPaths(paths: string[]): void {
  skillPathList.replaceChildren();
  paths.forEach((path) => skillPathList.append(createSkillPathRow(path)));
}

const PROVIDER_LABELS: Record<DesktopSnapshot["config"]["subagents"]["providers"][number]["id"], string> = {
  codex: "Codex",
  claude: "Claude",
  opencode: "OpenCode",
  pi: "Pi",
  cursor: "Cursor",
  copilot: "Copilot",
  grok: "Grok",
};

function renderProviders(providers: DesktopSnapshot["config"]["subagents"]["providers"]): void {
  providerGrid.replaceChildren();
  for (const provider of providers) {
    const card = document.createElement("section");
    card.className = "provider-card";
    card.dataset.providerId = provider.id;

    const head = document.createElement("div");
    head.className = "provider-head";

    const toggle = document.createElement("label");
    toggle.className = "toggle-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "provider-enabled-input";
    checkbox.checked = provider.enabled;
    checkbox.dataset.configControl = "true";
    const name = document.createElement("span");
    name.className = "provider-name";
    name.textContent = PROVIDER_LABELS[provider.id];
    toggle.append(checkbox, name);

    const status = document.createElement("span");
    status.className = `provider-status ${provider.available ? "available" : "unavailable"}`;
    status.textContent = provider.available
      ? provider.usable ? "可用 · 已启用" : "已检测到"
      : `不可用 · ${provider.reason ?? "未通过检测"}`;
    head.append(toggle, status);

    const fields = document.createElement("div");
    fields.className = "provider-fields";
    const modelLabel = document.createElement("label");
    modelLabel.innerHTML = "<span>Model（可选）</span>";
    const modelInput = document.createElement("input");
    modelInput.type = "text";
    modelInput.className = "provider-model-input";
    modelInput.value = provider.model ?? "";
    modelInput.placeholder = "使用 Provider 默认值";
    modelInput.dataset.configControl = "true";
    modelLabel.append(modelInput);

    const effortLabel = document.createElement("label");
    effortLabel.innerHTML = "<span>Effort（可选）</span>";
    const effortInput = document.createElement("input");
    effortInput.type = "text";
    effortInput.className = "provider-effort-input";
    effortInput.value = provider.effort ?? "";
    effortInput.placeholder = "例如 high";
    effortInput.dataset.configControl = "true";
    effortLabel.append(effortInput);

    fields.append(modelLabel, effortLabel);
    card.append(head, fields);
    providerGrid.append(card);
  }
}

function readConfigInput(): DesktopConfigInput {
  const allowedRoots = Array.from(rootList.querySelectorAll<HTMLInputElement>(".root-input"))
    .map((input) => input.value.trim())
    .filter(Boolean);
  const skillPaths = Array.from(skillPathList.querySelectorAll<HTMLInputElement>(".skill-path-input"))
    .map((input) => input.value.trim())
    .filter(Boolean);
  const providers = Array.from(providerGrid.querySelectorAll<HTMLElement>(".provider-card")).map((card) => {
    const id = card.dataset.providerId as DesktopConfigInput["subagents"]["providers"][number]["id"];
    const enabled = card.querySelector<HTMLInputElement>(".provider-enabled-input")?.checked ?? false;
    const model = card.querySelector<HTMLInputElement>(".provider-model-input")?.value.trim() || undefined;
    const effort = card.querySelector<HTMLInputElement>(".provider-effort-input")?.value.trim() || undefined;
    return { id, enabled, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  });

  return {
    allowedRoots,
    port: Number(portInput.value),
    publicBaseUrl: publicBaseUrlInput.value.trim() || null,
    toolMode: toolModeSelect.value as DesktopConfigInput["toolMode"],
    uiEnabled: uiEnabledInput.checked,
    skills: {
      enabled: skillsEnabledInput.checked,
      paths: skillPaths,
      agentDir: agentDirInput.value.trim(),
    },
    subagents: {
      enabled: subagentsEnabledInput.checked,
      providers,
    },
    logging: {
      level: logLevelSelect.value as DesktopConfigInput["logging"]["level"],
      format: logFormatSelect.value as DesktopConfigInput["logging"]["format"],
      requests: logRequestsInput.checked,
      assets: logAssetsInput.checked,
      toolCalls: logToolCallsInput.checked,
      shellCommands: logShellCommandsInput.checked,
    },
  };
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
    toolModeSelect.value = snapshot.config.toolMode;
    uiEnabledInput.checked = snapshot.config.uiEnabled;
    subagentsEnabledInput.checked = snapshot.config.subagents.enabled;
    renderProviders(snapshot.config.subagents.providers);
    skillsEnabledInput.checked = snapshot.config.skills.enabled;
    agentDirInput.value = snapshot.config.skills.agentDir;
    renderSkillPaths(snapshot.config.skills.paths);
    logLevelSelect.value = snapshot.config.logging.level;
    logFormatSelect.value = snapshot.config.logging.format;
    logRequestsInput.checked = snapshot.config.logging.requests;
    logAssetsInput.checked = snapshot.config.logging.assets;
    logToolCallsInput.checked = snapshot.config.logging.toolCalls;
    logShellCommandsInput.checked = snapshot.config.logging.shellCommands;
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
  showNotice(snapshot.message ?? "配置已保存。", "success");
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

addSkillPathButton.addEventListener("click", () => {
  skillPathList.append(createSkillPathRow());
});

chooseAgentDirButton.addEventListener("click", () => {
  void withBusy(async () => {
    const selected = await window.devspaceDesktop.chooseDirectory();
    if (selected) agentDirInput.value = selected;
  });
});

for (const button of tabButtons) {
  button.addEventListener("click", () => {
    const tabId = button.dataset.tabTarget;
    if (isDesktopTabId(tabId)) activateTab(tabId);
  });
  button.addEventListener("keydown", (event) => handleTabKeydown(event, button));
}

window.addEventListener("hashchange", () => {
  activateTab(tabFromHash() ?? "status", { updateHash: false });
});

activateTab(tabFromHash() ?? "status", { updateHash: false });

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
