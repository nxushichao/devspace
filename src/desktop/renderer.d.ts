import type { DesktopApi } from "./types.js";

declare global {
  interface Window {
    devspaceDesktop: DesktopApi;
  }
}

export {};
