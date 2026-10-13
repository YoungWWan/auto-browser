// Repeatable visual and keyboard checks against the isolated IPC fixture.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";
import { initializeSpaceFixture } from "./fixtures/space-ui.mjs";

const round = process.argv[2] || "current";
const output = resolve(`docs/ui-design/screenshots/${round}`);
await mkdir(output, { recursive: true });
const server = await createServer({
  server: { port: 0, strictPort: false },
  logLevel: "error",
});
await server.listen();
const browser = await chromium.launch({ headless: true });
const errors = [];
const measurements = [];
const contrastResults = [];
const address = `http://127.0.0.1:${server.httpServer.address().port}`;
try {
  for (const viewport of [
    { width: 1440, height: 940 },
    { width: 1100, height: 720 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.addInitScript(initializeSpaceFixture, { includeJev: true });
    await page.goto(address);
    await page
      .locator(".session-item")
      .filter({ hasText: "客户列表" })
      .waitFor({ state: "attached" });
    const suffix = `${viewport.width}x${viewport.height}`;
    async function capture(name) {
      // Wait for React's pending layout effects, without depending on animations.
      await page.mouse.move(viewport.width - 5, 5);
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const geometry = await page.evaluate(() => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        overflow: [
          ...document.querySelectorAll(
            ".flow-page,.content-page,.browser-welcome,.modal",
          ),
        ].map((element) => ({
          name: element.className,
          width: element.clientWidth,
          scrollWidth: element.scrollWidth,
        })),
      }));
      assert.ok(
        geometry.documentWidth <= viewport.width + 1,
        `${name} page overflows at ${suffix}`,
      );
      for (const element of geometry.overflow)
        assert.ok(
          element.scrollWidth <= element.width + 1,
          `${name}: ${element.name} overflows at ${suffix}`,
        );
      measurements.push({ name, viewport, ...geometry });
      if (viewport.width > 640) {
        const pagesVisible = await page
          .locator(".session-list")
          .evaluate((list) => {
            const bounds = list.getBoundingClientRect();
            return [...list.querySelectorAll(".session-item")].every(
              (item) =>
                item.getBoundingClientRect().bottom <= bounds.bottom + 1,
            );
          });
        assert.ok(
          pagesVisible,
          `Sidebar fixture pages are clipped in ${name} at ${suffix}`,
        );
      }
      const contrast = await page.evaluate(() => {
        const rgba = (value) => (value.match(/[\d.]+/g) || []).map(Number);
        const blend = (front, back) => {
          const alpha = front[3] ?? 1;
          return front
            .slice(0, 3)
            .map((value, index) => value * alpha + back[index] * (1 - alpha));
        };
        const background = (element) => {
          if (!element) return [255, 255, 255];
          return blend(
            rgba(getComputedStyle(element).backgroundColor),
            background(element.parentElement),
          );
        };
        const luminance = (color) =>
          color
            .slice(0, 3)
            .map((channel) => {
              const value = channel / 255;
              return value <= 0.04045
                ? value / 12.92
                : ((value + 0.055) / 1.055) ** 2.4;
            })
            .reduce(
              (sum, value, index) =>
                sum + value * [0.2126, 0.7152, 0.0722][index],
              0,
            );
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
        );
        const failures = [];
        let tested = 0;
        while (walker.nextNode()) {
          const node = walker.currentNode,
            element = node.parentElement;
          if (
            !node.textContent.trim() ||
            !element ||
            element.closest("[disabled], [aria-hidden='true'], script, style")
          )
            continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const rect = range.getBoundingClientRect();
          if (
            !rect.width ||
            !rect.height ||
            rect.top >= innerHeight ||
            rect.bottom <= 0
          )
            continue;
          let clipped = false;
          for (let parent = element; parent; parent = parent.parentElement) {
            if (/hidden|auto|scroll/.test(getComputedStyle(parent).overflowY)) {
              const bounds = parent.getBoundingClientRect();
              if (rect.top >= bounds.bottom || rect.bottom <= bounds.top)
                clipped = true;
            }
          }
          if (clipped) continue;
          const style = getComputedStyle(element),
            bg = background(element);
          const fg = blend(rgba(style.color), bg);
          const levels = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
          const ratio = (levels[0] + 0.05) / (levels[1] + 0.05);
          const large =
            parseFloat(style.fontSize) >= 24 ||
            (parseFloat(style.fontSize) >= 18.66 &&
              parseInt(style.fontWeight) >= 700);
          const minimum = large ? 3 : 4.5;
          tested++;
          if (ratio < minimum)
            failures.push({
              text: node.textContent.trim().slice(0, 70),
              ratio: +ratio.toFixed(2),
              minimum,
              className: element.className,
              foreground: style.color,
              background: bg,
            });
        }
        return { tested, failures };
      });
      contrastResults.push({ name, viewport, ...contrast });
      await page.screenshot({ path: `${output}/${name}-${suffix}.png` });
    }
    async function navigate(name) {
      if (viewport.width <= 640)
        await page
          .getByRole("button", { name: "打开导航菜单", exact: true })
          .click();
      await page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name, exact: typeof name === "string" })
        .click();
    }
    if (viewport.width <= 640) {
      const trigger = page.getByRole("button", {
        name: "打开导航菜单",
        exact: true,
      });
      await trigger.click();
      await page.keyboard.press("Escape");
      assert.equal(
        await trigger.evaluate((element) => element === document.activeElement),
        true,
      );
    }
    await page.locator(".operation-panel").waitFor({ state: "hidden" });
    if (viewport.width > 640) {
      const webviewHeight = await page
        .locator(".webview-area")
        .evaluate((element) => element.getBoundingClientRect().height);
      assert.ok(
        webviewHeight >= (viewport.height * 2) / 3,
        `Webpage receives less than two thirds of the window at ${suffix}`,
      );
    }
    await capture("workspace-live");
    const observerToggle = page.getByRole("button", {
      name: "页面观察",
      exact: true,
    });
    await observerToggle.click();
    await page.locator(".operation-panel").waitFor();
    assert.equal(await observerToggle.getAttribute("aria-expanded"), "true");
    await page.getByRole("button", { name: /^(读取|刷新)页面结构$/ }).waitFor();
    await page.locator(".snapshot-summary").waitFor();
    await page.getByRole("button", { name: "录制准备", exact: true }).waitFor();
    await page.waitForFunction(
      () => !document.querySelector(".record-start")?.disabled,
    );
    await capture("page-observer");
    await page
      .getByRole("button", { name: "关闭页面观察", exact: true })
      .click();
    await page.locator(".operation-panel").waitFor({ state: "hidden" });
    assert.equal(
      await observerToggle.evaluate(
        (element) => element === document.activeElement,
      ),
      true,
    );
    await page.getByRole("button", { name: "新建网页", exact: true }).click();
    await page.locator(".browser-welcome").waitFor();
    await capture("workspace");
    if (viewport.width <= 640) {
      await page
        .getByRole("button", { name: "打开导航菜单", exact: true })
        .click();
      await capture("navigation-menu");
      await page.keyboard.press("Escape");
    }
    // Both address shortcut and keyboard focus must work in the new-page state.
    await page.keyboard.press("Control+l");
    assert.equal(
      await page
        .getByRole("textbox", { name: "网站地址" })
        .evaluate((element) => element === document.activeElement),
      true,
    );
    await navigate(/^流程库/);
    await page.locator(".flow-card").waitFor();
    await page.getByRole("button", { name: "全部空间", exact: true }).click();
    await page.getByRole("button", { name: /待业务验证 发布文章/ }).waitFor();
    await capture("flows");
    const flowSearch = page.getByRole("textbox", {
      name: "搜索流程",
      exact: true,
    });
    await flowSearch.fill("不存在的流程");
    await page
      .getByRole("heading", { name: "没有匹配的流程", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("heading", { name: "这里还没有流程", exact: true })
        .count(),
      0,
    );
    await capture("flow-search-empty");
    await page
      .getByRole("button", { name: "清除搜索与筛选", exact: true })
      .click();
    await page.getByRole("button", { name: /待业务验证 发布文章/ }).waitFor();
    assert.equal(
      await flowSearch.evaluate((el) => el === document.activeElement),
      true,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "全部空间", exact: true })
        .getAttribute("aria-pressed"),
      "true",
    );
    await flowSearch.fill("发布");
    await page
      .getByRole("button", { name: "清除流程搜索", exact: true })
      .click();
    assert.equal(await flowSearch.inputValue(), "");
    assert.equal(
      await flowSearch.evaluate((el) => el === document.activeElement),
      true,
    );
    await flowSearch.fill("客户");
    await flowSearch.press("Escape");
    assert.equal(await flowSearch.inputValue(), "");
    await page.getByRole("button", { name: /待业务验证 发布文章/ }).waitFor();
    await page.getByRole("button", { name: /待业务验证 发布文章/ }).click();
    await page.locator(".flow-purpose").waitFor();
    assert.equal(
      await page
        .getByRole("heading", { name: "发布文章", exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
    );
    const detailReturn = await page
      .getByRole("button", { name: "返回流程列表", exact: true })
      .boundingBox();
    assert.ok(
      detailReturn && detailReturn.width >= 44 && detailReturn.height >= 44,
      `The workflow return control must retain a 44px hit area at ${suffix}`,
    );
    await page.waitForFunction(() =>
      document.querySelector(".breadcrumbs")?.textContent.includes("发布文章"),
    );
    assert.match(await page.locator(".breadcrumbs").innerText(), /客户管理/);
    assert.doesNotMatch(
      await page.locator(".breadcrumbs").innerText(),
      /内容发布/,
    );
    assert.match(
      await page.locator(".flow-detail-title").innerText(),
      /内容发布/,
    );
    assert.match(
      await page.getByRole("button", { name: /^切换业务空间/ }).innerText(),
      /客户管理/,
      "Viewing a work package must not switch the active workspace",
    );
    await capture("flow-detail");
    const flowOptions = page.locator(".flow-detail-options > summary");
    await flowOptions.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("combobox", { name: "归档版本" }).waitFor();
    await page
      .getByRole("button", { name: "导出工作包", exact: true })
      .waitFor();
    const menuTargets = await page
      .locator(
        ".flow-detail-actions button, .flow-detail-actions a, .flow-detail-actions select",
      )
      .evaluateAll((elements) =>
        elements.map((element) => ({
          name:
            element.textContent?.trim() || element.getAttribute("aria-label"),
          height: element.getBoundingClientRect().height,
        })),
      );
    for (const target of menuTargets) {
      assert.ok(
        target.height >= 44,
        `Workflow menu target ${target.name} is too short at ${suffix}`,
      );
    }
    await capture("flow-options");
    await page.getByRole("combobox", { name: "归档版本" }).focus();
    await page.keyboard.press("Escape");
    await page
      .getByRole("combobox", { name: "归档版本" })
      .waitFor({ state: "hidden" });
    assert.equal(
      await flowOptions.evaluate((el) => el === document.activeElement),
      true,
      "Dismissed workflow options must restore focus to their disclosure",
    );
    if (viewport.width >= 1100) {
      const outcome = await page.locator(".flow-result").boundingBox();
      assert.ok(
        outcome && outcome.y + outcome.height < viewport.height,
        `The short workflow's completion criteria must fit the initial desktop viewport at ${suffix}`,
      );
    } else {
      const headingStarts = await page
        .locator("#flow-inputs, #flow-procedure, #flow-judgement")
        .evaluateAll((elements) =>
          elements.map((element) => element.getBoundingClientRect().left),
        );
      assert.ok(
        Math.max(...headingStarts) - Math.min(...headingStarts) <= 1,
        `Workflow stages must share the narrow reading axis at ${suffix}`,
      );
      const steps = await page.locator(".flow-procedure").boundingBox();
      assert.ok(
        steps && steps.y < 580,
        `The short workflow's steps must be visible before preparation fills the narrow viewport at ${suffix}`,
      );
      const criterion = await page
        .locator(".flow-criteria > ul")
        .first()
        .boundingBox();
      assert.ok(
        criterion && criterion.y + criterion.height < viewport.height,
        `The short workflow's completion criterion must fit the narrow viewport at ${suffix}`,
      );
    }
    await flowOptions.click();
    await page
      .getByRole("navigation", { name: "流程章节" })
      .getByRole("link", { name: /操作|步骤/ })
      .click();
    assert.equal(
      await page.locator(".flow-detail-options").getAttribute("open"),
      null,
      "Selecting a chapter must dismiss the workflow options",
    );
    const procedureHeading = page.getByRole("heading", {
      name: "操作步骤",
      exact: true,
    });
    const procedureBounds = await procedureHeading.boundingBox();
    assert.ok(
      procedureBounds &&
        procedureBounds.y >= 0 &&
        procedureBounds.y < viewport.height,
      `Workflow section navigation does not reveal its target at ${suffix}`,
    );
    assert.equal(
      await procedureHeading.evaluate(
        (element) => element === document.activeElement,
      ),
      true,
      "Section navigation must move keyboard focus to its heading",
    );
    await page.getByRole("link", { name: "核对条件", exact: true }).click();
    const judgementHeading = page.getByRole("heading", {
      name: "判断条件",
      exact: true,
    });
    assert.equal(
      await judgementHeading.evaluate((el) => el === document.activeElement),
      true,
      "The pending validation action must reveal and focus its criteria",
    );
    const criteria = page.locator(".flow-criteria");
    const firstCriterion = criteria.getByRole("checkbox").first();
    await criteria.locator(".flow-criterion-text").first().click();
    assert.equal(
      await firstCriterion.isChecked(),
      true,
      "The criterion text must share the checkbox hit area",
    );
    await criteria.locator(".flow-criterion-text").first().click();
    assert.equal(await firstCriterion.isChecked(), false);
    await firstCriterion.focus();
    await page.keyboard.press("Space");
    assert.equal(await firstCriterion.isChecked(), true);
    assert.equal(
      await firstCriterion.evaluate((el) => el === document.activeElement),
      true,
      "Checking a criterion must retain keyboard focus",
    );
    for (const checkbox of (await criteria.getByRole("checkbox").all()).slice(
      1,
    ))
      await checkbox.check();
    await criteria
      .getByRole("status")
      .filter({ hasText: "已核对 3 / 3" })
      .waitFor();
    assert.equal(await criteria.getAttribute("data-complete"), "true");
    assert.match(
      await page.locator(".archive-validation").innerText(),
      /待业务验证/,
    );
    assert.equal(
      await page.evaluate(() =>
        window.fixture.calls.some((call) =>
          ["flow_archive", "flow_create_archived"].includes(call.name),
        ),
      ),
      false,
      "Reading checks must not submit an archival or business validation result",
    );
    await capture("flow-criteria-checked");
    await flowOptions.click();
    await page.getByRole("button", { name: "JS 脚本", exact: true }).click();
    await page.getByRole("heading", { name: "JS 脚本", exact: true }).waitFor();
    assert.equal(
      await flowOptions.evaluate((el) => el === document.activeElement),
      true,
      "Switching reading content must close the menu and restore focus",
    );
    await capture("flow-scripts");
    await page.getByRole("link", { name: "核对条件", exact: true }).click();
    await judgementHeading.waitFor();
    assert.equal(await firstCriterion.isChecked(), false);
    assert.equal(
      await judgementHeading.evaluate((el) => el === document.activeElement),
      true,
      "Validation from the script view must restore the workflow and focus its criteria",
    );
    await flowOptions.click();
    await page.getByRole("button", { name: "原始记录", exact: true }).click();
    await page
      .getByRole("heading", { name: "原始记录", exact: true })
      .waitFor();
    await capture("flow-recordings");
    await flowOptions.click();
    await page.getByRole("button", { name: "流程说明", exact: true }).click();
    await page.locator(".flow-purpose").waitFor();
    await page
      .getByRole("button", { name: "返回流程列表", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("button", { name: /待业务验证 发布文章/ })
        .evaluate((el) => el === document.activeElement),
      true,
      "Returning must restore focus to the originating work package",
    );
    await page.getByRole("button", { name: /待 Agent 归档 新增客户/ }).click();
    await page
      .getByRole("button", { name: "复制归档任务", exact: true })
      .waitFor();
    const recordingSummary = page.getByRole("region", { name: "已记录操作" });
    await recordingSummary
      .getByText("填写 客户姓名", { exact: true })
      .waitFor();
    await recordingSummary.getByText("保存客户", { exact: true }).waitFor();
    assert.equal(
      await recordingSummary
        .locator(".recording-summary-limits")
        .getAttribute("open"),
      null,
    );
    await capture("flow-unarchived");
    if (viewport.width >= 1100) {
      const detail = await page
        .locator(".flow-detail-unarchived")
        .boundingBox();
      assert.ok(
        detail && detail.y + detail.height <= viewport.height,
        `The short recording's operations, handoff, source and card boundary must fit the initial desktop viewport at ${suffix}`,
      );
    }
    assert.equal(
      await page.locator(".archive-instructions").getAttribute("open"),
      null,
    );
    await page
      .getByRole("button", { name: "复制归档任务", exact: true })
      .click();
    await page
      .getByRole("button", { name: "已复制归档任务", exact: true })
      .waitFor();
    assert.ok(
      await page.evaluate(() =>
        window.fixture.clipboard.at(-1).includes("expectedRevision="),
      ),
      "Copied archive task must preserve its revision guard",
    );
    await capture("flow-task-copied");
    await page.evaluate(() => {
      window.fixture.clipboardFail = true;
    });
    await page
      .getByRole("button", { name: "已复制归档任务", exact: true })
      .click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Clipboard denied" })
      .waitFor();
    await page
      .getByRole("button", { name: "复制归档任务", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "已复制归档任务", exact: true })
        .count(),
      0,
      "A failed retry must clear the previous archive-copy confirmation",
    );
    await capture("flow-copy-failed");
    await page.getByRole("button", { name: "关闭错误", exact: true }).click();
    await page.evaluate(() => {
      window.fixture.clipboardFail = false;
    });
    await page.getByRole("button", { name: /^切换业务空间/ }).click();
    await page
      .getByRole("button", { name: "管理业务空间", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "业务空间", exact: true })
      .waitFor();
    await capture("spaces");
    await page.getByRole("button", { name: "编辑空间", exact: true }).click();
    await page.getByRole("dialog", { name: "编辑业务空间" }).waitFor();
    await capture("space-modal");
    await page.keyboard.press("Escape");
    await page
      .getByRole("dialog", { name: "编辑业务空间" })
      .waitFor({ state: "hidden" });
    await navigate("Agent 接入");
    const copyBounds = await page
      .getByRole("button", { name: "复制接入指令", exact: true })
      .boundingBox();
    assert.ok(
      copyBounds && copyBounds.y + copyBounds.height < viewport.height,
      `Agent connection action is below the initial viewport at ${suffix}`,
    );
    if (viewport.width <= 640)
      assert.ok(
        copyBounds.y + copyBounds.height < viewport.height / 2,
        `Agent connection action must fit in the first half of the narrow viewport at ${suffix}`,
      );
    if (viewport.width <= 640) {
      const limits = await page.locator(".agent-limits").boundingBox();
      assert.ok(
        limits && limits.y + limits.height < viewport.height,
        `Agent capability limits must be visible in the initial narrow viewport at ${suffix}`,
      );
    }
    await capture("agents");
    await page
      .getByRole("button", { name: "复制接入指令", exact: true })
      .click();
    await page.getByRole("status").waitFor();
    assert.match(await page.getByRole("status").innerText(), /发给你的 Agent/);
    await page
      .getByRole("button", { name: "已复制接入指令", exact: true })
      .waitFor();
    assert.equal(
      await page.locator(".toast").count(),
      0,
      "Setup copy feedback stays beside its action",
    );
    await capture("agents-copied");
    await navigate("配置");
    assert.equal(
      await page
        .getByRole("status")
        .filter({ hasText: /已复制/ })
        .count(),
      0,
      "Copy feedback must not follow navigation to another page",
    );
    await page.getByLabel("Jev API Key").waitFor();
    await capture("settings");
    await navigate("运行记录");
    await page.getByText("核对客户资料", { exact: true }).waitFor();
    await page.getByText("查看决策与操作记录", { exact: false }).click();
    await capture("history");
    await navigate("旧资料与回放");
    await capture("legacy");
    await navigate("网页工作区");
    // The fixture verifies management layout; the system WebView is checked in the native app.
    await page.getByRole("button", { name: /^切换业务空间/ }).click();
    await page
      .getByRole("dialog", { name: "切换业务空间", exact: true })
      .getByRole("button", { name: /客户管理/ })
      .click();
    await page.getByRole("button", { name: "录制准备", exact: true }).click();
    const draft = page.getByRole("form", { name: "录制对象", exact: true });
    assert.equal(
      await page
        .getByRole("button", { name: "收起录制准备", exact: true })
        .getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(
      await page.locator(".browser-shell .button.primary").count(),
      1,
      "Recording preparation must expose a single primary submission",
    );
    await draft.waitFor();
    await page.waitForFunction(() => window.fixture.layouts.at(-1).visible);
    assert.match(await draft.innerText(), /客户列表/);
    assert.equal(
      await page.getByRole("dialog", { name: "录制对象", exact: true }).count(),
      0,
    );
    assert.equal(
      await draft
        .getByRole("textbox", { name: /流程名称/ })
        .evaluate((element) => element === document.activeElement),
      true,
    );
    await capture("recording-setup");
    await page.keyboard.press("Escape");
    await draft.waitFor({ state: "hidden" });
    assert.equal(
      await page
        .getByRole("button", { name: "录制准备", exact: true })
        .evaluate((element) => element === document.activeElement),
      true,
    );
    await page.close();
    console.log(
      `PASS: ${suffix} — layout, address shortcut, navigation, copy, modal focus and dismissal`,
    );
  }
  assert.deepEqual(errors, []);
  await writeFile(
    `${output}/measurements.json`,
    JSON.stringify({ errors, measurements }, null, 2),
  );
  await writeFile(
    `${output}/contrast.json`,
    JSON.stringify(contrastResults, null, 2),
  );
  const contrastFailures = contrastResults.flatMap(
    ({ name, viewport, failures }) =>
      failures.map((failure) => ({ name, width: viewport.width, ...failure })),
  );
  assert.deepEqual(
    contrastFailures,
    [],
    "Visible text must meet WCAG AA contrast",
  );
} finally {
  await browser.close();
  await server.close();
}
