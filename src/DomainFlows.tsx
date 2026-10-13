import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import {
  Folder,
  FileCode2,
  Download,
  Upload,
  Copy,
  CheckCircle2,
  ChevronLeft,
  ArrowDown,
  ArrowRight,
  ChevronDown,
  Info,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { call } from "./api";
import { FlowJudgement } from "./FlowJudgement";
import type { Domain, Flow, FlowDetail, FlowScript } from "./flowTypes";
type Props = {
  domains: Domain[];
  selected: string;
  open: (url: string, domainId?: string) => Promise<void>;
  report: (text: string) => void;
  fail: (text: string) => void;
  describeDetail?: (context: { space: string; name: string } | null) => void;
};
const date = (s: string) =>
  new Date(s).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
const eventNames: Record<string, string> = {
  input: "输入",
  change: "修改字段",
  click: "点击",
  submit: "提交",
  key: "按键",
  navigation: "网页跳转",
  page_context: "页面上下文",
  page_change: "页面变化",
  page_leave: "离开页面",
  recording_end: "结束录制",
};
export function DomainFlows(p: Props) {
  const [showAll, setShowAll] = useState(false);
  const request = useRef(0);
  const scope = showAll ? "" : p.selected;
  const [flows, setFlows] = useState<Flow[]>([]),
    [filter, setFilter] = useState(""),
    [query, setQuery] = useState("");
  const [detail, setDetail] = useState<FlowDetail | null>(null),
    [script, setScript] = useState<FlowScript | null>(null);
  const [record, setRecord] = useState<{
    id: string;
    events: Record<string, unknown>[];
    totalEvents: number;
    nextOffset: number | null;
  } | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number>();
  const [copiedArchive, setCopiedArchive] = useState<string>();
  const [busy, setBusy] = useState(true),
    [tab, setTab] = useState("knowledge");
  const [listing, setListing] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const page = useRef<HTMLElement>(null);
  const detailTitle = useRef<HTMLHeadingElement>(null);
  const focusDetail = useRef(false);
  const returnToFlow = useRef<string | null>(null);
  const directoryScroll = useRef(0);
  const flowOptions = useRef<HTMLDetailsElement>(null);
  const requestedSection = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (detail && focusDetail.current) {
      if (page.current) page.current.scrollTop = 0;
      detailTitle.current?.focus({ preventScroll: true });
      focusDetail.current = false;
    } else if (!detail && returnToFlow.current) {
      if (page.current) page.current.scrollTop = directoryScroll.current;
      const origin = [
        ...(page.current?.querySelectorAll<HTMLButtonElement>(".flow-card") ||
          []),
      ].find((card) => card.dataset.flowId === returnToFlow.current);
      (origin || searchInput.current)?.focus({ preventScroll: true });
      returnToFlow.current = null;
    }
  }, [detail?.flow.id]);
  useEffect(() => {
    const id = requestedSection.current;
    if (!id) return;
    const heading = document.getElementById(id);
    heading?.scrollIntoView({ block: "nearest" });
    heading?.focus({ preventScroll: true });
    requestedSection.current = null;
  }, [tab]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (
        flowOptions.current &&
        !flowOptions.current.contains(event.target as Node)
      )
        flowOptions.current.open = false;
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  const domain = p.domains.find((d) => d.id === p.selected);
  const owner =
    p.domains.find((d) => d.id === detail?.flow.domainId)?.name || "业务空间";
  useEffect(() => {
    p.describeDetail?.(
      detail ? { space: owner, name: detail.flow.name } : null,
    );
    return () => p.describeDetail?.(null);
  }, [detail?.flow.id, detail?.flow.name, owner, p.describeDetail]);
  async function work(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      p.fail(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function reload(background = false) {
    const pending = ++request.current;
    if (!background) setListing(true);
    try {
      const result = await call<{ flows: Flow[] }>("flow_list", {
        ...(scope ? { domainId: scope } : {}),
        ...(filter ? { archiveState: filter } : {}),
        query: query.trim(),
        limit: 500,
      });
      if (request.current === pending) setFlows(result.flows);
    } finally {
      if (request.current === pending) setListing(false);
    }
  }
  useEffect(() => setShowAll(false), [p.selected]);
  useEffect(
    () => setCopiedArchive(undefined),
    [detail?.flow.id, detail?.flow.revision],
  );
  useEffect(() => {
    setDetail(null);
    setRecord(null);
    void work(reload);
  }, [scope, filter, query]);
  useEffect(() => {
    const timer = setInterval(() => {
      void reload(true).catch((e) => p.fail(String(e)));
    }, 2500);
    return () => clearInterval(timer);
  }, [scope, filter, query]);
  useEffect(() => {
    const fid = detail?.flow.id;
    if (!fid) return;
    let disposed = false;
    const timer = setInterval(() => {
      void call<FlowDetail>("flow_get", {
        flowId: fid,
        ...(selectedVersion ? { version: selectedVersion } : {}),
      })
        .then((d) => {
          if (!disposed) setDetail(d);
        })
        .catch((e) => p.fail(String(e)));
    }, 2000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [detail?.flow.id, selectedVersion]);
  async function read(f: Flow, version?: number) {
    if (!detail) {
      directoryScroll.current = page.current?.scrollTop || 0;
      focusDetail.current = true;
    }
    setSelectedVersion(version);
    setDetail(
      await call<FlowDetail>("flow_get", {
        flowId: f.id,
        ...(version ? { version } : {}),
      }),
    );
    setScript(null);
    setRecord(null);
  }
  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
  }
  const task = detail
    ? `请使用 Auto Browser MCP/Skill 处理流程 ${detail.flow.name}（flowId=${detail.flow.id}，业务空间 ID（domainId）=${detail.flow.domainId}）。先 flow_get，再分页 recording_get读取全部关联原始事件及页面上下文。整理操作目的、通用步骤、输入，将判断条件写成可逐项核对的列表；必要时提供 JavaScript 网页脚本。由你判断何时调用脚本。通过 flow_archive 提交新归档版本，expectedRevision=${detail.flow.revision}，保留原始记录关联。归档后不自动执行，不把归档视为业务验证。`
    : "";
  const procedureSteps =
    detail?.archivedRevision?.knowledge.procedureMarkdown
      .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "")
      .match(/^\d+[.)]\s+/gm)?.length || 0;
  return (
    <section className="flow-page" ref={page}>
      {!detail && (
        <div className="page-heading flow-index-heading">
          <div>
            <h1>流程库</h1>
            <p>
              {scope
                ? `「${domain?.name || "当前业务空间"}」里的操作记录与工作流程。`
                : "查看所有业务空间的操作记录与工作流程。"}
            </p>
          </div>
          <div className="flow-actions">
            <button
              className="button"
              aria-label="导入工作包"
              disabled={!p.selected || busy}
              title={
                !p.selected
                  ? "先切换到一个业务空间，再导入工作包"
                  : `导入到 ${domain?.name}`
              }
              onClick={() => input.current?.click()}
            >
              <Upload size={15} />
              <span>导入工作包</span>
            </button>
            <button
              className="button"
              aria-label="刷新"
              title="刷新流程列表"
              onClick={() => void work(reload)}
            >
              <RefreshCw size={15} aria-hidden="true" />
              <span>刷新</span>
            </button>
          </div>
        </div>
      )}
      <input
        ref={input}
        type="file"
        accept=".json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file)
            void work(async () => {
              if (file.size > 20000000) throw Error("工作包超过 20 MB");
              await call("flow_import", {
                domainId: p.selected,
                package: JSON.parse(await file.text()),
              });
              await reload();
              p.report("工作包已导入");
            });
        }}
      />
      {detail ? (
        <div
          className={`flow-detail${detail.archivedRevision ? "" : " flow-detail-unarchived"}`}
        >
          <div className="flow-detail-heading">
            <div className="flow-detail-title">
              <button
                className="button small"
                aria-label="返回流程列表"
                title="返回流程列表"
                onClick={() => {
                  returnToFlow.current = detail.flow.id;
                  setDetail(null);
                  setRecord(null);
                  setScript(null);
                  void work(reload);
                }}
              >
                <ChevronLeft size={14} />
              </button>
              <div className="flow-title-content">
                <h1 ref={detailTitle} tabIndex={-1}>
                  {detail.flow.name}
                </h1>
                <p className="flow-detail-owner">
                  <Folder size={14} aria-hidden="true" />
                  <span>所属空间</span>
                  <strong>{owner}</strong>
                  <span className="flow-archive-state">
                    ·{" "}
                    {detail.flow.archiveState === "archived"
                      ? "已归档"
                      : "未归档"}
                  </span>
                  {detail.flow.domainId !== p.selected && (
                    <span className="flow-cross-space">跨空间查看</span>
                  )}
                </p>
              </div>
            </div>
            <details
              ref={flowOptions}
              className="flow-detail-options"
              key={detail.flow.id}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.currentTarget.open = false;
                  event.currentTarget.querySelector("summary")?.focus();
                  event.preventDefault();
                }
              }}
            >
              <summary>
                工作包选项
                <ChevronDown size={13} aria-hidden="true" />
              </summary>
              <div className="flow-detail-actions">
                <div
                  className="flow-view-switcher"
                  role="group"
                  aria-label="内容视图"
                >
                  <span className="flow-menu-label">内容视图</span>
                  {[
                    ["knowledge", "流程说明"],
                    ["recordings", "原始记录"],
                    ["scripts", "JS 脚本"],
                  ].map(([id, label]) => (
                    <button
                      key={id}
                      className="flow-menu-item"
                      aria-pressed={tab === id}
                      onClick={() => {
                        setTab(id);
                        if (flowOptions.current) {
                          flowOptions.current.open = false;
                          flowOptions.current.querySelector("summary")?.focus();
                        }
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {detail.archivedRevision && tab === "knowledge" && (
                  <nav className="flow-outline" aria-label="流程章节">
                    <span className="flow-menu-label">章节跳转</span>
                    {[
                      [
                        "flow-inputs",
                        `输入信息 · ${detail.archivedRevision.knowledge.inputs.length} 项`,
                      ],
                      [
                        "flow-procedure",
                        procedureSteps
                          ? `操作步骤 · ${procedureSteps} 步`
                          : "操作步骤",
                      ],
                      ["flow-judgement", "判断条件"],
                    ].map(([id, label]) => (
                      <a
                        key={id}
                        href={`#${id}`}
                        onClick={() => {
                          if (flowOptions.current)
                            flowOptions.current.open = false;
                        }}
                      >
                        <span>{label}</span>
                        <ArrowDown size={14} aria-hidden="true" />
                      </a>
                    ))}
                  </nav>
                )}
                <div
                  className="flow-file-options"
                  role="group"
                  aria-label="版本与导出"
                >
                  <span className="flow-menu-label">
                    {detail.revisions.length ? "版本与导出" : "导出"}
                  </span>
                  {detail.revisions.length > 0 && (
                    <label className="flow-version">
                      <select
                        aria-label="归档版本"
                        value={selectedVersion || 0}
                        onChange={(e) =>
                          void work(() =>
                            read(
                              detail.flow,
                              Number(e.target.value) || undefined,
                            ),
                          )
                        }
                      >
                        <option value={0}>当前版本</option>
                        {detail.revisions.map((r) => (
                          <option key={r.version} value={r.version}>
                            版本 {r.version} · {r.submittedBy}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <button
                    className="button small"
                    disabled={busy}
                    onClick={() =>
                      void work(async () => {
                        const path = await invoke<string | null>(
                          "export_flow_file",
                          {
                            flowId: detail.flow.id,
                          },
                        );
                        if (path) p.report(`已导出：${path}`);
                      })
                    }
                  >
                    <Download size={14} />
                    导出工作包
                  </button>
                </div>
              </div>
            </details>
          </div>
          <div className="flow-detail-meta">
            {detail.archivedRevision ? (
              <p className="archive-validation">
                <Info size={15} aria-hidden="true" />
                <span>
                  <strong>待业务验证</strong> · 使用前核对步骤与判断条件
                </span>
                <a
                  href="#flow-judgement"
                  onClick={(event) => {
                    if (tab !== "knowledge") {
                      event.preventDefault();
                      requestedSection.current = "flow-judgement";
                      setTab("knowledge");
                    }
                  }}
                >
                  核对条件 <ArrowDown size={14} aria-hidden="true" />
                </a>
              </p>
            ) : (
              <p className="archive-validation">
                <Info size={15} aria-hidden="true" />
                <span>
                  <strong>待 Agent 归档</strong>
                </span>
              </p>
            )}
          </div>
          {tab === "knowledge" &&
            (detail.archivedRevision ? (
              <div className="flow-prose">
                <p className="flow-purpose" aria-label="操作目的">
                  {detail.archivedRevision.knowledge.purpose}
                </p>
                <div className="flow-process">
                  <section className="flow-stage flow-input-stage">
                    <h3 id="flow-inputs" tabIndex={-1}>
                      输入信息
                    </h3>
                    {detail.archivedRevision.knowledge.inputs.length ? (
                      <dl className="flow-inputs">
                        {detail.archivedRevision.knowledge.inputs.map((i) => (
                          <div className="flow-input" key={i.name}>
                            <dt>
                              <strong>{i.label}</strong>
                              <code>{i.name}</code>
                            </dt>
                            <dd className="flow-input-meta">
                              {{
                                string: "文本",
                                number: "数字",
                                boolean: "是 / 否",
                              }[i.kind] || i.kind}
                              <span>{i.required ? "必填" : "可选"}</span>
                            </dd>
                            {i.default !== undefined && (
                              <dd className="flow-input-default">
                                <span>默认值</span>
                                <code>{JSON.stringify(i.default) ?? "—"}</code>
                              </dd>
                            )}
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <p>无固定输入</p>
                    )}
                    {detail.archivedRevision.knowledge
                      .prerequisitesMarkdown && (
                      <div className="flow-prerequisites">
                        <strong>开始前</strong>
                        <Markdown
                          components={{
                            a: ({ children }) => <span>{children}</span>,
                            img: () => null,
                          }}
                        >
                          {
                            detail.archivedRevision.knowledge
                              .prerequisitesMarkdown
                          }
                        </Markdown>
                      </div>
                    )}
                  </section>
                  <div className="flow-stages">
                    <section className="flow-stage flow-procedure">
                      <h3 id="flow-procedure" tabIndex={-1}>
                        操作步骤
                      </h3>
                      <Markdown
                        components={{
                          a: ({ children }) => <span>{children}</span>,
                          img: () => null,
                          ol: ({ children, start }) => (
                            <ol
                              className="operation-sequence"
                              role="list"
                              start={start}
                              style={{
                                counterReset: `flow-step ${(start || 1) - 1}`,
                              }}
                            >
                              {children}
                            </ol>
                          ),
                        }}
                      >
                        {detail.archivedRevision.knowledge.procedureMarkdown}
                      </Markdown>
                    </section>
                    <section className="flow-stage flow-result">
                      <FlowJudgement
                        key={detail.archivedRevision.id}
                        markdown={
                          detail.archivedRevision.knowledge.judgementMarkdown
                        }
                      />
                      {detail.archivedRevision.knowledge.outputs.length > 0 && (
                        <div className="flow-outputs">
                          <h4>预期输出</h4>
                          <ul>
                            {detail.archivedRevision.knowledge.outputs.map(
                              (o) => (
                                <li key={o}>{o}</li>
                              ),
                            )}
                          </ul>
                        </div>
                      )}
                      {detail.archivedRevision.knowledge.exceptionsMarkdown && (
                        <div className="flow-exceptions">
                          <h4>异常处理</h4>
                          <Markdown
                            components={{
                              a: ({ children }) => <span>{children}</span>,
                              img: () => null,
                            }}
                          >
                            {
                              detail.archivedRevision.knowledge
                                .exceptionsMarkdown
                            }
                          </Markdown>
                        </div>
                      )}
                    </section>
                  </div>
                </div>
                <details className="flow-provenance">
                  <summary>来源与归档信息</summary>
                  <p>
                    {detail.flow.origin === "human_recording"
                      ? "来自用户录制"
                      : "由 Agent 从零生成"}
                    {" · "}
                    {detail.recordings.length
                      ? `${detail.recordings.length} 份原始记录`
                      : "无录制来源"}
                    {!!detail.archivedRevision.scripts.length &&
                      ` · ${detail.archivedRevision.scripts.length} 个脚本`}
                  </p>
                  <p>
                    来源记录：
                    {detail.archivedRevision.sourceRecordingIds.length} 份 ·
                    归档人：{detail.archivedRevision.submittedBy}
                  </p>
                  <p>{detail.archivedRevision.sourceNotes}</p>
                </details>
              </div>
            ) : (
              <div className="archive-prompt">
                <h3>
                  {detail.recordings.length ? "操作已记录" : "准备工作包内容"}
                </h3>
                {detail.recordings.map((recording, index) => (
                  <section
                    className="recording-summary"
                    key={recording.id}
                    aria-label="已记录操作"
                  >
                    <header>
                      <strong>
                        {detail.recordings.length > 1 && `录制 ${index + 1} · `}
                        {recording.summary?.actionCount
                          ? `${recording.summary.actionCount} 项操作`
                          : `${recording.eventCount} 条事件`}
                      </strong>
                      <span>
                        {recording.summary?.actionCount
                          ? `${recording.eventCount} 条原始事件 · `
                          : ""}
                        {recording.captureState === "completed"
                          ? "录制结束"
                          : recording.captureState === "recording"
                            ? "录制中"
                            : "录制中断"}
                      </span>
                    </header>
                    {recording.summary?.steps.length ? (
                      <ol className="operation-sequence" role="list">
                        {recording.summary.steps.map((step) => (
                          <li key={step.order}>
                            <span className="operation-index">
                              {String(step.order).padStart(2, "0")}
                            </span>
                            <span title={step.label}>
                              {step.kind === "submit" &&
                              step.label !== "表单" ? (
                                step.label
                              ) : (
                                <>
                                  {{
                                    input: "填写",
                                    change: "选择",
                                    click: "点击",
                                    submit: "提交",
                                    navigation: "切换",
                                  }[step.kind] || "操作"}{" "}
                                  {step.label}
                                </>
                              )}
                            </span>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p>查看原始记录，核对已捕获的页面与操作。</p>
                    )}
                    {recording.summary &&
                      recording.summary.omittedActions > 0 && (
                        <p className="recording-summary-more">
                          中间还有 {recording.summary.omittedActions}{" "}
                          项操作，见原始记录。
                        </p>
                      )}
                    {!!recording.limitations.length && (
                      <details className="recording-summary-limits">
                        <summary>采集范围与限制</summary>
                        <p>{recording.limitations.join("；")}</p>
                      </details>
                    )}
                  </section>
                ))}
                <p>
                  {detail.recordings.length
                    ? "把原始操作交给你的 Agent，整理为可复用的步骤与判断条件。"
                    : "把流程目的与需求交给你的 Agent，整理输入、步骤与判断条件。"}
                </p>
                <div className="archive-handoff">
                  <button
                    className={
                      copiedArchive === detail.flow.id
                        ? "button"
                        : "button primary"
                    }
                    disabled={busy}
                    onClick={() =>
                      void work(async () => {
                        setCopiedArchive(undefined);
                        await copy(task);
                        setCopiedArchive(detail.flow.id);
                      })
                    }
                  >
                    {copiedArchive === detail.flow.id ? (
                      <CheckCircle2 size={15} />
                    ) : (
                      <Copy size={15} />
                    )}
                    {copiedArchive === detail.flow.id
                      ? "已复制归档任务"
                      : "复制归档任务"}
                  </button>
                  <p
                    className="archive-feedback"
                    data-copied={copiedArchive === detail.flow.id}
                    role="status"
                  >
                    {copiedArchive === detail.flow.id ? (
                      <>
                        <strong>下一步：发给你的 Agent</strong>
                        <span>归档结果会显示在这里。</span>
                      </>
                    ) : (
                      "Agent 归档后，这里会显示完整的工作包。"
                    )}
                  </p>
                </div>
                <details className="archive-instructions">
                  <summary>查看任务指令</summary>
                  <pre>{task}</pre>
                </details>
                <p className="archive-source">
                  {detail.flow.origin === "human_recording"
                    ? "来自用户录制"
                    : "由 Agent 从零生成"}
                  {" · "}
                  {detail.recordings.length
                    ? `${detail.recordings.length} 份原始记录`
                    : "无录制来源"}
                </p>
              </div>
            ))}
          {tab === "scripts" && (
            <div className="script-list">
              <h2 className="flow-view-heading">JS 脚本</h2>
              <p className="muted">
                由 Agent 判断何时调用。每个脚本在指定 WebView 中执行，可使用
                inputs、signal 和 document。
              </p>
              {detail.archivedRevision?.scripts.map((s) => (
                <article key={s.id}>
                  <div>
                    <FileCode2 size={18} />
                    <strong>{s.name}</strong>
                    <code>{s.id}</code>
                    <button
                      className="button small"
                      onClick={() =>
                        void work(async () =>
                          setScript(
                            await call<FlowScript>("flow_script_get", {
                              flowId: detail.flow.id,
                              version: detail.archivedRevision?.version,
                              scriptId: s.id,
                            }),
                          ),
                        )
                      }
                    >
                      查看脚本
                    </button>
                  </div>
                  <p>{s.description}</p>
                  <Markdown
                    components={{
                      a: ({ children }) => <span>{children}</span>,
                      img: () => null,
                    }}
                  >
                    {s.usageMarkdown}
                  </Markdown>
                </article>
              ))}
              {!detail.archivedRevision?.scripts.length && (
                <p>当前流程没有执行脚本，Agent 可根据说明直接操作网页。</p>
              )}
              {script && (
                <div>
                  <h3>{script.name}</h3>
                  <pre className="code-view">{script.content}</pre>
                  <pre>{JSON.stringify(script.inputs, null, 2)}</pre>
                </div>
              )}
            </div>
          )}
          {tab === "recordings" && (
            <div className="recording-list">
              <h2 className="flow-view-heading">原始记录</h2>
              {detail.recordings.map((r) => (
                <article key={r.id}>
                  <strong>{date(r.startedAt)}</strong>
                  <span>
                    {r.eventCount} 条事件 ·{" "}
                    {r.captureState === "completed"
                      ? "录制结束"
                      : r.captureState === "recording"
                        ? "录制中"
                        : "录制中断"}
                  </span>
                  <button
                    className="button small"
                    onClick={() =>
                      void work(async () =>
                        setRecord(
                          await call("recording_get", {
                            recordingId: r.id,
                            limit: 100,
                          }),
                        ),
                      )
                    }
                  >
                    查看操作
                  </button>
                  <p>{r.limitations.join("；")}</p>
                </article>
              ))}
              {!detail.recordings.length && (
                <p>这个流程由 Agent 从零生成，没有用户录制。</p>
              )}
              {record && (
                <>
                  <h3>原始操作 · {record.totalEvents} 条</h3>
                  <ol className="event-timeline">
                    {record.events.map((ev, i) => (
                      <li key={i}>
                        <div>
                          <strong>
                            {eventNames[String(ev.kind)] || String(ev.kind)}
                          </strong>
                          <small>
                            {String(ev.actor)} ·{" "}
                            {String(ev.at || ev.receivedAt)}
                          </small>
                        </div>
                        <details>
                          <summary>
                            {String(
                              (ev.target as { label?: string })?.label ||
                                ev.pageUrl ||
                                "页面状态",
                            )}
                          </summary>
                          <pre>{JSON.stringify(ev, null, 2)}</pre>
                        </details>
                      </li>
                    ))}
                  </ol>
                  {record.nextOffset !== null && (
                    <button
                      className="button"
                      onClick={() =>
                        void work(async () => {
                          const next = await call<typeof record>(
                            "recording_get",
                            {
                              recordingId: record.id,
                              offset: record.nextOffset,
                              limit: 100,
                            },
                          );
                          setRecord({
                            ...next,
                            events: [...record.events, ...next.events],
                          });
                        })
                      }
                    >
                      读取更多
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="flow-filters">
            {p.selected && (
              <div className="flow-scope" role="group" aria-label="流程范围">
                <button
                  className={!showAll ? "selected" : ""}
                  aria-pressed={!showAll}
                  onClick={() => setShowAll(false)}
                >
                  当前空间
                </button>
                <button
                  className={showAll ? "selected" : ""}
                  aria-pressed={showAll}
                  onClick={() => setShowAll(true)}
                >
                  全部空间
                </button>
              </div>
            )}
            <select
              aria-label="归档状态"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="">全部归档状态</option>
              <option value="unarchived">未归档</option>
              <option value="archived">已归档</option>
            </select>
            <div className="flow-search">
              <Search size={16} aria-hidden="true" />
              <input
                ref={searchInput}
                aria-label="搜索流程"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索流程名称"
                onKeyDown={(event) => {
                  if (event.key === "Escape" && query) {
                    setQuery("");
                    event.preventDefault();
                  }
                }}
              />
              {query && (
                <button
                  className="flow-search-clear"
                  aria-label="清除流程搜索"
                  onClick={() => {
                    setQuery("");
                    searchInput.current?.focus();
                  }}
                >
                  <X size={15} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
          {!!flows.length && (
            <div className="flow-collection-heading" role="status">
              <span>
                {listing
                  ? "正在更新流程…"
                  : `${query.trim() || filter ? "筛选结果" : "工作包目录"} · ${flows.length} 个流程`}
              </span>
            </div>
          )}
          <div className="flow-grid" aria-busy={listing}>
            {flows.map((f) => (
              <button
                className="flow-card"
                data-flow-id={f.id}
                key={f.id}
                aria-label={`${f.archiveState === "archived" ? "待业务验证" : "待 Agent 归档"} ${f.name} · 所属空间 ${p.domains.find((d) => d.id === f.domainId)?.name || "业务空间"} · ${f.archiveState === "archived" ? "已归档" : "未归档"}`}
                onClick={() => {
                  setTab("knowledge");
                  void work(() => read(f));
                }}
              >
                <div className="flow-card-content">
                  <div className="flow-card-heading">
                    <h2>{f.name}</h2>
                    <span className="flow-badge unarchived">
                      {f.archiveState === "archived"
                        ? "待业务验证"
                        : "待 Agent 归档"}
                    </span>
                  </div>
                  <div className="flow-card-subline">
                    <span className="flow-space-name">
                      <Folder size={13} />
                      {p.domains.find((d) => d.id === f.domainId)?.name}
                    </span>
                    <span>
                      {f.archiveState === "archived" ? "已归档" : "未归档"} ·{" "}
                      {f.description ||
                        `${f.recordingIds.length ? `${f.recordingIds.length} 份原始录制 · ` : ""}${f.origin === "human_recording" ? "用户录制" : "Agent 生成"}`}
                    </span>
                    <small className="flow-card-updated">
                      更新于 {date(f.updatedAt)}
                    </small>
                  </div>
                </div>
                <span className="flow-next-action">
                  {f.archiveState === "archived" ? "核对流程" : "整理归档"}
                  <ArrowRight size={16} aria-hidden="true" />
                </span>
              </button>
            ))}
          </div>
          {!flows.length && listing && (
            <p className="page-loading" role="status">
              正在读取流程…
            </p>
          )}
          {!flows.length && !listing && (
            <div className="flow-empty">
              {query.trim() || filter ? (
                <Search size={32} />
              ) : (
                <Folder size={32} />
              )}
              <h2>
                {query.trim() || filter ? "没有匹配的流程" : "这里还没有流程"}
              </h2>
              <p>
                {query.trim() || filter
                  ? "尝试其他名称，或清除搜索与归档状态筛选。"
                  : domain
                    ? `在「${domain.name}」中打开网页，点击“录制准备”。你的 Agent 也可以直接创建归档工作包。`
                    : "从侧栏选择或新建业务空间，开始积累业务流程。"}
              </p>
              {query.trim() || filter ? (
                <button
                  className="button"
                  onClick={() => {
                    setQuery("");
                    setFilter("");
                    searchInput.current?.focus();
                  }}
                >
                  清除搜索与筛选
                </button>
              ) : (
                domain?.websites[0] && (
                  <button
                    className="button primary"
                    onClick={() =>
                      void p.open(domain.websites[0].entryUrl, domain.id)
                    }
                  >
                    打开网站
                  </button>
                )
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
