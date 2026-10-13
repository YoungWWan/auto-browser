import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const server = await createServer({ server: { port: 0 }, logLevel: "error" });
await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 940 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    localStorage.setItem("selected-domain", "sales");
    const now = new Date().toISOString();
    const settings = {
      provider: "typesafe",
      model: "jev-latest",
      minConfidence: 0.65,
      enabledDomainIds: [],
    };
    const credentials = { typesafe: false, openrouter: false };
    const domains = ["sales", "content"].map((id, i) => ({
      id,
      name: i ? "内容发布" : "客户管理",
      description: "",
      websites: [],
      updatedAt: now,
    }));
    const tasks = [
      {
        id: "done",
        sessionId: "web",
        domainId: "sales",
        goal: "打开客户列表",
        provider: "typesafe",
        model: "jev-1",
        status: "needs_verification",
        startedAt: now,
        finishedAt: now,
        elapsedMs: 1250,
        apiMs: 500,
        inputTokens: 100,
        outputTokens: 2,
        events: [
          {
            at: now,
            choice: "a0",
            confidence: 0.9,
            action: "点击客户列表",
            executed: true,
            apiMs: 500,
          },
        ],
      },
      {
        id: "foreign",
        sessionId: "other",
        domainId: "content",
        goal: "其他空间的任务",
        provider: "typesafe",
        model: "jev-1",
        status: "running",
        startedAt: now,
        finishedAt: null,
        elapsedMs: 0,
        apiMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        events: [],
      },
    ];
    window.fixture = { calls: [], commands: [], settings, credentials, tasks };
    window.isTauri = true;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      transformCallback() {
        return 1;
      },
      async invoke(command, payload) {
        if (
          command.startsWith("plugin:event|") ||
          command === "workspace_layout"
        )
          return 1;
        const f = window.fixture;
        if (command.startsWith("jev_")) {
          f.commands.push({ command, payload: structuredClone(payload) });
          if (command === "jev_settings")
            return { ...f.settings, credentials: { ...f.credentials } };
          if (command === "jev_save_settings") {
            if (
              !payload.apiKey &&
              payload.settings.enabledDomainIds.length &&
              !f.credentials[payload.settings.provider]
            )
              throw new Error("启用空间前需要保存该供应商的 API Key");
            if (payload.apiKey) f.credentials[payload.settings.provider] = true;
            Object.assign(f.settings, payload.settings);
            return { ...f.settings };
          }
          if (command === "jev_remove_credential") {
            f.credentials[payload.provider] = false;
            if (f.settings.provider === payload.provider)
              f.settings.enabledDomainIds = [];
            return { ...f.settings };
          }
          throw new Error(command);
        }
        const { name, args } = payload;
        f.calls.push({ name, args });
        switch (name) {
          case "app_status":
            return {
              version: "0.3.0",
              endpoint: "http://127.0.0.1:9999",
              capabilities: { jevDelegation: true },
              sessionCount: 0,
            };
          case "browser_list":
            return { sessions: [], activeSessionId: null };
          case "domain_list":
            return { domains };
          case "workflow_list":
            return { workflows: [] };
          case "guide_list":
            return { guides: [] };
          case "recording_list":
            return { recordings: [] };
          case "run_list":
          case "script_run_list":
            return { runs: [] };
          case "flow_list":
            return { flows: [], total: 0 };
          case "browser_delegate_list":
            return { tasks: structuredClone(f.tasks) };
          case "browser_delegate_stop": {
            const t = f.tasks.find((t) => t.id === args.taskId);
            t.status = "stopping";
            return { taskId: t.id, status: t.status };
          }
          default:
            throw new Error(`unexpected tool ${name}`);
        }
      },
    };
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.getByRole("button", { name: "Agent 接入", exact: true }).click();
  await page
    .getByRole("heading", { name: "Agent 接入", exact: true })
    .waitFor();
  assert.equal(await page.getByLabel("Jev API Key").count(), 0);
  assert.equal(await page.evaluate(() => window.fixture.commands.length), 0);
  await page.getByRole("button", { name: "配置", exact: true }).click();
  await page.getByRole("heading", { name: "配置", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Jev 快速网页操作" }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "复制接入指令", exact: true })
      .count(),
    0,
  );
  const key = page.getByLabel("Jev API Key");
  await key.waitFor();
  assert.equal(await key.getAttribute("type"), "password");
  assert.equal(
    await page
      .getByRole("checkbox", { name: "允许 Jev 操作「客户管理」" })
      .isChecked(),
    false,
  );
  await key.fill("synthetic-typesafe-key");
  await page.getByLabel("Jev 供应商").selectOption("openrouter");
  assert.equal(await key.inputValue(), "");
  assert.equal(
    await page.getByLabel("Jev 模型").inputValue(),
    "~typesafe/jev-latest",
  );
  await page
    .getByRole("checkbox", { name: "允许 Jev 操作「客户管理」" })
    .check();
  const save = page.getByRole("button", { name: "保存 Jev 配置" });
  await save.click();
  await page
    .getByRole("alert")
    .filter({ hasText: "启用空间前需要保存" })
    .waitFor();
  await key.fill("synthetic-openrouter-key");
  await save.click();
  await page.getByText("已保存在系统凭据库", { exact: true }).waitFor();
  assert.equal(await key.inputValue(), "");
  const payload = await page.evaluate(
    () =>
      window.fixture.commands
        .filter((c) => c.command === "jev_save_settings")
        .at(-1).payload,
  );
  assert.deepEqual(payload.settings.enabledDomainIds, ["sales"]);
  assert.equal(payload.apiKey, "synthetic-openrouter-key");
  assert.equal(
    (await page.evaluate(() => window.fixture.calls)).some((c) =>
      JSON.stringify(c).includes("synthetic-openrouter-key"),
    ),
    false,
  );
  await save.click();
  await page.waitForFunction(
    () =>
      window.fixture.commands
        .filter((c) => c.command === "jev_save_settings")
        .at(-1).payload.apiKey === null,
  );
  assert.equal(
    await page.getByText("打开客户列表", { exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "运行记录", exact: true }).click();
  assert.equal(
    await page.getByText("等待 Agent 核查 · TypeSafe", { exact: true }).count(),
    1,
  );
  assert.equal(
    await page.getByText("其他空间的任务", { exact: true }).count(),
    0,
  );
  await page.getByText("查看决策与操作记录", { exact: false }).click();
  await page.getByText("点击客户列表", { exact: true }).waitFor();
  await page.evaluate(() =>
    window.fixture.tasks.unshift({
      id: "running",
      sessionId: "web",
      domainId: "sales",
      goal: "继续打开详情",
      provider: "openrouter",
      model: "jev-1",
      status: "running",
      finishedAt: null,
      startedAt: new Date().toISOString(),
      elapsedMs: 0,
      apiMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      events: [],
    }),
  );
  const stop = page.getByRole("button", { name: "停止委派", exact: true });
  await stop.waitFor();
  await stop.click();
  await page.getByRole("button", { name: "正在停止", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "正在停止", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "配置", exact: true }).click();
  await page.getByRole("button", { name: "移除 API Key" }).click();
  await page.getByText("尚未配置", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("checkbox", { name: "允许 Jev 操作「客户管理」" })
      .isChecked(),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: independent Settings navigation, Agent connection separation, history navigation; Jev UI — opt-in, masked key, provider switch, missing key, save/preserve/remove, scoped history, stop and independent verification",
  );
} finally {
  await browser.close();
  await server.close();
}
