// Isolated preview verification. Uses synthetic local pages; no Jev API call.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (!process.env.AUTO_BROWSER_CONNECTION?.includes("dev.autobrowser.preview"))
  throw new Error(
    "Run against the isolated preview using AUTO_BROWSER_CONNECTION",
  );
const connection = JSON.parse(
  await readFile(process.env.AUTO_BROWSER_CONNECTION, "utf8"),
);
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
  if (!result.ok) throw Error(result.error);
  return result.result;
}
const status = await call("app_status");
assert.equal(status.capabilities.jevDelegation, true);
const jev = await call("jev_status");
assert.deepEqual(jev.enabledDomainIds, []);
assert.ok(!JSON.stringify(jev).toLowerCase().includes("apikey"));
const client = new Client({
  name: "Jev preview verification",
  version: "1.0.0",
});
await client.connect(
  new StdioClientTransport({
    command: status.agentBinary,
    args: ["mcp"],
    env: {
      ...process.env,
      AUTO_BROWSER_CONNECTION: process.env.AUTO_BROWSER_CONNECTION,
    },
  }),
);
let session;
try {
  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const name of [
    "jev_status",
    "browser_delegate_start",
    "browser_delegate_get",
    "browser_delegate_list",
    "browser_delegate_stop",
  ])
    assert.ok(tools.includes(name));
  assert.ok(!tools.includes("jev_save_settings"));
  assert.ok(!tools.includes("jev_remove_credential"));
  await assert.rejects(
    () => call("jev_save_settings", { apiKey: "not-a-real-key" }),
    /未知|不支持/,
  );
  const domain = await call("domain_create", {
    name: "Jev 原生验证",
    websites: [],
  });
  session = await call("browser_open", {
    url: "auto-browser://demo",
    domainId: domain.id,
  });
  let snapshot;
  for (let i = 0; i < 60; i++) {
    try {
      snapshot = await call("browser_snapshot", { sessionId: session.id });
      if (snapshot.readyState === "complete" && snapshot.elements.length) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(snapshot.documentId);
  assert.ok(snapshot.scroll);
  // Run with the workspace hidden to cover WKWebView's suspended frame callbacks.
  let nativePage;
  for (let i = 0; i < 30; i++) {
    nativePage = (await call("browser_list")).sessions.find(
      (s) => s.id === session.id,
    );
    if (nativePage?.status === "ready") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(
    nativePage?.status,
    "ready",
    "DOM-ready hidden pages must leave loading",
  );
  await assert.rejects(
    () =>
      call("browser_delegate_start", {
        sessionId: session.id,
        goal: "打开客户列表",
        allowedOrigins: [new URL(snapshot.url).origin],
      }),
    /尚未.*启用/,
  );
  await assert.rejects(
    () =>
      call("browser_delegate_start", {
        sessionId: session.id,
        goal: "打开客户列表",
        allowedOrigins: [snapshot.url],
      }),
    /完整 origin/,
  );
  const bridge = await readFile(
    new URL("../src-tauri/src/bridge.js", import.meta.url),
    "utf8",
  );
  const guard = await readFile(
    new URL("../src-tauri/src/jev_action.js", import.meta.url),
    "utf8",
  );
  const content = `const bridge=(${bridge}); const guard=(${guard});
    const snapshot=JSON.parse(bridge({kind:'snapshot'}));
    const blocked=[];
    for(const command of ['jev_settings','jev_save_settings','jev_remove_credential']) {
      try { await window.__TAURI_INTERNALS__.invoke(command,{}); blocked.push(false); } catch(e) {blocked.push(true);}
    }
    const target=document.querySelector('#name'); target.value='状态已变化';
    const rejected=JSON.parse(guard({snapshot,action:{kind:'click',target:{selector:'button[type="submit"]'}}},bridge));
    const fresh=JSON.parse(bridge({kind:'snapshot'}));
    const executed=JSON.parse(guard({snapshot:fresh,action:{kind:'click',target:{selector:'#updates'}}},bridge));
    return {blocked,rejected:rejected.error,executed:executed.ok,checked:document.querySelector('#updates').checked};`;
  const created = await call("flow_create_archived", {
    domainId: domain.id,
    name: "Jev 快照与权限验证",
    submittedBy: "Preview test",
    knowledge: {
      purpose: "本地验证",
      inputs: [],
      procedureMarkdown: "验证同次 DOM 检查及远程权限",
      judgementMarkdown: "校验返回结果",
      prerequisitesMarkdown: "练习页面",
      exceptionsMarkdown: "仅测试",
      outputs: [],
    },
    scripts: [
      {
        id: "guard",
        name: "快照与权限",
        description: "仅本地演示页面",
        content,
        inputs: [],
        usageMarkdown: "原生测试",
      },
    ],
  });
  const run = await call("flow_script_run", {
    flowId: created.flow.id,
    version: 1,
    scriptId: "guard",
    sessionId: session.id,
    inputs: {},
  });
  let result;
  for (let i = 0; i < 100; i++) {
    result = await call("script_run_get", { scriptRunId: run.scriptRunId });
    if (result.finishedAt) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(result.status, "succeeded");
  assert.equal(result.result.ok, true);
  assert.deepEqual(result.result.data, {
    blocked: [true, true, true],
    rejected: "JEV_STALE_STATE",
    executed: true,
    checked: true,
  });
  const list = await client.callTool({
    name: "browser_delegate_list",
    arguments: {},
  });
  assert.equal(list.isError, false);
  console.log(
    "PASS: native Jev MCP discovery, disabled-space boundary, origin validation, WKWebView atomic guard and remote configuration permission denial; no provider request",
  );
} finally {
  if (session) await call("browser_close", { sessionId: session.id });
  await client.close();
}
