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
const connection = JSON.parse(
  await readFile(
    process.env.AUTO_BROWSER_CONNECTION ||
      join(dataRoot, "dev.autobrowser.app", "agent.json"),
    "utf8",
  ),
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitScript(id) {
  for (let i = 0; i < 100; i++) {
    const run = await call("script_run_get", { scriptRunId: id });
    if (run.finishedAt) return run;
    await sleep(50);
  }
  throw Error("Script result timeout");
}
const status = await call("app_status");
assert.equal(status.capabilities.flowPackages, true);
const domain = await call("domain_create", {
  name: "MCP 工作包验证",
  websites: [{ id: "demo", name: "本地表单", entryUrl: "auto-browser://demo" }],
});
const session = await call("browser_open", {
  url: "auto-browser://demo",
  domainId: domain.id,
});
let client;
try {
  for (let i = 0; i < 60; i++) {
    try {
      if (
        (
          await call("browser_snapshot", { sessionId: session.id })
        ).elements.some((e) => e.label === "客户姓名")
      )
        break;
    } catch {}
    await sleep(100);
  }
  const recording = await call("recording_start", {
    domainId: domain.id,
    sessionId: session.id,
    name: "工具交互录制样本",
  });
  await call("browser_action", {
    sessionId: session.id,
    action: {
      kind: "fill",
      target: { label: "客户姓名" },
      value: "原始记录示例",
      description: "记录 Agent 交互",
    },
  });
  await call("browser_navigate", {
    sessionId: session.id,
    direction: "reload",
  });
  for (let i = 0; i < 60; i++) {
    try {
      if (
        (await call("browser_snapshot", { sessionId: session.id }))
          .readyState === "complete"
      )
        break;
    } catch {}
    await sleep(50);
  }
  await call("browser_action", {
    sessionId: session.id,
    action: {
      kind: "fill",
      target: { label: "客户姓名" },
      value: "跳转后继续录制",
      description: "继续记录",
    },
  });
  await call("recording_stop", { recordingId: recording.id });
  const raw = await call("recording_get", { recordingId: recording.id });
  assert.ok(raw.events.some((e) => e.value === "原始记录示例"));
  assert.equal(raw.captureState, "completed");
  assert.ok(raw.events.some((e) => e.kind === "navigation"));
  assert.ok(raw.events.some((e) => e.value === "跳转后继续录制"));
  assert.ok(raw.events.filter((e) => e.kind === "page_context").length >= 2);
  const unarchived = await call("flow_get", { flowId: recording.flowId });
  assert.equal(unarchived.flow.archiveState, "unarchived");
  assert.equal(unarchived.archivedRevision, null);
  assert.ok(
    (await call("flow_list")).flows.some((f) => f.id === recording.flowId),
  );
  console.log(
    "PASS Domain-bound recording, raw events and unarchived discovery",
  );
  client = new Client({ name: "flow-smoke", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: status.agentBinary,
      args: ["mcp"],
      env: process.env.AUTO_BROWSER_CONNECTION
        ? { AUTO_BROWSER_CONNECTION: process.env.AUTO_BROWSER_CONNECTION }
        : undefined,
    }),
  );
  const tools = await client.listTools();
  assert.ok(tools.tools.some((t) => t.name === "flow_create_archived"));
  assert.ok(tools.tools.some((t) => t.name === "recording_get"));
  const param = {
    name: "name",
    label: "客户姓名",
    kind: "string",
    required: true,
  };
  const knowledge = {
    purpose: "在本地练习页面新增客户",
    inputs: [param],
    procedureMarkdown: "观察网页，调用 fill 填写资料，检查后调用 save。",
    judgementMarkdown: "保存客户后检查真实成功消息。",
    outputs: ["创建结果"],
  };
  const scripts = [
    {
      id: "fill",
      name: "填写客户姓名",
      content:
        "const el=document.querySelector('#name');if(!el)throw Error('field missing');el.value=inputs.name;el.dispatchEvent(new Event('input',{bubbles:true}));return {name:el.value,received:inputs.name,url:location.href};",
      inputs: [param],
    },
    {
      id: "read",
      name: "异步读取",
      content:
        "await new Promise(resolve=>setTimeout(resolve,25));return {name:document.querySelector('#name').value};",
    },
    {
      id: "denied",
      name: "远程页面权限边界验证",
      content:
        "try{await window.__TAURI_INTERNALS__.invoke('tool_call',{name:'domain_list',args:{}});return {denied:false};}catch(e){return {denied:true,error:String(e)};}",
    },
    {
      id: "timeout",
      name: "超时占用验证",
      content: "await new Promise(()=>{});return true;",
    },
    { id: "broken", name: "语法错误验证", content: "return ) syntax;" },
  ];
  // This is a client using MCP, not an application-owned model.
  const result = await client.callTool({
    name: "flow_archive",
    arguments: {
      flowId: recording.flowId,
      expectedRevision: unarchived.flow.revision,
      submittedBy: "MCP smoke agent",
      knowledge,
      scripts,
    },
  });
  assert.equal(result.isError, false, JSON.stringify(result));
  const archived = result.structuredContent;
  assert.equal(archived.flow.id, recording.flowId);
  assert.equal(archived.archivedRevision.sourceRecordingIds[0], recording.id);
  assert.deepEqual(
    (await call("recording_get", { recordingId: recording.id })).events,
    raw.events,
  );
  await assert.rejects(
    call("flow_archive", {
      flowId: recording.flowId,
      expectedRevision: unarchived.flow.revision,
      submittedBy: "conflict",
      knowledge,
      scripts,
    }),
    /冲突/,
  );
  const get = await call("flow_get", { flowId: recording.flowId });
  assert.equal(get.archivedRevision.version, 1);
  assert.equal(get.archivedRevision.scripts.length, 5);
  assert.equal(get.archivedRevision.scripts[0].content, "");
  await assert.rejects(
    call("flow_script_run", {
      flowId: recording.flowId,
      version: 1,
      scriptId: "fill",
      sessionId: session.id,
      inputs: { name: 9 },
    }),
    /类型/,
  );
  // Literal JavaScript-looking input must stay data.
  const literal = "张三 ` ${window.bad=1} \\ newline\n";
  const run = await call("flow_script_run", {
    flowId: recording.flowId,
    version: 1,
    scriptId: "fill",
    sessionId: session.id,
    inputs: { name: literal },
  });
  const finished = await waitScript(run.scriptRunId);
  assert.equal(finished.status, "succeeded", JSON.stringify(finished));
  assert.equal(finished.result.data.received, literal);
  assert.equal(finished.result.data.name, literal.replaceAll("\n", ""));
  const asyncRun = await call("flow_script_run", {
    flowId: recording.flowId,
    version: 1,
    scriptId: "read",
    sessionId: session.id,
    inputs: {},
  });
  assert.equal(
    (await waitScript(asyncRun.scriptRunId)).result.data.name,
    literal.replaceAll("\n", ""),
  );
  const denied = await call("flow_script_run", {
    flowId: recording.flowId,
    version: 1,
    scriptId: "denied",
    sessionId: session.id,
    inputs: {},
  });
  assert.equal((await waitScript(denied.scriptRunId)).result.data.denied, true);
  const broken = await call("flow_script_run", {
    flowId: recording.flowId,
    version: 1,
    scriptId: "broken",
    sessionId: session.id,
    inputs: {},
  });
  assert.equal((await waitScript(broken.scriptRunId)).status, "failed");
  console.log(
    "PASS official MCP archive, original retention, conflict, typed/escaped inputs, asynchronous WebView JS and permission boundary",
  );
  const empty = await call("flow_create_archived", {
    domainId: domain.id,
    name: "Agent 从零生成",
    knowledge,
    submittedBy: "MCP smoke agent",
    scripts: [],
  });
  assert.deepEqual(empty.flow.recordingIds, []);
  const exported = await call("flow_export", { flowId: recording.flowId });
  const imported = await call("flow_import", {
    domainId: domain.id,
    package: exported,
  });
  const reexport = await call("flow_export", { flowId: imported.id });
  assert.notEqual(imported.id, recording.flowId);
  assert.equal(
    reexport.archivedRevisions[0].scripts[0].content,
    scripts[0].content,
  );
  assert.equal(
    reexport.archivedRevisions[0].sourceRecordingIds[0],
    reexport.recordings[0].id,
  );
  assert.deepEqual(reexport.recordings[0].events, raw.events);
  const foreign = await call("browser_open", { url: "auto-browser://demo" });
  try {
    await assert.rejects(
      call("flow_script_run", {
        flowId: recording.flowId,
        version: 1,
        scriptId: "read",
        sessionId: foreign.id,
        inputs: {},
      }),
      /业务空间/,
    );
  } finally {
    await call("browser_close", { sessionId: foreign.id });
  }
  console.log(
    "PASS generation without recording, package import/export with links and Domain target binding",
  );
  const timed = await call("flow_script_run", {
    flowId: recording.flowId,
    version: 1,
    scriptId: "timeout",
    sessionId: session.id,
    inputs: {},
    timeoutMs: 80,
  });
  await sleep(150);
  const uncertain = await call("script_run_get", {
    scriptRunId: timed.scriptRunId,
  });
  assert.equal(uncertain.status, "uncertain");
  assert.equal(uncertain.finishedAt, null);
  await assert.rejects(
    call("browser_action", {
      sessionId: session.id,
      action: {
        kind: "fill",
        target: { label: "客户姓名" },
        value: "retry",
        description: "must block",
      },
    }),
    /占用/,
  );
  await call("browser_navigate", {
    sessionId: session.id,
    direction: "reload",
  });
  assert.equal((await waitScript(timed.scriptRunId)).status, "uncertain");
  for (let i = 0; i < 60; i++) {
    try {
      if (
        (
          await call("browser_snapshot", { sessionId: session.id })
        ).elements.some((e) => e.label === "客户姓名")
      )
        break;
    } catch {}
    await sleep(100);
  }
  const after = await call("flow_script_run", {
    flowId: recording.flowId,
    version: 1,
    scriptId: "read",
    sessionId: session.id,
    inputs: {},
  });
  assert.equal((await waitScript(after.scriptRunId)).status, "succeeded");
  console.log(
    "PASS uncertain timeout holds lock, reload ends old document and permits new script",
  );
} finally {
  await client?.close();
  await call("browser_close", { sessionId: session.id });
}
console.log(
  "All Flow package smoke checks passed. Test assets retained in named MCP 工作包验证 Domain.",
);
