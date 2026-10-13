// Exercise real content lengths and navigation continuity using isolated data.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";
import { initializeSpaceFixture } from "./fixtures/space-ui.mjs";

const output = resolve(
  `docs/ui-design/screenshots/${process.argv[2] || "resilience"}`,
);
await mkdir(output, { recursive: true });
const server = await createServer({ server: { port: 0 }, logLevel: "error" });
await server.listen();
const browser = await chromium.launch({ headless: true });
const results = [];
const errors = [];
try {
  for (const width of [1440, 1100, 900, 640, 390, 320]) {
    const page = await browser.newPage({
      viewport: { width, height: 844 },
      reducedMotion: "reduce",
    });
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.addInitScript(initializeSpaceFixture);
    await page.addInitScript(() => {
      const state = window.fixture;
      for (let i = 0; i < 24; i++) {
        state.flows.push({
          ...state.flows[1],
          id: `long-${i}`,
          domainId: "sales",
          name: `发布与复核跨部门客户资料：第 ${i + 1} 份工作包`,
          description: "需要核对全部输入，并在实际网页确认本次操作结果。",
        });
      }
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.reviewFinished = [];
      window.__TAURI_INTERNALS__.invoke = async (command, payload) => {
        if (payload?.name === "flow_list" && payload.args.query === "发布")
          await new Promise((resolve) => setTimeout(resolve, 500));
        const result = await invoke(command, payload);
        if (payload?.name === "flow_list")
          window.reviewFinished.push(payload.args.query);
        if (payload?.name === "flow_get" && result.archivedRevision) {
          const k = result.archivedRevision.knowledge;
          k.purpose = "复核长流程中的输入与结果，记录每一步的业务判断。";
          k.inputs[0].label = "跨部门业务资料的完整标题";
          k.inputs[0].name = "customer_submission_reference_".repeat(4);
          k.procedureMarkdown = Array.from(
            { length: 12 },
            (_, i) =>
              `${i + 1}. 核对第 ${i + 1} 项资料，确认与本次输入一致；引用编号：\`${"reference_identifier_".repeat(6)}\`。`,
          ).join("\n");
          k.judgementMarkdown =
            "- 确认已发布的资料与输入一致。\n  - 页面内存在确认编号。\n  - 编号对应本次操作。\n- 确认页面包含完整的业务资料与归属信息。";
        }
        return result;
      };
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
    if (width <= 640)
      await page
        .getByRole("button", { name: "打开导航菜单", exact: true })
        .click();
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: /^流程库/ })
      .click();
    const last = page.locator(".flow-card").last();
    await last.waitFor();
    if (width === 1440) {
      const search = page.getByRole("textbox", {
        name: "搜索流程",
        exact: true,
      });
      await search.fill("没有这份资料");
      await page
        .getByRole("heading", { name: "没有匹配的流程", exact: true })
        .waitFor();
      await search.fill("不存在的旧结果");
      await page.waitForFunction(() =>
        window.fixture.calls.some(
          (c) => c.name === "flow_list" && c.args.query === "不存在的旧结果",
        ),
      );
      await search.fill("发布");
      await page.waitForFunction(() =>
        window.reviewFinished.includes("不存在的旧结果"),
      );
      assert.equal(
        await page
          .getByRole("heading", { name: "没有匹配的流程", exact: true })
          .count(),
        0,
        "An earlier request must not end the latest search's loading state",
      );
      await page
        .getByRole("status")
        .filter({ hasText: "正在读取流程" })
        .waitFor();
      await last.waitFor();
      assert.equal(await page.locator(".flow-card").count(), 24);
      await page
        .getByRole("button", { name: "清除流程搜索", exact: true })
        .click();
      await page.waitForFunction(
        () => document.querySelectorAll(".flow-card").length === 25,
      );
    }
    await last.scrollIntoViewIfNeeded();
    const before = await page
      .locator(".flow-page")
      .evaluate((el) => el.scrollTop);
    await last.click();
    await page.locator(".flow-prose").waitFor();
    assert.equal(
      await page.locator(".flow-page").evaluate((el) => el.scrollTop),
      0,
    );
    const overflow = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          ".flow-page,.flow-detail,.flow-inputs,.flow-procedure > ol,.flow-criteria",
        ),
      ].map((el) => ({
        name: el.className,
        width: el.clientWidth,
        scrollWidth: el.scrollWidth,
      })),
    );
    await page.screenshot({ path: `${output}/long-flow-${width}.png` });
    results.push({ width, overflow });
    for (const item of overflow)
      assert.ok(
        item.scrollWidth <= item.width + 1,
        `${item.name} overflows at ${width}px: ${item.scrollWidth}/${item.width}`,
      );
    const criteria = page.locator(".flow-criteria");
    const checks = criteria.getByRole("checkbox");
    assert.equal(await checks.count(), 4);
    // A nested criterion must change only its own state.
    await criteria
      .locator(".flow-criterion-text")
      .filter({ hasText: /^页面内存在确认编号。$/ })
      .click();
    assert.equal(await checks.nth(1).isChecked(), true);
    assert.equal(await checks.first().isChecked(), false);
    await checks.nth(1).uncheck();
    await page
      .getByRole("button", { name: "返回流程列表", exact: true })
      .click();
    assert.equal(
      await last.evaluate((el) => el === document.activeElement),
      true,
    );
    const after = await page
      .locator(".flow-page")
      .evaluate((el) => el.scrollTop);
    assert.ok(
      Math.abs(before - after) <= 1,
      `Directory scroll position was lost at ${width}px`,
    );
    await page.screenshot({ path: `${output}/long-directory-${width}.png` });
    await page.close();
    console.log(
      `PASS: ${width}px — long content, nested criteria, focus and scroll restoration`,
    );
  }
  assert.deepEqual(errors, []);
} finally {
  await writeFile(
    `${output}/resilience.json`,
    JSON.stringify({ errors, results }, null, 2),
  );
  await browser.close();
  await server.close();
}
