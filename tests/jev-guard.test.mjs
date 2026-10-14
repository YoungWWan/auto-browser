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

test("unrelated text, controls and scrolling do not invalidate a scoped click", async () => {
  await page.setContent(
    '<section><button id="action" onclick="document.querySelector(\'output\').textContent=\'已执行\'">打开列表</button><output>尚未执行</output></section><aside><span id="ticker">广告一</span><button id="other">其他操作</button></aside><div style="height:2500px"></div>',
  );
  const snapshot = await observe();
  await page.evaluate(() => {
    document.querySelector("#ticker").textContent = "广告二";
    document.querySelector("#other").textContent = "其他文案";
    window.scrollTo(0, 300);
  });
  assert.equal((await click(snapshot)).ok, true);
  assert.equal(await page.locator("output").textContent(), "已执行");
});

test("target context, identity and disabled state changes still block a click", async () => {
  for (const change of ["context", "replace", "disabled", "url"]) {
    await page.setContent(
      '<section><p id="context">客户甲</p><button id="action" onclick="document.querySelector(\'output\').textContent=\'已执行\'">打开列表</button><output>尚未执行</output></section>',
    );
    const snapshot = await observe();
    await page.evaluate((change) => {
      const target = document.querySelector("#action");
      if (change === "context")
        document.querySelector("#context").textContent = "客户乙";
      if (change === "replace") target.replaceWith(target.cloneNode(true));
      if (change === "disabled") target.setAttribute("aria-disabled", "true");
      if (change === "url") history.pushState({}, "", "#another-customer");
    }, change);
    assert.equal((await click(snapshot)).error, "JEV_STALE_STATE", change);
    assert.equal(await page.locator("output").textContent(), "尚未执行");
  }
});

test("field changes outside the target scope invalidate decisions without exposing secrets", async () => {
  for (const type of ["text", "password", "hidden"]) {
    await page.setContent(
      `<section><button id="action" onclick="document.querySelector('output').textContent='已执行'">打开列表</button><output>尚未执行</output></section><input id="field" type="${type}" value="original">`,
    );
    const snapshot = await observe();
    await page
      .locator("#field")
      .evaluate((el) => (el.value = "secret-example"));
    assert.equal((await click(snapshot)).error, "JEV_STALE_STATE", type);
    assert.equal(await page.locator("output").textContent(), "尚未执行");
    if (type === "password")
      assert.equal(
        JSON.stringify(await observe()).includes("secret-example"),
        false,
      );
  }
});
