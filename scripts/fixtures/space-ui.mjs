// Isolated in-memory IPC fixture. Never connects to the real app.
export function initializeSpaceFixture({
  includeJev = false,
  delayedLayouts = false,
} = {}) {
  localStorage.setItem("selected-domain", "sales");
  const now = new Date().toISOString();
  const domains = [
    {
      id: "sales",
      name: "客户管理",
      description: "维护客户资料",
      websites: [
        {
          id: "site-sales",
          name: "客户后台",
          entryUrl: "https://sales.example",
        },
      ],
      updatedAt: now,
    },
    {
      id: "content",
      name: "内容发布",
      description: "管理内容",
      websites: [],
      updatedAt: now,
    },
  ];
  const sessions = [
    {
      id: "sales-1",
      domainId: "sales",
      title: "客户列表",
      url: "https://sales.example/list",
      status: "ready",
      createdAt: now,
    },
    {
      id: "sales-2",
      domainId: "sales",
      title: "客户详情",
      url: "https://sales.example/details",
      status: "ready",
      createdAt: now,
    },
    {
      id: "content-1",
      domainId: "content",
      title: "内容编辑",
      url: "https://content.example/edit",
      status: "ready",
      createdAt: now,
    },
    {
      id: "unassigned",
      title: "旧网页",
      url: "https://old.example",
      status: "ready",
      createdAt: now,
    },
  ];
  const flows = [
    {
      id: "flow-sales",
      domainId: "sales",
      name: "新增客户",
      archiveState: "unarchived",
      origin: "human_recording",
      recordingIds: ["raw-sales"],
      revision: 1,
      tags: [],
      description: "",
      updatedAt: now,
    },
    {
      id: "flow-content",
      domainId: "content",
      name: "发布文章",
      archiveState: "archived",
      origin: "agent_generated",
      recordingIds: [],
      revision: 1,
      tags: [],
      description: "",
      updatedAt: now,
    },
  ];
  window.fixture = {
    domains,
    sessions,
    flows,
    active: "sales-1",
    calls: [],
    layouts: [],
    pendingLayouts: 0,
    appliedLayout: null,
    recordings: [],
    clipboard: [],
    clipboardFail: false,
    connectionReady: true,
    jevSettings: {
      provider: "typesafe",
      model: "jev-latest",
      minConfidence: 0.65,
      enabledDomainIds: [],
      credentials: { typesafe: false, openrouter: false },
    },
  };
  Object.defineProperty(navigator, "clipboard", {
    value: {
      async writeText(text) {
        if (window.fixture.clipboardFail) throw new Error("Clipboard denied");
        window.fixture.clipboard.push(text);
      },
    },
  });
  window.isTauri = true;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback() {
      return 1;
    },
    async invoke(command, payload) {
      if (command.startsWith("plugin:event|")) return 1;
      const state = window.fixture;
      if (command === "workspace_layout") {
        state.pendingLayouts++;
        if (delayedLayouts)
          await new Promise((resolve) =>
            setTimeout(resolve, payload.visible ? 5 : 180),
          );
        state.layouts.push(payload);
        state.appliedLayout = payload;
        state.pendingLayouts--;
        return;
      }
      if (includeJev && command === "jev_settings")
        return structuredClone(state.jevSettings);
      const { name, args } = payload;
      state.calls.push({ name, args });
      switch (name) {
        case "browser_list":
          return {
            sessions: structuredClone(sessions),
            activeSessionId: state.active,
          };
        case "browser_snapshot": {
          const session = sessions.find((s) => s.id === args.sessionId);
          return {
            url: session.url,
            title: session.title,
            text: "客户列表（界面检查样例）",
            elements: [
              {
                tag: "input",
                type: "search",
                label: "搜索客户",
                text: "",
                selector: "#search",
              },
              {
                tag: "button",
                label: "",
                text: "新增客户",
                selector: "#create",
              },
              {
                tag: "button",
                label: "",
                text: "查看客户详情",
                selector: "#details",
              },
            ],
          };
        }
        case "domain_list":
          return { domains: structuredClone(domains) };
        case "app_status":
          return {
            version: "0.2.2",
            endpoint: "http://127.0.0.1:9999",
            ...(state.connectionReady && {
              agentBinary:
                "/Applications/Auto Browser.app/Contents/MacOS/auto-browser-agent",
              skillPath:
                "/Applications/Auto Browser.app/Contents/Resources/skills/auto-browser/SKILL.md",
              dataPath:
                "/Users/test/Library/Application Support/dev.autobrowser.app",
              connectionPath:
                "/Users/test/Library/Application Support/dev.autobrowser.app/agent.json",
            }),
            capabilities: { jevDelegation: includeJev },
            sessionCount: sessions.length,
          };
        case "workflow_list":
          return { workflows: [] };
        case "guide_list":
          return { guides: [] };
        case "run_list":
        case "script_run_list":
          return { runs: [] };
        case "recording_list":
          return { recordings: state.recordings };
        case "flow_list": {
          await new Promise((resolve) =>
            setTimeout(resolve, args.domainId === "sales" ? 70 : 10),
          );
          const result = flows.filter(
            (f) =>
              (!args.domainId || f.domainId === args.domainId) &&
              (!args.archiveState || f.archiveState === args.archiveState) &&
              (!args.query || f.name.includes(args.query)),
          );
          return {
            flows: structuredClone(result.slice(0, args.limit)),
            total: result.length,
          };
        }
        case "flow_get": {
          const flow = flows.find((entry) => entry.id === args.flowId);
          return {
            flow: structuredClone(flow),
            archivedRevision:
              flow.archiveState === "archived"
                ? {
                    id: "revision-content-1",
                    version: 1,
                    submittedBy: "示例 Agent",
                    sourceRecordingIds: [],
                    sourceNotes: "隔离界面夹具，仅供视觉和功能验证。",
                    scripts: [],
                    knowledge: {
                      purpose:
                        "在内容后台发布文章，核对标题、正文与可见的发布状态。",
                      inputs: [
                        {
                          name: "title",
                          label: "文章标题",
                          kind: "string",
                          required: true,
                        },
                        {
                          name: "body",
                          label: "文章正文",
                          kind: "string",
                          required: true,
                        },
                      ],
                      procedureMarkdown:
                        "1. 打开内容编辑页面，确认当前业务空间。\n2. 填写标题与正文，检查预览。\n3. 发布文章，返回列表并打开文章链接核对内容。",
                      judgementMarkdown:
                        "- 列表中的文章状态为已发布。\n- 文章页标题与输入一致。\n- 文章页正文与输入一致。",
                      prerequisitesMarkdown: "已登录内容后台，具有发布权限。",
                      exceptionsMarkdown:
                        "出现校验错误时停止提交，由用户核对。",
                      outputs: ["发布页面链接"],
                    },
                  }
                : null,
            revisions:
              flow.archiveState === "archived"
                ? [{ version: 1, submittedBy: "示例 Agent", scriptCount: 0 }]
                : [],
            recordings: flow.recordingIds.map((id) => ({
              id,
              flowId: flow.id,
              domainId: flow.domainId,
              sessionId: "sales-1",
              captureState: "completed",
              eventCount: 7,
              startedAt: now,
              limitations: [
                "当前录制覆盖顶层 DOM；iframe、Shadow DOM、文件内容和原生弹窗尚未采集",
              ],
              summary: {
                actionCount: 3,
                steps: [
                  { order: 1, kind: "input", label: "客户姓名" },
                  { order: 2, kind: "input", label: "邮箱" },
                  { order: 3, kind: "submit", label: "保存客户" },
                ],
                omittedActions: 0,
              },
            })),
          };
        }
        case "domain_update": {
          const space = domains.find((d) => d.id === args.domainId);
          Object.assign(space, args);
          return structuredClone(space);
        }
        case "domain_create": {
          const space = {
            id: `created-${domains.length}`,
            ...args,
            updatedAt: now,
          };
          domains.push(space);
          return structuredClone(space);
        }
        case "browser_focus":
          state.active = args.sessionId;
          return {};
        case "browser_open": {
          const session = {
            id: `opened-${sessions.length}`,
            domainId: args.domainId,
            title: "新网页",
            url: args.url,
            status: "ready",
            createdAt: now,
          };
          sessions.push(session);
          state.active = session.id;
          return structuredClone(session);
        }
        case "browser_bind_domain":
          sessions.find((s) => s.id === args.sessionId).domainId =
            args.domainId;
          return {};
        case "recording_start": {
          state.recordings.push({
            id: "record-test",
            domainId: args.domainId,
            sessionId: args.sessionId,
            captureState: "recording",
            startedAt: now,
            eventCount: 0,
          });
          return {};
        }
        case "recording_status":
          return { recorder: { lastError: null } };
        case "browser_delegate_list":
          return {
            tasks: includeJev
              ? [
                  {
                    id: "review-task",
                    sessionId: "previous-page",
                    domainId: "sales",
                    goal: "核对客户资料",
                    provider: "typesafe",
                    model: "jev-latest",
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
                        action: "打开客户列表",
                        executed: true,
                        apiMs: 500,
                      },
                    ],
                  },
                ]
              : [],
          };
        default:
          throw new Error(`Unexpected test tool: ${name}`);
      }
    },
  };
}
