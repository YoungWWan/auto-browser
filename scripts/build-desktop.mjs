import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
if (!process.env.npm_execpath) {
  throw new Error("Run this script with npm run desktop:build -- <options>.");
}
// Invoke npm through Node: execFileSync cannot launch .cmd files on Windows.
execFileSync(process.execPath, [process.env.npm_execpath, "run", "build"], {
  stdio: "inherit",
});
// Tauri discovers both Cargo binaries and builds them with --bins. Adding the
// agent again as externalBin duplicates its MSI component and fails ICE30.
execFileSync(
  process.execPath,
  [
    "node_modules/@tauri-apps/cli/tauri.js",
    "build",
    "--config",
    JSON.stringify({ build: { beforeBuildCommand: "" } }),
    ...process.argv.slice(2),
    "--",
    "--locked",
  ],
  { stdio: "inherit" },
);
