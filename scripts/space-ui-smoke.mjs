// Management UI regression using an isolated IPC fixture; native WebView layout
// is additionally checked in the desktop preview, not simulated by this test.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import { initializeSpaceFixture } from "./fixtures/space-ui.mjs";

const server = await createServer({
  server: { port: 0, strictPort: false },
  logLevel: "error",
});
await server.listen();
const address = server.httpServer.address();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 940 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.addInitScript(initializeSpaceFixture);
  await page.goto(`http://127.0.0.1:${address.port}`);
  const picker = page.getByRole("button", { name: /^切换业务空间：/ });
  const state = () => page.evaluate(() => window.fixture);
  const menu = page.getByRole("dialog", { name: "切换业务空间", exact: true });
  async function choose(name) {
    await picker.click();
    await menu.getByRole("button", { name, exact: false }).click();
    await menu.waitFor({ state: "hidden" });
    await picker.filter({ hasText: name }).waitFor();
  }
  await page.getByRole("button", { name: /客户列表/ }).waitFor();
  assert.equal(await page.getByRole("button", { name: /内容编辑/ }).count(), 0);
  assert.equal(await page.getByRole("button", { name: /旧网页/ }).count(), 0);
  await page.getByRole("button", { name: /客户详情/ }).click();
  await choose("内容发布");
  await page.getByRole("button", { name: /内容编辑/ }).waitFor();
  assert.equal(await page.getByRole("button", { name: /客户列表/ }).count(), 0);
  await choose("客户管理");
  await page.waitForFunction(() => window.fixture.active === "sales-2");
  await choose("客户管理");
  assert.equal(
    await page.getByRole("textbox", { name: "网站地址" }).inputValue(),
    "https://sales.example/details",
    "Re-selecting the current space must retain the current page address",
  );
  assert.deepEqual(
    (await state()).sessions.slice(0, 3).map((s) => s.domainId),
    ["sales", "sales", "content"],
  );
  assert.equal(
    (await state()).calls.some((c) => c.name === "browser_bind_domain"),
    false,
  );
  console.log(
    "PASS: space switching scopes pages, restores last page and preserves ownership",
  );

  await page.getByRole("button", { name: /^流程库/ }).click();
  await page.getByRole("button", { name: /待 Agent 归档 新增客户/ }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: /待业务验证 发布文章/ }).count(),
    0,
  );
  await page.getByRole("button", { name: "全部空间", exact: true }).click();
  await page.getByRole("button", { name: /待业务验证 发布文章/ }).waitFor();
  assert.match(await picker.innerText(), /客户管理/);
  await choose("内容发布");
  await page.getByRole("button", { name: /待业务验证 发布文章/ }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: /待 Agent 归档 新增客户/ }).count(),
    0,
  );
  console.log(
    "PASS: all-space flow discovery leaves working space unchanged; switching resets scope",
  );

  await picker.click();
  await menu.getByRole("button", { name: "管理业务空间" }).click();
  await page.getByRole("heading", { name: "业务空间", exact: true }).waitFor();
  await page.getByRole("button", { name: /客户管理 1 个网站/ }).click();
  await page.getByRole("button", { name: "编辑空间", exact: true }).click();
  const editor = page.getByRole("dialog", {
    name: "编辑业务空间",
    exact: true,
  });
  await editor.getByLabel("空间名称", { exact: true }).fill("客户资料管理");
  await editor.getByRole("button", { name: "保存修改", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  await page
    .getByRole("heading", { name: "客户资料管理", exact: true })
    .waitFor();
  assert.match(await picker.innerText(), /内容发布/);
  assert.equal((await state()).active, "content-1");
  await page.getByRole("button", { name: "进入业务空间", exact: true }).click();
  await picker.filter({ hasText: "客户资料管理" }).waitFor();
  assert.equal((await state()).active, "sales-2");
  console.log(
    "PASS: inspecting and editing a space does not switch it; explicit entry does",
  );

  // Opening a website in another space must remember the previous live page,
  // just like switching with the picker does.
  await picker.click();
  await menu.getByRole("button", { name: "管理业务空间" }).click();
  await page.getByRole("button", { name: /内容发布 0 个网站/ }).click();
  await page.getByRole("button", { name: "编辑空间", exact: true }).click();
  await editor.getByRole("button", { name: "添加网站入口" }).click();
  await editor.getByRole("textbox", { name: "网站 1 名称" }).fill("内容后台");
  await editor
    .getByRole("textbox", { name: "网站 1 地址" })
    .fill("https://content.example");
  await editor.getByRole("button", { name: "保存修改", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "打开网站 内容后台", exact: true })
    .click();
  await picker.filter({ hasText: "内容发布" }).waitFor();
  const contentPage = (await state()).active;
  await choose("客户资料管理");
  await page.waitForFunction(() => window.fixture.active === "sales-2");
  await choose("内容发布");
  await page.waitForFunction((id) => window.fixture.active === id, contentPage);
  console.log(
    "PASS: website entry switches space and remembers both previous and newly opened pages",
  );

  await picker.click();
  await menu.getByRole("button", { name: "新建业务空间", exact: true }).click();
  const create = page.getByRole("dialog", {
    name: "新建业务空间",
    exact: true,
  });
  await create.getByLabel("空间名称", { exact: true }).fill("报销管理");
  await create.getByRole("button", { name: "创建并进入空间" }).click();
  await create.waitFor({ state: "hidden" });
  await picker.filter({ hasText: "报销管理" }).waitFor();
  await page.getByText("这个空间还没有网页", { exact: false }).waitFor();
  assert.equal((await state()).layouts.at(-1).visible, false);
  await page
    .getByRole("textbox", { name: "网站地址" })
    .fill("https://expense.example");
  await page.getByRole("button", { name: "打开网址", exact: true }).click();
  await page
    .locator(".session-item[aria-current='page']")
    .filter({ hasText: "expense.example" })
    .waitFor();
  const createdId = (await state()).domains.find(
    (d) => d.name === "报销管理",
  ).id;
  assert.equal((await state()).sessions.at(-1).domainId, createdId);
  const oldPages = (await state()).sessions.length;
  await page.getByRole("button", { name: "打开新网页", exact: true }).click();
  await page
    .getByRole("textbox", { name: "网站地址" })
    .fill("https://expense.example/new");
  await page.getByRole("button", { name: "打开网址", exact: true }).click();
  await page.waitForFunction(
    (count) => window.fixture.sessions.length === count + 1,
    oldPages,
  );
  assert.equal((await state()).sessions.at(-2).url, "https://expense.example");
  console.log(
    "PASS: create without websites, empty-space WebView hiding and new-page intent",
  );

  await picker.click();
  assert.equal((await state()).layouts.at(-1).visible, false);
  await page
    .getByRole("textbox", { name: "搜索业务空间", exact: true })
    .fill("不存在");
  await page.getByText("没有找到这个业务空间", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  assert.equal((await state()).layouts.at(-1).visible, true);
  await choose("全部业务空间");
  await page.getByRole("button", { name: /旧网页/ }).click();
  await page.getByRole("button", { name: "分配业务空间", exact: true }).click();
  const assign = page.getByRole("dialog", {
    name: "分配业务空间",
    exact: true,
  });
  await assign
    .getByRole("combobox", { name: "分配到业务空间", exact: true })
    .selectOption("sales");
  await assign.getByRole("button", { name: "分配并进入空间" }).click();
  await assign.waitFor({ state: "hidden" });
  await picker.filter({ hasText: "客户资料管理" }).waitFor();
  assert.equal(
    (await state()).sessions.find((s) => s.id === "unassigned").domainId,
    "sales",
  );
  assert.equal(
    (await state()).calls.filter((c) => c.name === "browser_bind_domain")
      .length,
    1,
  );
  await page.getByRole("button", { name: "录制准备", exact: true }).click();
  await page
    .getByRole("textbox", { name: "流程名称", exact: false })
    .fill("测试录制");
  await page.getByRole("button", { name: "开始录制", exact: true }).click();
  await page.getByText("录制中 · 0 条事件", { exact: true }).waitFor();
  assert.equal(
    (await state()).calls.filter((c) => c.name === "browser_bind_domain")
      .length,
    1,
  );
  assert.equal((await state()).recordings[0].domainId, "sales");
  assert.equal((await state()).recordings[0].sessionId, "unassigned");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: keyboard dismissal, explicit legacy-page assignment and recording ownership",
  );

  await page.getByRole("button", { name: "Agent 接入", exact: true }).click();
  assert.equal(await page.locator(".sidebar-bottom button").count(), 0);
  assert.equal(await page.locator(".topbar .shortcut").count(), 0);
  const copySetup = page.getByRole("button", {
    name: /^(已)?复制接入指令$/,
    exact: true,
  });
  assert.equal(await copySetup.isEnabled(), true);
  assert.equal(
    await page
      .getByRole("heading", { name: "添加 MCP 服务", exact: true })
      .count(),
    0,
  );
  const callsBeforeCopy = (await state()).calls.length;
  await copySetup.click();
  await page
    .getByRole("status")
    .filter({ hasText: "发给你的 Agent" })
    .waitFor();
  const instruction = (await state()).clipboard.at(-1);
  assert.equal(instruction.includes("\n"), false);
  assert.match(
    instruction,
    /只读调用 app_status、domain_list、browser_list、flow_list/,
  );
  // A slow runner can refresh while the clipboard UI settles. Exercise that
  // interval and reject operations beyond the app's existing read-only polling.
  await page.waitForFunction(
    (offset) =>
      window.fixture.calls.slice(offset).some((call) => call.name === "app_status"),
    callsBeforeCopy,
  );
  const backgroundReads = new Set([
    "browser_list",
    "workflow_list",
    "run_list",
    "app_status",
    "guide_list",
    "domain_list",
    "recording_list",
    "flow_list",
    "script_run_list",
    "recording_status",
  ]);
  assert.deepEqual(
    (await state()).calls
      .slice(callsBeforeCopy)
      .filter((call) => !backgroundReads.has(call.name)),
    [],
    "Copying setup instructions must not issue commands beyond background reads",
  );
  await page.getByText("查看接入指令", { exact: true }).click();
  assert.equal(
    await page.locator(".setup-instruction p").textContent(),
    instruction,
  );
  await page.getByText("手动配置 MCP、Skill 或 CLI", { exact: true }).click();
  await page
    .getByRole("button", { name: "复制 MCP 配置", exact: true })
    .click();
  const manualConfig = JSON.parse((await state()).clipboard.at(-1));
  assert.deepEqual(
    manualConfig,
    JSON.parse(instruction.match(/MCP 服务配置 (.*?) 合并到现有配置/)[1]),
  );
  await page
    .getByRole("button", { name: "复制 Skill 路径", exact: true })
    .click();
  assert.equal(
    (await state()).clipboard.at(-1),
    "/Applications/Auto Browser.app/Contents/Resources/skills/auto-browser/SKILL.md",
  );
  console.log(
    "PASS: one-sentence setup copies real paths, matches manual MCP and only copies text",
  );

  const copied = (await state()).clipboard.length;
  await page.evaluate(() => {
    window.fixture.clipboardFail = true;
  });
  await copySetup.click();
  await page.getByRole("alert").filter({ hasText: "复制失败" }).waitFor();
  assert.equal((await state()).clipboard.length, copied);
  assert.equal(await page.getByRole("status").count(), 0);
  console.log(
    "PASS: clipboard failure reports an error without success feedback",
  );

  await page.addInitScript(() => {
    window.fixture.connectionReady = false;
  });
  await page.reload();
  await page.getByRole("button", { name: "Agent 接入", exact: true }).click();
  assert.equal(await copySetup.isDisabled(), true);
  await page.getByText("手动配置 MCP、Skill 或 CLI", { exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "复制 MCP 配置", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "复制 Skill 路径", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByText("获取本机路径后即可复制。", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: missing runtime paths disable setup and manual copy actions",
  );
  const layoutPage = await browser.newPage({
    viewport: { width: 1440, height: 940 },
  });
  await layoutPage.addInitScript(initializeSpaceFixture, {
    delayedLayouts: true,
  });
  await layoutPage.goto(`http://127.0.0.1:${address.port}`);
  await layoutPage
    .getByRole("button", { name: "新建网页", exact: true })
    .click();
  await layoutPage.locator(".browser-welcome").waitFor();
  await layoutPage.getByRole("button", { name: /客户列表/ }).click();
  await layoutPage.locator(".webview-area.has-page").waitFor();
  await layoutPage.waitForFunction(
    () =>
      window.fixture.layouts.length >= 4 && window.fixture.pendingLayouts === 0,
  );
  assert.equal(
    await layoutPage.evaluate(() => window.fixture.appliedLayout.visible),
    true,
  );
  console.log(
    "PASS: delayed hide requests cannot override the latest visible workspace after rapid navigation",
  );
} finally {
  await browser.close();
  await server.close();
}
