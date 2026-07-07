import { access, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = await import(new URL("../package.json", import.meta.url), { with: { type: "json" } });
const productName = packageJson.default.build?.productName ?? packageJson.default.name ?? "DevSpace Desktop";
const version = packageJson.default.version ?? "0.0.0";
const releaseDirectory = resolve(repositoryRoot, "release");
const unpackedDirectory = resolve(releaseDirectory, "win-unpacked");
const applicationExecutable = resolve(unpackedDirectory, `${productName}.exe`);
const outputExecutable = resolve(releaseDirectory, `${productName}-${version}-portable.exe`);
const scriptPath = resolve(releaseDirectory, "portable-launcher.nsi");

function toNsisVersion(value) {
  const numbers = value.match(/\d+/g)?.slice(0, 4).map(Number) ?? [];
  while (numbers.length < 4) numbers.push(0);
  return numbers.map((number) => Math.min(Math.max(number, 0), 65_535)).join(".");
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findFiles(directory, fileName, maximumDepth = 5, depth = 0) {
  if (depth > maximumDepth) return [];

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const matches = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
      matches.push(path);
    } else if (entry.isDirectory()) {
      matches.push(...await findFiles(path, fileName, maximumDepth, depth + 1));
    }
  }
  return matches;
}

async function resolveMakeNsis() {
  const explicit = process.env.NSIS_MAKENSIS;
  if (explicit && await pathExists(explicit)) return explicit;

  const candidates = [
    join(process.env.ProgramFiles ?? "", "NSIS", "makensis.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "", "NSIS", "makensis.exe"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }

  // electron-builder 在构建目录包时会下载 NSIS；复用其缓存可避免再次联网。
  const cacheDirectory = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "electron-builder", "Cache", "nsis");
  const cached = await findFiles(cacheDirectory, "makensis.exe");
  if (cached.length > 0) {
    const sorted = await Promise.all(cached.map(async (path) => ({ path, metadata: await stat(path) })));
    sorted.sort((left, right) => right.metadata.mtimeMs - left.metadata.mtimeMs);
    return sorted[0].path;
  }

  throw new Error(
    "找不到 makensis.exe。请先执行 npm run desktop:unpacked，让 electron-builder 下载 Windows 打包工具，或设置 NSIS_MAKENSIS 指向 makensis.exe。",
  );
}

function escapeNsis(value) {
  return value
    .replace(/\$/g, () => "$$")
    .replace(/"/g, () => "$\\\"");
}

function buildNsisSource() {
  const applicationDirectoryName = productName.replace(/[\\/:*?"<>|]/g, "-");
  const executableName = `${productName}.exe`;

  return `Unicode true
SetCompress off
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
ShowInstDetails nevershow
Name "${escapeNsis(productName)}"
OutFile "${escapeNsis(outputExecutable)}"
VIProductVersion "${toNsisVersion(version)}"
VIAddVersionKey /LANG=1033 "ProductName" "${escapeNsis(productName)}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${escapeNsis(version)}"
VIAddVersionKey /LANG=1033 "FileVersion" "${toNsisVersion(version)}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "DevSpace contributors"
VIAddVersionKey /LANG=1033 "FileDescription" "${escapeNsis(productName)} portable launcher"

Section "Run DevSpace Desktop"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\\${escapeNsis(applicationDirectoryName)}"
  File /r "${escapeNsis(unpackedDirectory)}\\*.*"
  ExecWait '"$PLUGINSDIR\\${escapeNsis(applicationDirectoryName)}\\${escapeNsis(executableName)}"' $0
  SetErrorLevel $0
SectionEnd
`;
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
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

if (!await pathExists(applicationExecutable)) {
  throw new Error(`找不到 Windows 应用目录：${applicationExecutable}。请先执行 electron-builder --win dir。`);
}

const makeNsis = await resolveMakeNsis();
await rm(outputExecutable, { force: true });
await writeFile(scriptPath, buildNsisSource(), "utf8");

try {
  console.log(`Creating single-file portable executable: ${outputExecutable}`);
  await run(makeNsis, [scriptPath]);
} finally {
  await rm(scriptPath, { force: true });
}

const artifact = await stat(outputExecutable);
console.log(`Created ${outputExecutable} (${Math.round(artifact.size / 1024 / 1024)} MiB).`);

if (process.argv.includes("--cleanup")) {
  // 单文件分发不保留构建中间目录，确保 release 中只有可发送的 EXE。
  await rm(unpackedDirectory, { recursive: true, force: true });
  console.log(`Removed temporary unpacked directory: ${unpackedDirectory}`);
}
