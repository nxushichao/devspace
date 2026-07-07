export type DesktopServiceState = "stopped" | "starting" | "running" | "error";

export interface DesktopConfigInput {
  allowedRoots: string[];
  port: number;
  publicBaseUrl: string | null;
}

export interface DesktopConfigView extends DesktopConfigInput {
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
