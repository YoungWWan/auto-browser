import { readFileSync } from "node:fs";

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const version = JSON.parse(read("package.json")).version;
const versions = {
  "package-lock.json": JSON.parse(read("package-lock.json")).version,
  "package-lock.json root": JSON.parse(read("package-lock.json")).packages[""]
    .version,
  "src-tauri/tauri.conf.json": JSON.parse(read("src-tauri/tauri.conf.json"))
    .version,
  "src-tauri/Cargo.toml": read("src-tauri/Cargo.toml").match(
    /^version = "([^"]+)"/m,
  )?.[1],
};
if (process.env.GITHUB_REF_TYPE === "tag") {
  versions["release tag"] = process.env.GITHUB_REF_NAME?.replace(/^v/, "");
}
for (const [file, actual] of Object.entries(versions)) {
  if (actual !== version)
    throw new Error(`${file}: expected ${version}, got ${actual}`);
}
console.log(`All version fields match v${version}.`);
