import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const dataRoot =
  platform() === "darwin"
    ? join(homedir(), "Library/Application Support")
    : platform() === "win32"
      ? process.env.APPDATA
      : process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
const path =
  process.env.AUTO_BROWSER_CONNECTION ||
  join(dataRoot, "dev.autobrowser.app", "agent.json");
const connection = JSON.parse(await readFile(path, "utf8"));
async function call(name, args = {}) {
  const response = await fetch(connection.endpoint + "/call", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, arguments: args }),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(result.error);
  return result.result;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitRun(id) {
  for (let i = 0; i < 100; i++) {
    const run = await call("run_get", { runId: id });
    if (!["running", "paused", "stopping"].includes(run.status)) return run;
    await sleep(150);
  }
  throw new Error("任务超时");
}
const status = await call("app_status");
assert.equal(status.capabilities.nativeInput, false);
assert.equal((await fetch(connection.endpoint + "/tools")).status, 401);
assert.equal(
  (
    await fetch(connection.endpoint + "/tools", {
      headers: {
        Authorization: `Bearer ${connection.token}`,
        Origin: "https://example.com",
      },
    })
  ).status,
  401,
);
console.log("PASS local authentication and capability reporting");
const session = await call("browser_open", { url: "auto-browser://demo" });
let guideId;
try {
  let snapshot;
  for (let i = 0; i < 60; i++) {
    try {
      snapshot = await call("browser_snapshot", { sessionId: session.id });
      if (snapshot.elements.some((e) => e.label === "客户姓名")) break;
    } catch {}
    await sleep(150);
  }
  assert.ok(snapshot.elements.some((e) => e.label === "客户姓名"));
  console.log("PASS native WKWebView page load and DOM snapshot");
  const guide = JSON.parse(
    await readFile(
      new URL("../examples/customer-guide.json", import.meta.url),
      "utf8",
    ),
  );
  const runCount = (await call("run_list")).runs.length;
  const savedGuide = await call("guide_save", {
    guide: { ...guide, id: "", name: "原生指南读写测试" },
  });
  guideId = savedGuide.id;
  const revised = await call("guide_save", {
    guide: {
      ...savedGuide,
      content: savedGuide.content + "\n\n补充：以实际页面为准。",
    },
  });
  assert.equal(revised.version, 2);
  const metadata = await call("guide_list", {
    query: "原生指南读写",
    domain: "127.0.0.1",
  });
  assert.equal(metadata.guides.length, 1);
  assert.equal(metadata.guides[0].version, 2);
  assert.equal("content" in metadata.guides[0], false);
  assert.equal(
    (
      await call("guide_list", {
        query: "原生指南读写",
        domain: "unrelated.example",
      })
    ).guides.length,
    0,
  );
  const readGuide = await call("guide_get", { guideId });
  assert.equal(readGuide.content, revised.content);
  assert.equal("steps" in readGuide, false);
  assert.equal((await call("run_list")).runs.length, runCount);
  assert.equal(
    (await call("browser_snapshot", { sessionId: session.id })).elements.find(
      (e) => e.label === "客户姓名",
    ).value,
    "",
  );
  console.log(
    "PASS guide search, latest version and Markdown read without browser actions or script runs",
  );
  const workflows = await call("workflow_list");
  const flow = workflows.workflows.find((w) => w.id === "demo-customer");
  for (const [name, email] of [
    ["张三", "zhang@example.com"],
    ["李四", "li@example.com"],
    ["王五", "wang@example.com"],
  ]) {
    const { runId } = await call("workflow_run", {
      workflowId: flow.id,
      sessionId: session.id,
      inputs: { name, email },
    });
    const run = await waitRun(runId);
    assert.equal(run.status, "succeeded", JSON.stringify(run));
    assert.equal(run.events.at(-1).result.verified, true);
  }
  console.log(
    "PASS parameterized workflow and completion verification with three datasets",
  );
  const broken = {
    ...flow,
    id: "",
    name: "失败断言测试",
    completion: {
      kind: "assert_text",
      value: "never-present-value",
      description: "故意失败的断言",
    },
  };
  const saved = await call("workflow_save", { workflow: broken });
  const failed = await call("workflow_run", {
    workflowId: saved.id,
    sessionId: session.id,
    inputs: { name: "错误测试", email: "error@example.com" },
  });
  assert.equal((await waitRun(failed.runId)).status, "failed");
  await call("workflow_delete", { workflowId: saved.id });
  console.log("PASS false success prevention");
  const stoppable = {
    ...flow,
    id: "",
    name: "停止测试",
    steps: [
      { kind: "wait", value: 1000, description: "等待边界" },
      ...flow.steps,
    ],
  };
  const savedStop = await call("workflow_save", { workflow: stoppable });
  const start = await call("workflow_run", {
    workflowId: savedStop.id,
    sessionId: session.id,
    inputs: { name: "停止测试", email: "stop@example.com" },
  });
  await call("run_control", { runId: start.runId, action: "pause" });
  assert.equal(
    (await call("run_get", { runId: start.runId })).status,
    "paused",
  );
  await assert.rejects(
    call("workflow_run", {
      workflowId: savedStop.id,
      sessionId: session.id,
      inputs: { name: "互斥", email: "mutex@example.com" },
    }),
    /占用/,
  );
  await call("run_control", { runId: start.runId, action: "stop" });
  assert.equal((await waitRun(start.runId)).status, "stopped");
  await call("workflow_delete", { workflowId: savedStop.id });
  console.log("PASS pause, stop and per-session mutual exclusion");
  const transport = new StdioClientTransport({
    command: status.agentBinary,
    args: ["mcp"],
    env: process.env.AUTO_BROWSER_CONNECTION
      ? { AUTO_BROWSER_CONNECTION: process.env.AUTO_BROWSER_CONNECTION }
      : undefined,
  });
  const client = new Client({ name: "smoke-client", version: "1.0.0" });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((t) => t.name === "browser_snapshot"));
  assert.ok(tools.tools.some((t) => t.name === "guide_get"));
  const mcpGuide = await client.callTool({
    name: "guide_get",
    arguments: { guideId },
  });
  assert.equal(mcpGuide.isError, false);
  assert.equal(mcpGuide.structuredContent.content, revised.content);
  const mcpResult = await client.callTool({
    name: "browser_snapshot",
    arguments: { sessionId: session.id },
  });
  assert.equal(mcpResult.isError, false);
  assert.ok(mcpResult.structuredContent.elements.length > 0);
  await client.close();
  console.log(
    "PASS official MCP SDK handshake, guide reading and native page observation",
  );
} finally {
  if (guideId) await call("guide_delete", { guideId });
  await call("browser_close", { sessionId: session.id });
}
console.log("All native smoke checks passed.");
