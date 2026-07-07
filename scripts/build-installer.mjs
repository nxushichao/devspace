import { access, readdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cacheDirectory = join(
  process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
  "electron-builder",
  "Cache",
);
const electronBuilderCli = join(repositoryRoot, "node_modules", "electron-builder", "out", "cli", "cli.js");

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findDirectories(directory, directoryName, maximumDepth = 5, depth = 0) {
  if (depth > maximumDepth) return [];

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    if (entry.name.toLowerCase() === directoryName.toLowerCase()) results.push(path);
    results.push(...await findDirectories(path, directoryName, maximumDepth, depth + 1));
  }
  return results;
}

async function newestPath(paths) {
  const existing = [];
  for (const path of paths) {
    try {
      existing.push({ path, metadata: await stat(path) });
    } catch {
      // 缓存可能被另一个清理任务移除，跳过并使用其他候选项。
    }
  }
  existing.sort((left, right) => right.metadata.mtimeMs - left.metadata.mtimeMs);
  return existing[0]?.path;
}

async function findCachedNsisDirectory() {
  const candidateRoots = [
    join(cacheDirectory, "nsis-3.0.4.1"),
    join(cacheDirectory, "nsis"),
  ];
  const roots = [];

  for (const candidateRoot of candidateRoots) {
    const binDirectories = await findDirectories(candidateRoot, "Bin");
    for (const binDirectory of binDirectories) {
      if (await pathExists(join(binDirectory, "makensis.exe"))) roots.push(dirname(binDirectory));
    }
  }

  return newestPath(roots);
}

async function findCachedNsisResourcesDirectory() {
  const pluginDirectories = await findDirectories(cacheDirectory, "plugins");
  const roots = pluginDirectories
    .filter((path) => path.toLowerCase().includes("nsis-resources"))
    .map((path) => dirname(path));

  return newestPath(roots);
}

function run(command, args, environment) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: environment,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} exited with code ${code ?? "unknown"}.`));
    });
  });
}

if (!await pathExists(electronBuilderCli)) {
  throw new Error("找不到 electron-builder。请先执行 npm install。");
}

const environment = { ...process.env };
const [cachedNsisDirectory, cachedNsisResourcesDirectory] = await Promise.all([
  findCachedNsisDirectory(),
  findCachedNsisResourcesDirectory(),
]);

// 优先复用 electron-builder 已缓存的 NSIS 工具，避免临时网络异常阻断安装包构建。
if (!environment.ELECTRON_BUILDER_NSIS_DIR && cachedNsisDirectory) {
  environment.ELECTRON_BUILDER_NSIS_DIR = cachedNsisDirectory;
  console.log(`Using cached NSIS binary: ${cachedNsisDirectory}`);
}
if (!environment.ELECTRON_BUILDER_NSIS_RESOURCES_DIR && cachedNsisResourcesDirectory) {
  environment.ELECTRON_BUILDER_NSIS_RESOURCES_DIR = cachedNsisResourcesDirectory;
  console.log(`Using cached NSIS resources: ${cachedNsisResourcesDirectory}`);
}

await run(process.execPath, [electronBuilderCli, "--win", "nsis"], environment);
