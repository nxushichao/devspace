export type DesktopServiceState = "stopped" | "starting" | "running" | "error";
export type DesktopToolMode = "codex" | "claude";
export type DesktopLogLevel = "silent" | "error" | "warn" | "info" | "debug";
export type DesktopLogFormat = "json" | "pretty";
export type DesktopProviderId = "codex" | "claude" | "opencode" | "pi" | "cursor" | "copilot" | "grok";

export interface DesktopProviderInput {
  id: DesktopProviderId;
  enabled: boolean;
  model?: string;
  effort?: string;
}

export interface DesktopProviderView extends DesktopProviderInput {
  available: boolean;
  usable: boolean;
  reason?: string;
  note?: string;
}

export interface DesktopSkillsConfig {
  enabled: boolean;
  paths: string[];
  agentDir: string;
}

export interface DesktopSubagentsConfigInput {
  enabled: boolean;
  providers: DesktopProviderInput[];
}

export interface DesktopSubagentsConfigView {
  enabled: boolean;
  providers: DesktopProviderView[];
}

export interface DesktopLoggingConfig {
  level: DesktopLogLevel;
  format: DesktopLogFormat;
  requests: boolean;
  assets: boolean;
  toolCalls: boolean;
  shellCommands: boolean;
}

export interface DesktopConfigInput {
  allowedRoots: string[];
  port: number;
  publicBaseUrl: string | null;
  toolMode: DesktopToolMode;
  uiEnabled: boolean;
  skills: DesktopSkillsConfig;
  subagents: DesktopSubagentsConfigInput;
  logging: DesktopLoggingConfig;
}

export interface DesktopConfigView extends Omit<DesktopConfigInput, "subagents"> {
  subagents: DesktopSubagentsConfigView;
  configPath: string;
  authConfigured: boolean;
}

export interface DesktopSnapshot {
  state: DesktopServiceState;
  managedByDesktop: boolean;
  pid?: number;
  localUrl: string;
  publicUrl: string | null;
  config: DesktopConfigView;
  message: string | null;
  output: string[];
}

export interface DesktopDiagnostics {
  ok: boolean;
  output: string;
}

export interface DesktopOwnerPasswordReset {
  ownerToken: string;
  restartRequired: boolean;
  snapshot: DesktopSnapshot;
}

export interface DesktopLogCleanup {
  memoryEntries: number;
  diskFiles: number;
  diskBytes: number;
  snapshot: DesktopSnapshot;
}

export interface DesktopApi {
  getSnapshot(): Promise<DesktopSnapshot>;
  startService(): Promise<DesktopSnapshot>;
  stopService(): Promise<DesktopSnapshot>;
  saveConfig(input: DesktopConfigInput): Promise<DesktopSnapshot>;
  resetOwnerPassword(): Promise<DesktopOwnerPasswordReset>;
  clearLogs(): Promise<DesktopLogCleanup>;
  chooseDirectory(): Promise<string | null>;
  runDiagnostics(): Promise<DesktopDiagnostics>;
  openConfigDirectory(): Promise<void>;
  onStatus(listener: (snapshot: DesktopSnapshot) => void): () => void;
  onOutput(listener: (output: string[]) => void): () => void;
}
