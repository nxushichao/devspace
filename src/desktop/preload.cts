import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, DesktopConfigInput } from "./types.js";

// 仅向渲染进程暴露经过筛选的桌面端能力，避免页面获得任意 IPC 或 Node.js 权限。
const desktopApi: DesktopApi = {
  getSnapshot: () => ipcRenderer.invoke("desktop:get-snapshot"),
  startService: () => ipcRenderer.invoke("desktop:start-service"),
  stopService: () => ipcRenderer.invoke("desktop:stop-service"),
  saveConfig: (input: DesktopConfigInput) => ipcRenderer.invoke("desktop:save-config", input),
  resetOwnerPassword: () => ipcRenderer.invoke("desktop:reset-owner-password"),
  clearLogs: () => ipcRenderer.invoke("desktop:clear-logs"),
  chooseDirectory: () => ipcRenderer.invoke("desktop:choose-directory"),
  runDiagnostics: () => ipcRenderer.invoke("desktop:run-diagnostics"),
  openConfigDirectory: () => ipcRenderer.invoke("desktop:open-config-directory"),
  onStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: Awaited<ReturnType<DesktopApi["getSnapshot"]>>) => {
      listener(snapshot);
    };
    ipcRenderer.on("desktop:status", handler);
    return () => ipcRenderer.removeListener("desktop:status", handler);
  },
  onOutput: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, output: string[]) => {
      listener(output);
    };
    ipcRenderer.on("desktop:output", handler);
    return () => ipcRenderer.removeListener("desktop:output", handler);
  },
};

contextBridge.exposeInMainWorld("devspaceDesktop", desktopApi);
