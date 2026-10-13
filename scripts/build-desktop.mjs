import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const args = process.argv.slice(2);
const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(
  /^host: (.+)$/m,
)[1];
const targetIndex = args.findIndex((arg) => arg === "--target" || arg === "-t");
const target =
  args.find((arg) => arg.startsWith("--target="))?.split("=")[1] ||
  (targetIndex >= 0 ? args[targetIndex + 1] : undefined);
if (target === "universal-apple-darwin") {
  throw new Error("Build each macOS architecture separately with --target.");
}
const debug = args.includes("--debug") || args.includes("-d");
const profile = debug ? "debug" : "release";
// .cmd files cannot be launched directly with execFileSync on Windows.
// Invoke npm with Node to preserve argument boundaries without a shell.
if (!process.env.npm_execpath) {
  throw new Error("Run this script with npm run desktop:build -- <options>.");
}
execFileSync(process.execPath, [process.env.npm_execpath, "run", "build"], {
  stdio: "inherit",
});
execFileSync(
  "cargo",
  [
    "build",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--locked",
    "--bin",
    "auto-browser-agent",
    ...(debug ? [] : ["--release"]),
    ...(target ? ["--target", target] : []),
  ],
  { stdio: "inherit" },
);
mkdirSync("src-tauri/binaries", { recursive: true });
const triple = target || host;
const ext = triple.includes("windows") ? ".exe" : "";
const targetDirectory = resolve(
  process.env.CARGO_TARGET_DIR || "src-tauri/target",
);
copyFileSync(
  join(
    targetDirectory,
    ...(target ? [target] : []),
    profile,
    `auto-browser-agent${ext}`,
  ),
  `src-tauri/binaries/auto-browser-agent-${triple}${ext}`,
);
const config = JSON.stringify({
  build: { beforeBuildCommand: "" },
  bundle: { externalBin: ["binaries/auto-browser-agent"] },
});
execFileSync(
  process.execPath,
  [
    "node_modules/@tauri-apps/cli/tauri.js",
    "build",
    "--config",
    config,
    ...args,
    "--",
    "--locked",
  ],
  { stdio: "inherit" },
);
