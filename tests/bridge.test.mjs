import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
let browser, page;
const source = await readFile(
  new URL("../src-tauri/src/bridge.js", import.meta.url),
  "utf8",
);
const html = await readFile(
  new URL("../src-tauri/src/demo.html", import.meta.url),
  "utf8",
);
const action = async (request) =>
  JSON.parse(
    await page.evaluate(({ source, request }) => eval(source)(request), {
      source,
      request,
    }),
  );
before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});
after(async () => {
  await browser?.close();
});
test("fills a real form using labels, selection and checkbox, then verifies completion", async () => {
  await page.setContent(html);
  const snapshot = await action({ kind: "snapshot" });
  assert.ok(
    snapshot.elements.some(
      (e) => e.label === "客户姓名" && e.selector === "#name",
    ),
  );
  for (const request of [
    { kind: "fill", target: { label: "客户姓名" }, value: "李四" },
    { kind: "fill", target: { label: "邮箱" }, value: "lisi@example.com" },
    { kind: "select", target: { label: "客户类型" }, value: "business" },
    { kind: "check", target: { label: "接收产品更新" }, value: true },
    { kind: "click", target: { text: "保存客户" } },
  ])
    assert.equal((await action(request)).ok, true);
  const result = await action({
    kind: "assert_text",
    target: { selector: "#result" },
    value: "已保存：李四",
  });
  assert.equal(result.verified, true);
  assert.equal(
    (await action({ kind: "assert_text", value: "这个结果不存在" })).ok,
    false,
  );
});
test("ambiguous or missing targets fail before clicking", async () => {
  await page.setContent("<button>提交</button><button>提交</button>");
  assert.match(
    (await action({ kind: "click", target: { text: "提交" } })).error,
    /2 个/,
  );
  assert.equal(
    (
      await action({
        kind: "fill",
        target: { selector: "#missing" },
        value: "x",
      })
    ).ok,
    false,
  );
});
test("password values are redacted in observation and marked sensitive in actions", async () => {
  await page.setContent(
    '<label for="password">密码</label><input id="password" type="password">',
  );
  assert.equal(
    (
      await action({
        kind: "fill",
        target: { label: "密码" },
        value: "secret-example",
      })
    ).sensitive,
    true,
  );
  const snapshot = await action({ kind: "snapshot" });
  assert.equal(snapshot.elements[0].value, "[redacted]");
  assert.ok(!JSON.stringify(snapshot).includes("secret-example"));
});
test("unsupported controls fail and input events update controlled fields", async () => {
  await page.setContent(
    '<label for="field">字段</label><input id="field"><div id="custom">自定义</div><output id="echo"></output>',
  );
  await page.evaluate(() =>
    document
      .getElementById("field")
      .addEventListener(
        "input",
        (e) => (document.getElementById("echo").textContent = e.target.value),
      ),
  );
  assert.equal(
    (
      await action({
        kind: "fill",
        target: { label: "字段" },
        value: "状态更新",
      })
    ).ok,
    true,
  );
  assert.equal(await page.locator("#echo").textContent(), "状态更新");
  assert.equal(
    (
      await action({
        kind: "select",
        target: { selector: "#custom" },
        value: "x",
      })
    ).ok,
    false,
  );
});
