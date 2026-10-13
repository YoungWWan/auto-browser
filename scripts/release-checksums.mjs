import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const directory = "artifacts/release";
const files = readdirSync(directory)
  .filter((name) => name !== "SHA256SUMS.txt")
  .sort();
const targets = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
];
for (const target of targets) {
  if (!files.some((name) => name.includes(target)))
    throw new Error(`Missing release assets for ${target}.`);
}
const checksums = files.map(
  (name) =>
    `${createHash("sha256")
      .update(readFileSync(join(directory, name)))
      .digest("hex")}  ${name}`,
);
writeFileSync(join(directory, "SHA256SUMS.txt"), `${checksums.join("\n")}\n`);
console.log(
  `Verified ${targets.length} targets and wrote checksums for ${files.length} installers.`,
);
