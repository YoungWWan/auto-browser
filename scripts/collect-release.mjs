import { copyFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const target = process.argv[2];
const formats = target?.includes("apple-darwin")
  ? [".dmg"]
  : target?.includes("windows")
    ? [".exe", ".msi"]
    : target?.includes("linux")
      ? [".deb", ".rpm", ".AppImage"]
      : undefined;
if (!formats)
  throw new Error("Pass the Rust target triple used for this build.");
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const bundle = join(
  resolve(process.env.CARGO_TARGET_DIR || "src-tauri/target"),
  target,
  "release/bundle",
);
const destination = "artifacts/release";
mkdirSync(destination, { recursive: true });
const found = new Set();
function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.endsWith(".app") && !entry.name.endsWith(".AppDir"))
        collect(path);
    } else {
      const format = formats.find((extension) =>
        entry.name.endsWith(extension),
      );
      if (format) {
        const name = `Auto-Browser_${version}_${target}_${entry.name.replaceAll(" ", "-")}`;
        copyFileSync(path, join(destination, name));
        found.add(format);
        console.log(name);
      }
    }
  }
}
collect(bundle);
for (const format of formats) {
  if (!found.has(format))
    throw new Error(`Missing ${format} installer for ${target}.`);
}
