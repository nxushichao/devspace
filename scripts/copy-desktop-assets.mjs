import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = resolve(repositoryRoot, "src", "desktop", "index.html");
const destination = resolve(repositoryRoot, "dist", "desktop", "index.html");

await mkdir(dirname(destination), { recursive: true });
await cp(source, destination);
