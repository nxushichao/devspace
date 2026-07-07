import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const releaseDirectory = resolve(repositoryRoot, "release");
const maximumAttempts = 8;

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function isTransientWindowsLock(error) {
  return error && typeof error === "object" && ["EBUSY", "EPERM", "ENOTEMPTY"].includes(error.code);
}

for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
  try {
    // Windows Defender、Explorer 或刚退出的 Electron 进程可能短暂锁定 win-unpacked。
    await rm(releaseDirectory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 250,
    });
    console.log("Release directory cleared.");
    process.exit(0);
  } catch (error) {
    if (!isTransientWindowsLock(error) || attempt === maximumAttempts) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `无法清理 release 目录：${detail}\n` +
          "请先退出正在运行的 DevSpace Desktop（包括系统托盘中的实例），关闭可能正在浏览 release\\win-unpacked 的资源管理器窗口后重试。",
      );
    }

    const waitMilliseconds = attempt * 500;
    console.warn(`Release directory is temporarily locked; retrying in ${waitMilliseconds}ms (${attempt}/${maximumAttempts})...`);
    await delay(waitMilliseconds);
  }
}
