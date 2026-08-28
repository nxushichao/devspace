import { loadConfig } from "../src/config.js";
import { SqliteOAuthStore } from "../src/oauth-store.js";
import {
  generateOwnerToken,
  loadDevspaceFiles,
  setDevspaceConfigValues,
  writeDevspaceAuth,
} from "../src/user-config.js";

interface DesktopSetupInput {
  allowedRoots: string[];
  port: number;
  publicBaseUrl: string | null;
  resetToken?: boolean;
}

interface DesktopSetupState {
  configPath: string;
  authPath: string;
  allowedRoots: string[];
  port: number;
  publicBaseUrl: string | null;
  ownerToken: string | null;
}

function currentState(includeOwnerToken = false): DesktopSetupState {
  const files = loadDevspaceFiles();
  return {
    configPath: files.configPath,
    authPath: files.authPath,
    allowedRoots: files.config.workspaces.allowedRoots,
    port: files.config.server.port,
    publicBaseUrl: files.config.server.publicBaseUrl,
    ownerToken: includeOwnerToken ? files.auth.ownerToken?.trim() || null : null,
  };
}

function parseInput(raw: string | undefined): DesktopSetupInput {
  if (!raw) throw new Error("Missing DEVSPACE_DESKTOP_SETUP_CONFIG payload.");

  const parsed = JSON.parse(raw) as Partial<DesktopSetupInput>;
  if (!Array.isArray(parsed.allowedRoots) || parsed.allowedRoots.some((root) => typeof root !== "string")) {
    throw new Error("Desktop setup allowedRoots must be an array of strings.");
  }
  if (!Number.isInteger(parsed.port) || parsed.port! < 1 || parsed.port! > 65_535) {
    throw new Error("Desktop setup port must be an integer between 1 and 65535.");
  }
  if (parsed.publicBaseUrl !== null && typeof parsed.publicBaseUrl !== "string") {
    throw new Error("Desktop setup publicBaseUrl must be a string or null.");
  }

  return {
    allowedRoots: parsed.allowedRoots,
    port: parsed.port!,
    publicBaseUrl: parsed.publicBaseUrl ?? null,
    resetToken: parsed.resetToken === true,
  };
}

function applyInput(input: DesktopSetupInput): DesktopSetupState {
  if (input.resetToken && process.env.DEVSPACE_OAUTH_OWNER_TOKEN?.trim()) {
    throw new Error("Owner password is overridden by DEVSPACE_OAUTH_OWNER_TOKEN; rotate that environment variable instead.");
  }

  const before = loadDevspaceFiles();

  // 通过官方 JSONC 定点编辑接口修改字段，保留注释、扩展字段和其他新版配置。
  setDevspaceConfigValues([
    { path: ["server", "host"], value: "127.0.0.1" },
    { path: ["server", "port"], value: input.port },
    { path: ["server", "publicBaseUrl"], value: input.publicBaseUrl },
    { path: ["workspaces", "allowedRoots"], value: input.allowedRoots },
  ]);

  if (input.resetToken && before.auth.ownerToken?.trim()) {
    // setup 中显式轮换 Owner password 时同步撤销 OAuth 会话，语义与桌面端按钮保持一致。
    const oauthStore = new SqliteOAuthStore(loadConfig().stateDir);
    try {
      oauthStore.revokeAllTokens();
    } finally {
      oauthStore.close();
    }
  }

  const ownerToken = !input.resetToken && before.auth.ownerToken?.trim()
    ? before.auth.ownerToken.trim()
    : generateOwnerToken();
  writeDevspaceAuth({ ...before.auth, ownerToken });

  return currentState(true);
}

const command = process.argv[2] ?? "read";
const result = command === "read"
  ? currentState(false)
  : command === "apply"
    ? applyInput(parseInput(process.env.DEVSPACE_DESKTOP_SETUP_CONFIG))
    : (() => { throw new Error(`Unknown desktop config command: ${command}`); })();

process.stdout.write(`${JSON.stringify(result)}\n`);
