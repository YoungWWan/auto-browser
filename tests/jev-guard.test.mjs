import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const bridge = await readFile(
  new URL("../src-tauri/src/bridge.js", import.meta.url),
  "utf8",
);
const guard = await readFile(
  new URL("../src-tauri/src/jev_action.js", import.meta.url),
  "utf8",
);
let browser, page;
before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});
after(async () => {
  await browser?.close();
});
async function observe() {
  return JSON.parse(
    await page.evaluate((source) => eval(source)({ kind: "snapshot" }), bridge),
  );
}
async function click(snapshot) {
  return JSON.parse(
    await page.evaluate(
      ({ guard, bridge, snapshot }) =>
        eval(guard)(
          {
            snapshot,
            action: { kind: "click", target: { selector: "#action" } },
          },
          eval(bridge),
        ),
      { guard, bridge, snapshot },
    ),
  );
}
async function setup() {
  await page.setContent(
    "<button id=\"action\" onclick=\"document.querySelector('output').textContent='已执行'\">打开列表</button><output>尚未执行</output>",
  );
}
test("atomic guard accepts snapshot after Rust-style sorted JSON keys", async () => {
  await setup();
  const sorted = (value) =>
    Array.isArray(value)
      ? value.map(sorted)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, sorted(value[key])]),
          )
        : value;
  const snapshot = sorted(await observe());
  assert.equal((await click(snapshot)).ok, true);
  assert.equal(await page.locator("output").textContent(), "已执行");
});
test("changed DOM prevents execution inside the same evaluation", async () => {
  await setup();
  const snapshot = await observe();
  await page.locator("#action").evaluate((el) => (el.textContent = "删除客户"));
  assert.equal((await click(snapshot)).error, "JEV_STALE_STATE");
  assert.equal(await page.locator("output").textContent(), "尚未执行");
});
test("new document with identical content cannot reuse a previous decision", async () => {
  await setup();
  const snapshot = await observe();
  await page.evaluate(() => delete window.__AUTO_BROWSER_DOCUMENT_ID__);
  assert.equal((await click(snapshot)).error, "JEV_STALE_STATE");
  assert.equal(await page.locator("output").textContent(), "尚未执行");
});
test("observation exposes ARIA disabled controls and scroll boundaries", async () => {
  await page.setContent(
    '<div role="button" aria-disabled="true">不可操作</div><div style="height:2500px">长页面</div>',
  );
  const snapshot = await observe();
  assert.equal(snapshot.elements[0].disabled, true);
  assert.ok(snapshot.scroll.maxY > 1000);
  assert.equal(snapshot.scroll.y, 0);
});
