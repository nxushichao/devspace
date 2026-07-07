import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtimeDirectory = resolve(repositoryRoot, "dist", "desktop-runtime");
const runtimeName = process.platform === "win32" ? "node.exe" : "node";
const destination = resolve(runtimeDirectory, runtimeName);

// 桌面包携带当前构建环境的 Node 运行时，确保 better-sqlite3 与运行时 ABI 一致。
await mkdir(dirname(destination), { recursive: true });
await cp(process.execPath, destination);
