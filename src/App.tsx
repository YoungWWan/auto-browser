import {
  useState,
  useEffect,
  useRef,
  useCallback,
  lazy,
  Suspense,
} from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowUpRight,
  ArrowRight,
  ArrowLeft,
  Plus,
  Search,
  Globe,
  Braces,
  Layers,
  History,
  Plug,
  Check,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  X,
  Copy,
  Download,
  Upload,
  Play,
  Pause,
  Square,
  Terminal,
  Folder,
  ExternalLink,
  AlertCircle,
  CheckCircle2,
  PanelRightClose,
  Eye,
  Save,
  FileCode2,
  BookOpen,
  Settings2,
  Circle,
  Menu,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { call, desktop, layout } from "./api";
import type {
  Workflow,
  Session,
  Run,
  Snapshot,
  AppStatus,
  Step,
  Guide,
  GuideSummary,
} from "./types";
import demo from "../examples/demo-workflow.json";
import customerGuide from "../examples/customer-guide.json";
import {
  blankGuide,
  guideFromTrace,
  guideMarkdown,
  parseGuideFile,
} from "./guides";
import { BusinessSpaces, SpaceEditor, SpaceSwitcher } from "./BusinessSpaces";
import { agentConnection } from "./agentConnection";
import { JevPanel, DelegateTasks } from "./JevPanel";
import type { DelegateTask } from "./JevPanel";
import type { Domain, Recording, Flow } from "./flowTypes";
import { WorkflowPath } from "./WorkflowPath";
import { useDialogFocus } from "./useDialogFocus";

const DomainFlows = lazy(() =>
  import("./DomainFlows").then((module) => ({ default: module.DomainFlows })),
);
const GuideDialog = lazy(() =>
  import("./GuideDialog").then((module) => ({ default: module.GuideDialog })),
);

type View =
  | "workspace"
  | "domains"
  | "workflows"
  | "legacy"
  | "history"
  | "agents"
  | "settings";
const labels: Record<View, string> = {
  workspace: "网页工作区",
  workflows: "流程库",
  domains: "业务空间",
  legacy: "旧资料与回放",
  history: "运行记录",
  agents: "Agent 接入",
  settings: "配置",
};
const statuses: Record<string, string> = {
  draft: "草稿",
  verified: "已验证",
  running: "执行中",
  paused: "已暂停",
  stopping: "正在停止",
  stopped: "已停止",
  succeeded: "已完成",
  failed: "执行失败",
  interrupted: "已中断",
};
const time = (s: string) =>
  new Date(s).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
type PageElement = Snapshot["elements"][number];
function isFormElement(el: PageElement) {
  return (
    ["textarea", "select"].includes(el.tag) ||
    (el.tag === "input" &&
      !["submit", "button", "reset"].includes(el.type || "")) ||
    ["textbox", "combobox", "checkbox", "radio", "switch"].includes(
      el.role || "",
    )
  );
}
function elementType(el: PageElement) {
  if (el.tag === "select") return "下拉选择";
  if (el.tag === "textarea") return "多行文本";
  if (el.tag === "input") {
    const inputTypes: Record<string, string> = {
      checkbox: "复选框",
      radio: "单选项",
      password: "密码框",
      search: "搜索框",
      email: "邮箱输入",
      number: "数字输入",
      file: "文件选择",
      submit: "提交按钮",
      button: "按钮",
      reset: "重置按钮",
    };
    return inputTypes[el.type || "text"] || "文本框";
  }
  if (el.tag === "button") return el.type === "submit" ? "提交按钮" : "按钮";
  const roleTypes: Record<string, string> = {
    textbox: "文本框",
    combobox: "选择框",
    checkbox: "复选框",
    radio: "单选项",
    switch: "开关",
    button: "按钮",
    tab: "标签页",
    menuitem: "菜单项",
    link: "链接",
  };
  return roleTypes[el.role || ""] || (el.tag === "a" ? "链接" : "交互控件");
}
function Button({
  icon: Icon,
  children,
  onClick,
  primary = false,
  disabled = false,
  small = false,
}: {
  icon?: LucideIcon;
  children: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  small?: boolean;
}) {
  return (
    <button
      className={`button ${primary ? "primary" : ""} ${small ? "small" : ""}`}
      onClick={onClick}
      disabled={disabled}
    >
      {Icon && <Icon size={15} />} {children}
    </button>
  );
}
function IconButton({
  icon: Icon,
  title,
  onClick,
  disabled = false,
}: {
  icon: LucideIcon;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className="icon-button"
      aria-label={title}
      title={title}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon size={16} />
    </button>
  );
}
function Badge({ status }: { status: string }) {
  return (
    <span className={`badge ${status}`}>
      <i />
      {statuses[status] || status}
    </span>
  );
}

export default function App() {
  const [view, setView] = useState<View>("workspace");
  const [domains, setDomains] = useState<Domain[]>([]);
  const [flowCount, setFlowCount] = useState(0);
  const [flowContext, setFlowContext] = useState<{
    space: string;
    name: string;
  } | null>(null);
  const [selectedDomain, setSelectedDomain] = useState(
    localStorage.getItem("selected-domain") || "",
  );
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [recordName, setRecordName] = useState<string | null>(null);
  const [spaceMenu, setSpaceMenu] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const navigationTrigger = useRef<HTMLButtonElement>(null);
  const [spaceSwitching, setSpaceSwitching] = useState(false);
  const [spaceEdit, setSpaceEdit] = useState<Partial<Domain> | null>(null);
  const [assignPage, setAssignPage] = useState<Session | null>(null);
  const [assignSpace, setAssignSpace] = useState("");
  const [newPage, setNewPage] = useState(false);
  const selectedSpaceRef = useRef(selectedDomain);
  const lastPages = useRef<Record<string, string>>({});
  const switching = useRef(false);
  const closeSpaceEditor = useCallback(() => setSpaceEdit(null), []);
  const createSpace = () => {
    setSpaceMenu(false);
    setSpaceEdit({ name: "", description: "", websites: [] });
  };
  function selectDomain(id: string) {
    selectedSpaceRef.current = id;
    setSelectedDomain(id);
    localStorage.setItem("selected-domain", id);
  }

  const [sessions, setSessions] = useState<Session[]>([]);
  const [active, setActive] = useState<string>();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [guides, setGuides] = useState<GuideSummary[]>([]);
  const [libraryType, setLibraryType] = useState<"guides" | "scripts">(
    "guides",
  );
  const [guideDialog, setGuideDialog] = useState<{
    guide: Guide;
    editing: boolean;
  } | null>(null);
  const [jsRuns, setJsRuns] = useState<
    {
      id: string;
      name: string;
      scriptId: string;
      version: number;
      status: string;
      startedAt: string;
      error?: string;
    }[]
  >([]);
  const [jsDetail, setJsDetail] = useState<unknown>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [delegateTasks, setDelegateTasks] = useState<DelegateTask[]>([]);
  const [status, setStatus] = useState<AppStatus>();
  const [address, setAddress] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [setupCopied, setSetupCopied] = useState(false);
  const [error, setError] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [panel, setPanel] = useState(false);
  const [editor, setEditor] = useState<string | null>(null);
  const [runner, setRunner] = useState<Workflow | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [runSession, setRunSession] = useState("");
  const [detail, setDetail] = useState<Run | null>(null);
  const [actionTarget, setActionTarget] = useState("");
  const [actionValue, setActionValue] = useState("");
  const browserArea = useRef<HTMLDivElement>(null);
  const observerTrigger = useRef<HTMLButtonElement>(null);
  const recordingTrigger = useRef<HTMLButtonElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const currentSpace = domains.find((d) => d.id === selectedDomain);
  const scopedSessions = selectedDomain
    ? sessions.filter((s) => s.domainId === selectedDomain)
    : sessions;
  const current = newPage
    ? undefined
    : scopedSessions.find((s) => s.id === active);
  const running = runs.find(
    (r) =>
      r.sessionId === active &&
      ["running", "paused", "stopping"].includes(r.status),
  );
  const delegation = delegateTasks.find(
    (task) => task.sessionId === current?.id && !task.finishedAt,
  );
  const pageOccupied = !!running || !!delegation;
  const legacyModal = editor !== null || runner !== null || detail !== null;
  const modal =
    legacyModal ||
    guideDialog !== null ||
    spaceMenu ||
    mobileMenu ||
    spaceSwitching ||
    spaceEdit !== null ||
    assignPage !== null;
  const recording = recordings.find(
    (r) => r.sessionId === current?.id && r.captureState === "recording",
  );
  const recordingReason = pageOccupied
    ? "网页正在执行任务，结束后可录制"
    : !current
      ? "先打开一个网页"
      : !current.domainId
        ? "先为此网页分配业务空间"
        : !selectedDomain || current.domainId !== selectedDomain
          ? "进入网页所属的业务空间后可录制"
          : busy
            ? "正在处理操作，请稍候"
            : "";
  const snapshotPage = useRef<string | undefined>(undefined);
  snapshotPage.current = current?.id;
  const dismissWorkspaceDialog = useCallback(() => {
    if (busy) return;
    setRecordName(null);
    setAssignPage(null);
    setEditor(null);
    setRunner(null);
    setDetail(null);
  }, [busy]);
  useDialogFocus(assignPage !== null || legacyModal, dismissWorkspaceDialog);
  const cancelRecordingDraft = useCallback(() => {
    setRecordName(null);
    recordingTrigger.current?.focus();
  }, []);
  useEffect(() => {
    setRecordName(null);
  }, [current?.id, view, selectedDomain]);
  useEffect(() => {
    if (recordName === null) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        cancelRecordingDraft();
      }
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [recordName !== null, busy, cancelRecordingDraft]);
  useEffect(() => {
    if (!mobileMenu) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileMenu(false);
        navigationTrigger.current?.focus();
      }
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [mobileMenu]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "l" &&
        view === "workspace" &&
        !modal
      ) {
        event.preventDefault();
        const input =
          document.querySelector<HTMLInputElement>(".address-bar input");
        input?.focus();
        input?.select();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [view, modal]);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("focus-address", () => {
      if (modal) return;
      setView("workspace");
      requestAnimationFrame(() => {
        // Wait for the native menu to release its responder after the view renders.
        requestAnimationFrame(() => {
          if (disposed) return;
          const input =
            document.querySelector<HTMLInputElement>(".address-bar input");
          input?.focus();
          input?.select();
        });
      });
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [modal]);
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      void call<{ recorder: { lastError: string | null } }>(
        "recording_status",
        { sessionId: recording.sessionId },
      )
        .then((s) => {
          if (s.recorder?.lastError)
            setError(
              "网页事件未能保存，请结束录制并检查采集状态。" +
                s.recorder.lastError,
            );
        })
        .catch((e) => setError(String(e)));
    }, 2000);
    return () => clearInterval(timer);
  }, [recording?.id]);
  const refresh = useCallback(async () => {
    if (!desktop) return;
    try {
      const scope = selectedSpaceRef.current;
      const [b, w, r, a, g, ds, rs, fs, js] = await Promise.all([
        call<{ sessions: Session[]; activeSessionId: string }>("browser_list"),
        call<{ workflows: Workflow[] }>("workflow_list"),
        call<{ runs: Run[] }>("run_list"),
        call<AppStatus>("app_status"),
        call<{ guides: GuideSummary[] }>("guide_list"),
        call<{ domains: Domain[] }>("domain_list"),
        call<{ recordings: Recording[] }>("recording_list"),
        call<{ flows: Flow[]; total: number }>("flow_list", {
          limit: 1,
          ...(scope ? { domainId: scope } : {}),
        }),
        call<{ runs: typeof jsRuns }>("script_run_list"),
      ]);
      setSessions(b.sessions);
      setActive(b.activeSessionId || undefined);
      setWorkflows(w.workflows);
      setGuides(g.guides);
      setDomains(ds.domains);
      setRecordings(rs.recordings);
      if (scope === selectedSpaceRef.current) setFlowCount(fs.total);
      setRuns(r.runs);
      setJsRuns(js.runs);
      setStatus(a);
      if (a.capabilities.jevDelegation) {
        const result = await call<{ tasks: DelegateTask[] }>(
          "browser_delegate_list",
        );
        setDelegateTasks(result.tasks);
      }
    } catch (e) {
      setError(String(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let unlistenLayout: (() => void) | undefined;
    if (desktop) {
      void listen("state-changed", () => void refresh()).then((f) => {
        if (disposed) f();
        else unlisten = f;
      });
      void listen<string>("workspace-layout-error", (event) =>
        setError(event.payload),
      ).then((f) => {
        if (disposed) f();
        else unlistenLayout = f;
      });
    }
    const timer = setInterval(() => void refresh(), 1800);
    return () => {
      disposed = true;
      unlisten?.();
      unlistenLayout?.();
      clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    setAddress(current?.url || "");
    setSnapshot(undefined);
  }, [active, current?.url]);
  useEffect(() => {
    if (notice) {
      const timer = setTimeout(() => setNotice(""), 3200);
      return () => clearTimeout(timer);
    }
  }, [notice]);
  useEffect(() => {
    setNotice("");
    setSetupCopied(false);
  }, [view, selectedDomain]);
  useEffect(() => {
    let disposed = false;
    const sync = () => {
      if (disposed) return;
      const el = browserArea.current;
      const rect = el?.getBoundingClientRect();
      void layout(
        view === "workspace" && !modal && !!current,
        rect ? [rect.x, rect.y, rect.width, rect.height] : undefined,
      ).catch((e) => setError(String(e)));
    };
    sync();
    const observer = new ResizeObserver(sync);
    if (browserArea.current) observer.observe(browserArea.current);
    window.addEventListener("resize", sync);
    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener("resize", sync);
    };
    // Navigation can announce the session before browser_open finishes applying
    // its native visibility. Apply the settled UI layout again after that command
    // and when the page finishes loading, even if the session ID did not change.
  }, [view, modal, current?.id, current?.status, panel, busy]);
  async function perform(fn: () => Promise<unknown>, success?: string) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
      if (success) setNotice(success);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function switchSpace(id: string, destination?: View) {
    if (switching.current) return;
    switching.current = true;
    setSpaceSwitching(true);
    if (current) lastPages.current[selectedDomain] = current.id;
    const candidates = id
      ? sessions.filter((s) => s.domainId === id)
      : sessions;
    const target =
      candidates.find((s) => s.id === lastPages.current[id]) ||
      candidates.find((s) => s.id === active) ||
      candidates[0];
    selectDomain(id);
    setActive(target?.id);
    setNewPage(false);
    setAddress(target?.url || "");
    setSnapshot(undefined);
    if (destination) setView(destination);
    try {
      await perform(async () => {
        if (target) await call("browser_focus", { sessionId: target.id });
      });
    } finally {
      switching.current = false;
      setSpaceSwitching(false);
    }
  }
  async function focusPage(s: Session) {
    await perform(async () => {
      await call("browser_focus", { sessionId: s.id });
      setNewPage(false);
      lastPages.current[selectedDomain] = s.id;
      setView("workspace");
    });
  }
  function startNewPage() {
    if (current) lastPages.current[selectedDomain] = current.id;
    setView("workspace");
    setNewPage(true);
    setAddress("");
  }
  async function open(url: string, domainId = selectedDomain) {
    if (current) lastPages.current[selectedDomain] = current.id;
    await perform(async () => {
      const opened = await call<Session>("browser_open", {
        url,
        ...(domainId ? { domainId } : {}),
      });
      lastPages.current[domainId || ""] = opened.id;
      if (domainId) selectDomain(domainId);
      setNewPage(false);
      setView("workspace");
    });
  }
  async function observe() {
    if (!current) return;
    const sessionId = current.id;
    await perform(async () => {
      const result = await call<Snapshot>("browser_snapshot", { sessionId });
      if (snapshotPage.current === sessionId) setSnapshot(result);
    });
  }
  async function copy(text: string, notice = "已复制") {
    setNotice("");
    try {
      await navigator.clipboard.writeText(text);
      if (notice) setNotice(notice);
      return true;
    } catch {
      setError("复制失败，请手动选择并复制文本。");
      return false;
    }
  }
  function runFlow(w: Workflow) {
    setRunner(w);
    setRunSession(active || "");
    setInputs(
      Object.fromEntries(
        w.parameters.map((p) => [
          p.name,
          p.default == null ? "" : String(p.default),
        ]),
      ),
    );
  }
  async function startRun() {
    if (!runner) return;
    await perform(async () => {
      const converted = Object.fromEntries(
        runner.parameters
          .filter((p) => inputs[p.name] !== "" || p.required)
          .map((p) => [
            p.name,
            p.kind === "number"
              ? Number(inputs[p.name])
              : p.kind === "boolean"
                ? inputs[p.name] === "true"
                : inputs[p.name],
          ]),
      );
      const result = await call<{ runId: string }>("workflow_run", {
        workflowId: runner.id,
        sessionId: runSession,
        inputs: converted,
      });
      setRunner(null);
      setView("history");
      setNotice("流程已启动");
      setDetail(await call<Run>("run_get", { runId: result.runId }));
    });
  }
  async function traceToFlow(asScript = false) {
    if (!current) return;
    await perform(async () => {
      const { trace } = await call<{ trace?: { steps: Step[] } }>("trace_get", {
        sessionId: active,
      });
      if (!trace?.steps.length)
        throw new Error(
          "还没有可保存的 Agent 操作。先通过 Agent 或右侧工具操作网页。",
        );
      if (!asScript) {
        const startUrl =
          current.url === `${status?.endpoint}/demo`
            ? "auto-browser://demo"
            : current.url;
        setGuideDialog({
          guide: guideFromTrace(
            trace.steps,
            startUrl,
            new URL(current.url).hostname,
          ),
          editing: true,
        });
        return;
      }
      const assertions = trace.steps.filter((s) =>
        s.kind.startsWith("assert_"),
      );
      const steps = trace.steps.filter((s) => !s.kind.startsWith("assert_"));
      const w = {
        id: "",
        name: "新的网页流程",
        description: "",
        version: 1,
        startUrl:
          current.url === `${status?.endpoint}/demo`
            ? "auto-browser://demo"
            : current.url,
        domain: new URL(current.url).hostname,
        tags: [],
        parameters: [],
        steps,
        completion: assertions.at(-1) || {
          kind: "assert_text",
          value: "请替换为实际完成提示",
          description: "检查完成结果",
        },
        status: "draft",
        updatedAt: "",
      };
      setEditor(JSON.stringify(w, null, 2));
    });
  }
  async function importFlow(file: File) {
    await perform(
      async () => {
        if (libraryType === "guides") {
          setGuideDialog({
            guide: parseGuideFile(await file.text(), file.name),
            editing: true,
          });
          return;
        }
        const w = JSON.parse(await file.text());
        w.id = "";
        await call("workflow_save", { workflow: w });
        setView("legacy");
      },
      libraryType === "guides"
        ? "指南文件已读取，请检查并保存"
        : "脚本已导入为草稿",
    );
  }
  function exportFlow(w: Workflow) {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(w, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${w.name}-v${w.version}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  async function readGuide(g: GuideSummary, editing = false) {
    await perform(async () => {
      setGuideDialog({
        guide: await call<Guide>("guide_get", { guideId: g.id }),
        editing,
      });
    });
  }
  function createGuide() {
    const startUrl =
      current?.url === `${status?.endpoint}/demo`
        ? "auto-browser://demo"
        : current?.url || "";
    setGuideDialog({
      guide: blankGuide(startUrl, current ? new URL(current.url).hostname : ""),
      editing: true,
    });
  }
  async function saveGuide(guide: Guide) {
    await call("guide_save", { guide });
    setGuideDialog(null);
    setLibraryType("guides");
    setView("legacy");
    setNotice("指南已保存，Agent 可以通过 guide_get 读取");
    await refresh();
  }
  function exportGuide(g: Guide) {
    const url = URL.createObjectURL(
      new Blob([guideMarkdown(g)], { type: "text/markdown;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${g.name}-v${g.version}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }
  function copyGuide(g: Guide) {
    void copy(
      `请使用 Auto Browser 的浏览器工具，参考下面的操作指南完成用户本次任务。先查询 app_status 和 browser_list，绑定用户选定的网页，再观察页面，根据实际状态决定每一步并验证业务结果。${current ? `当前选定的 sessionId：${current.id}。` : ""}缺少必填资料时向用户询问。\n\n${guideMarkdown(g)}`,
    );
  }
  const connection = desktop ? agentConnection(status) : undefined;
  const mcpConfig = connection
    ? JSON.stringify(connection.config, null, 2)
    : "在桌面应用中获取本机接入配置。";
  return (
    <div className="app-shell">
      <aside
        className={`sidebar ${mobileMenu ? "navigation-open" : ""}`}
        aria-label="工作台导航"
      >
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setView("workspace");
          }}
        >
          <span className="brand-mark">
            a<span />
          </span>
          <div>
            auto browser<small>让流程留下来</small>
          </div>
        </a>
        <button
          ref={navigationTrigger}
          className="mobile-nav-trigger"
          aria-label={mobileMenu ? "关闭导航菜单" : "打开导航菜单"}
          aria-expanded={mobileMenu}
          aria-controls="workspace-navigation"
          onClick={() => setMobileMenu(!mobileMenu)}
        >
          {mobileMenu ? <X size={17} /> : <Menu size={17} />}
          <span>{labels[view]}</span>
        </button>
        {mobileMenu && (
          <button
            className="navigation-dismiss"
            aria-label="收起导航菜单"
            tabIndex={-1}
            onClick={() => setMobileMenu(false)}
          />
        )}
        <SpaceSwitcher
          domains={domains}
          selected={selectedDomain}
          managementView={view === "domains"}
          expanded={spaceMenu}
          disabled={busy || spaceSwitching}
          toggle={setSpaceMenu}
          select={(id) => void switchSpace(id)}
          create={createSpace}
          manage={() => setView("domains")}
        />
        <div className="nav-label">工作台</div>
        <nav id="workspace-navigation" aria-label="主导航">
          {(
            [
              { id: "workspace", icon: Globe },
              { id: "workflows", icon: Layers },
              { id: "history", icon: History },
              { id: "agents", icon: Plug },
              { id: "settings", icon: Settings2 },
              { id: "legacy", icon: FileCode2 },
            ] as { id: View; icon: LucideIcon }[]
          ).map(({ id, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${view === id ? "selected" : ""}`}
              aria-current={view === id ? "page" : undefined}
              onClick={() => {
                setView(id);
                setMobileMenu(false);
              }}
            >
              <Icon size={18} />
              <span>{labels[id]}</span>
              {id === "workflows" && <small>{flowCount}</small>}
              {id === "workspace" && (
                <span className="nav-active-dot" aria-hidden="true" />
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-separator" />
        <div className="nav-label">
          {selectedDomain ? "空间内网页" : "全部网页"}{" "}
          <button
            className="plain-icon"
            onClick={startNewPage}
            title="打开新网页"
            aria-label="打开新网页"
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="session-list">
          {scopedSessions.map((s) => (
            <button
              key={s.id}
              className={`session-item ${s.id === current?.id ? "active" : ""}`}
              aria-current={s.id === current?.id ? "page" : undefined}
              onClick={() => void focusPage(s)}
            >
              <span className="favicon">
                {host(s.url).slice(0, 1).toUpperCase()}
              </span>
              <span>
                <strong>{s.title}</strong>
                <small>
                  {selectedDomain
                    ? host(s.url)
                    : domains.find((d) => d.id === s.domainId)?.name ||
                      "未分配空间"}
                </small>
              </span>
              <ChevronRight size={13} />
            </button>
          ))}
          {!scopedSessions.length && (
            <div className="sidebar-empty">
              {selectedDomain ? "这个空间还没有网页" : "还没有打开网页"}
              <br />
              <span>从工作区开始</span>
            </div>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="local-status">
            <i className={desktop ? "online" : ""} />
            {desktop ? "本地服务运行中" : "界面预览"}
            <span>v0.3.1</span>
          </div>
        </div>
      </aside>
      <main className="main" id="main-content">
        <header
          className={`topbar ${view === "workspace" ? "workspace-topbar" : ""}`}
        >
          <div className="breadcrumbs">
            {currentSpace?.name || "全部业务空间"}
            <ChevronRight size={13} />
            {view === "workspace" ? (
              <h1>{labels[view]}</h1>
            ) : (
              <strong>{labels[view]}</strong>
            )}
            {view === "workflows" && flowContext && (
              <>
                <ChevronRight size={13} />
                <span className="breadcrumb-object">{flowContext.name}</span>
              </>
            )}
          </div>
          <div className="topbar-right">
            {view === "workspace" ? (
              <>
                <span className="workspace-session-count">
                  {scopedSessions.length
                    ? `${!current ? "新网页 · " : ""}${scopedSessions.length} 个已打开网页`
                    : "从一个网页开始"}
                </span>
                {scopedSessions.length > 0 && (
                  <Button
                    icon={Plus}
                    onClick={startNewPage}
                    disabled={busy}
                    small
                  >
                    新建网页
                  </Button>
                )}
              </>
            ) : null}
          </div>
        </header>
        {!desktop && (
          <div className="preview-banner">
            界面预览 · 网页操作和流程执行请在 Tauri 桌面应用中使用。
          </div>
        )}
        {error && (
          <div className="error-banner" role="alert">
            <AlertCircle size={16} />
            <span>{error}</span>
            <button onClick={() => setError("")} aria-label="关闭错误">
              <X size={14} />
            </button>
          </div>
        )}
        {view === "domains" && (
          <BusinessSpaces
            domains={domains}
            selected={selectedDomain}
            sessions={sessions}
            enter={(id) => void switchSpace(id, "workspace")}
            edit={(d) => setSpaceEdit(structuredClone(d))}
            create={createSpace}
            open={open}
          />
        )}
        {view === "workflows" && (
          <Suspense
            fallback={
              <div className="page-loading" role="status">
                正在打开流程库…
              </div>
            }
          >
            <DomainFlows
              key={selectedDomain}
              domains={domains}
              selected={selectedDomain}
              open={open}
              report={setNotice}
              fail={setError}
              describeDetail={setFlowContext}
            />
          </Suspense>
        )}
        {view === "workspace" && (
          <section className="workspace">
            {delegation && (
              <DelegateTasks
                compact
                tasks={[delegation]}
                fail={setError}
                refresh={refresh}
              />
            )}
            <div className={`browser-shell ${!current ? "is-empty" : ""}`}>
              <div className={`browser-toolbar ${current ? "with-page" : ""}`}>
                <div className="browser-navigation">
                  <IconButton
                    icon={ArrowLeft}
                    title="后退"
                    disabled={!current || pageOccupied}
                    onClick={() =>
                      void perform(() =>
                        call("browser_navigate", {
                          sessionId: active,
                          direction: "back",
                        }),
                      )
                    }
                  />
                  <IconButton
                    icon={ArrowRight}
                    title="前进"
                    disabled={!current || pageOccupied}
                    onClick={() =>
                      void perform(() =>
                        call("browser_navigate", {
                          sessionId: active,
                          direction: "forward",
                        }),
                      )
                    }
                  />
                  <IconButton
                    icon={RefreshCw}
                    title="刷新"
                    disabled={!current || pageOccupied}
                    onClick={() =>
                      void perform(() =>
                        call("browser_navigate", {
                          sessionId: active,
                          direction: "reload",
                        }),
                      )
                    }
                  />
                </div>
                <form
                  className="address-bar"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (address.trim())
                      void (current
                        ? perform(() =>
                            call("browser_navigate", {
                              sessionId: active,
                              url: address.trim(),
                            }),
                          )
                        : open(address.trim()));
                  }}
                >
                  <Globe size={14} />
                  <input
                    aria-label="网站地址"
                    placeholder="输入网址，打开你的工作网页"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    disabled={pageOccupied}
                  />
                  {!address && (
                    <kbd className="address-shortcut" aria-hidden="true">
                      ⌘ L
                    </kbd>
                  )}
                  <button
                    type="submit"
                    disabled={busy || pageOccupied}
                    aria-label="打开网址"
                  >
                    <ArrowRight size={15} />
                  </button>
                </form>
                {current && (
                  <button
                    className="icon-button compact-new-page"
                    aria-label="新建网页"
                    title="新建网页"
                    disabled={busy}
                    onClick={startNewPage}
                  >
                    <Plus size={16} />
                  </button>
                )}
                {current && (
                  <IconButton
                    icon={X}
                    title="关闭当前网页"
                    disabled={pageOccupied}
                    onClick={() =>
                      void perform(() =>
                        call("browser_close", { sessionId: active }),
                      )
                    }
                  />
                )}
                {current && (
                  <button
                    ref={observerTrigger}
                    className="observer-toggle"
                    aria-expanded={panel}
                    aria-controls="page-observer"
                    onClick={() => {
                      setPanel(!panel);
                      if (!panel) void observe();
                    }}
                  >
                    <PanelRightClose size={16} aria-hidden="true" />
                    页面观察
                  </button>
                )}
                {current && !recording && (
                  <button
                    ref={recordingTrigger}
                    className={`button small record-start ${recordName === null ? "primary" : "record-preparing"}`}
                    aria-label={
                      recordName === null ? "录制准备" : "收起录制准备"
                    }
                    aria-expanded={recordName !== null}
                    aria-controls="recording-start"
                    title={
                      recordingReason ||
                      (recordName === null
                        ? "设置流程名称后开始录制"
                        : "收起录制准备")
                    }
                    aria-describedby={
                      recordingReason && !busy
                        ? "recording-availability"
                        : undefined
                    }
                    disabled={!!recordingReason}
                    onClick={() =>
                      recordName === null
                        ? setRecordName("")
                        : cancelRecordingDraft()
                    }
                  >
                    {recordName === null ? (
                      <Circle size={9} fill="currentColor" aria-hidden="true" />
                    ) : (
                      <ChevronUp size={14} aria-hidden="true" />
                    )}
                    {busy ? "处理中" : "录制准备"}
                  </button>
                )}
              </div>
              {recordName !== null && current && (
                <form
                  className="recording-draft"
                  id="recording-start"
                  aria-labelledby="recording-title"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void perform(async () => {
                      if (current.domainId !== selectedDomain)
                        throw new Error("请先进入网页所属的业务空间再录制。");
                      await call("recording_start", {
                        domainId: selectedDomain,
                        sessionId: current.id,
                        name: recordName,
                      });
                      setRecordName(null);
                    }, "已开始记录网页操作");
                  }}
                >
                  <div className="recording-draft-context">
                    <h2 id="recording-title">录制对象</h2>
                    <p>
                      <strong title={current.title}>{current.title}</strong>
                      <span>{host(current.url)}</span>
                    </p>
                  </div>
                  <label className="recording-draft-name">
                    流程名称
                    <input
                      autoFocus
                      required
                      maxLength={120}
                      value={recordName}
                      onChange={(e) => setRecordName(e.target.value)}
                      placeholder="例如：新增客户"
                      disabled={busy}
                    />
                    <small>保存到「{currentSpace?.name}」</small>
                  </label>
                  <div className="recording-draft-actions">
                    <button
                      type="submit"
                      className="button primary"
                      disabled={!!recordingReason}
                    >
                      开始录制
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="取消录制"
                      disabled={busy}
                      onClick={cancelRecordingDraft}
                    >
                      <X size={18} />
                    </button>
                  </div>
                </form>
              )}
              {(recording ||
                !domains.length ||
                (current &&
                  (pageOccupied ||
                    !selectedDomain ||
                    !current.domainId ||
                    current.domainId !== selectedDomain))) && (
                <div className="recording-toolbar" id="recording-availability">
                  {recording ? (
                    <>
                      <span className="recording-live">
                        <i />
                        录制中 · {recording.eventCount} 条事件
                      </span>
                      <span>
                        {domains.find((d) => d.id === recording.domainId)?.name}{" "}
                        ·{" "}
                        {Math.floor(
                          (Date.now() -
                            new Date(recording.startedAt).getTime()) /
                            1000,
                        )}{" "}
                        秒
                      </span>
                      <button
                        className="button small"
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            await call("recording_stop", {
                              recordingId: recording.id,
                            });
                            setView("workflows");
                            selectDomain(recording.domainId);
                          }, "录制已保存，等待你的 Agent 归档")
                        }
                      >
                        结束录制
                      </button>
                    </>
                  ) : (
                    <>
                      <span>
                        {current
                          ? recordingReason
                          : "创建一个业务空间，保存你的操作流程"}
                      </span>
                      {current && !selectedDomain && current.domainId && (
                        <button
                          className="button small"
                          disabled={busy}
                          onClick={() => void switchSpace(current.domainId!)}
                        >
                          进入所属空间
                        </button>
                      )}
                      {current && !current.domainId && (
                        <button
                          className="button small"
                          disabled={busy}
                          onClick={() => {
                            setAssignPage(current);
                            setAssignSpace(
                              selectedDomain || domains[0]?.id || "",
                            );
                          }}
                        >
                          分配业务空间
                        </button>
                      )}
                      {!domains.length && (
                        <button className="text-button" onClick={createSpace}>
                          新建业务空间
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
              <div className="browser-body">
                <div
                  ref={browserArea}
                  className={`webview-area ${current ? "has-page" : ""}`}
                >
                  {!current ? (
                    <div className="browser-welcome">
                      <div className="welcome-start">
                        <div className="welcome-copy">
                          <h2>打开新网页。</h2>
                          <p>
                            {currentSpace?.websites.length
                              ? "在上方输入网址，或选择常用网站。"
                              : "在上方输入网址，打开你的工作网页。"}
                            <br />
                            录下操作，交给你的 Agent 整理成工作包。
                          </p>
                        </div>
                        <div className="welcome-sites">
                          {!!currentSpace?.websites.length && (
                            <span className="mini-label">
                              常用网站{" "}
                              <span>
                                {String(currentSpace.websites.length).padStart(
                                  2,
                                  "0",
                                )}
                              </span>
                            </span>
                          )}
                          <div
                            className="space-entry-links"
                            aria-label="当前空间的网站入口"
                          >
                            {currentSpace?.websites.map((w) => (
                              <button
                                className="site-entry"
                                key={w.id}
                                disabled={busy}
                                onClick={() =>
                                  void open(w.entryUrl, currentSpace.id)
                                }
                              >
                                <Globe size={15} />
                                <span>
                                  <strong>{w.name || host(w.entryUrl)}</strong>
                                  <small>{host(w.entryUrl)}</small>
                                </span>
                                <ArrowUpRight size={14} />
                              </button>
                            ))}
                            <button
                              className="site-entry practice-entry"
                              aria-label="打开练习页面"
                              onClick={() => void open("auto-browser://demo")}
                              disabled={busy || !desktop}
                            >
                              <Braces size={17} aria-hidden="true" />
                              <span>
                                <strong>打开练习页面</strong>
                                <small>先用本地表单试跑</small>
                              </span>
                              <ArrowUpRight size={15} aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                      </div>
                      <WorkflowPath />
                    </div>
                  ) : (
                    <div className="native-placeholder" aria-hidden="true">
                      {current.status === "loading" ? "正在加载网页…" : ""}
                    </div>
                  )}
                </div>
                {panel && current && (
                  <aside className="operation-panel" id="page-observer">
                    <div className="panel-title">
                      <h2>页面观察</h2>
                      <div className="panel-actions">
                        {snapshot && (
                          <IconButton
                            icon={RefreshCw}
                            title="刷新页面结构"
                            onClick={() => void observe()}
                            disabled={busy}
                          />
                        )}
                        <IconButton
                          icon={X}
                          title="关闭页面观察"
                          onClick={() => {
                            setPanel(false);
                            observerTrigger.current?.focus();
                          }}
                        />
                      </div>
                    </div>
                    {
                      <>
                        {!snapshot && (
                          <div className="panel-section">
                            <Button
                              icon={Eye}
                              onClick={() => void observe()}
                              disabled={busy}
                            >
                              读取页面结构
                            </Button>
                          </div>
                        )}
                        {snapshot && (
                          <div className="snapshot-summary">
                            <div className="element-list">
                              {[true, false].map((formItems) => {
                                const elements = snapshot.elements.filter(
                                  (el) => isFormElement(el) === formItems,
                                );
                                return (
                                  elements.length > 0 && (
                                    <section
                                      className="element-group"
                                      key={String(formItems)}
                                      aria-label={
                                        formItems ? "填写与选择" : "页面操作"
                                      }
                                    >
                                      <h3>
                                        {formItems ? "填写与选择" : "页面操作"}
                                        <span>{elements.length}</span>
                                      </h3>
                                      {elements.map((el) => (
                                        <button
                                          key={el.selector}
                                          onClick={() =>
                                            setActionTarget(el.selector)
                                          }
                                          title={`${el.tag} · ${el.selector}`}
                                          aria-pressed={
                                            actionTarget === el.selector
                                          }
                                        >
                                          <span className="element-label">
                                            {el.label || el.text || el.selector}
                                          </span>
                                          <span className="element-type">
                                            {elementType(el)}
                                          </span>
                                        </button>
                                      ))}
                                    </section>
                                  )
                                );
                              })}
                            </div>
                          </div>
                        )}
                        <details className="manual-tools">
                          <summary>
                            调试操作
                            <ChevronDown size={14} />
                          </summary>
                          <label>
                            元素选择器
                            <input
                              value={actionTarget}
                              onChange={(e) => setActionTarget(e.target.value)}
                              placeholder="#name"
                            />
                          </label>
                          <label>
                            输入内容
                            <input
                              value={actionValue}
                              onChange={(e) => setActionValue(e.target.value)}
                              placeholder="要填写的内容"
                            />
                          </label>
                          <div className="button-row">
                            <Button
                              small
                              onClick={() =>
                                void perform(() =>
                                  call("browser_action", {
                                    sessionId: active,
                                    action: {
                                      kind: "fill",
                                      target: { selector: actionTarget },
                                      value: actionValue,
                                      description: "填写字段",
                                    },
                                  }),
                                )
                              }
                              disabled={!actionTarget || busy}
                            >
                              填写
                            </Button>
                            <Button
                              small
                              onClick={() =>
                                void perform(() =>
                                  call("browser_action", {
                                    sessionId: active,
                                    action: {
                                      kind: "click",
                                      target: { selector: actionTarget },
                                      description: "点击元素",
                                    },
                                  }),
                                )
                              }
                              disabled={!actionTarget || busy}
                            >
                              点击
                            </Button>
                          </div>
                        </details>
                        {running && (
                          <div className="active-run">
                            <Badge status={running.status} />
                            <strong>{running.name}</strong>
                            <small>
                              第 {running.currentStep} / {running.totalSteps} 步
                            </small>
                            <Button
                              small
                              icon={Pause}
                              onClick={() =>
                                void perform(() =>
                                  call("run_control", {
                                    runId: running.id,
                                    action:
                                      running.status === "paused"
                                        ? "resume"
                                        : "pause",
                                  }),
                                )
                              }
                            >
                              {running.status === "paused" ? "继续" : "暂停"}
                            </Button>
                          </div>
                        )}
                      </>
                    }
                    <details className="legacy-page-tools">
                      <summary>旧版整理与练习</summary>
                      <Button
                        icon={Save}
                        onClick={() => void traceToFlow()}
                        disabled={busy}
                      >
                        整理指南草稿
                      </Button>
                      <Button
                        icon={FileCode2}
                        onClick={() => void traceToFlow(true)}
                        disabled={busy}
                      >
                        另存回放脚本
                      </Button>
                      <button
                        className="legacy-guide-link"
                        onClick={() => {
                          const g = guides.find(
                            (g) => g.id === "guide-customer",
                          );
                          if (g) void readGuide(g);
                          else
                            setGuideDialog({
                              guide: {
                                ...customerGuide,
                                id: "",
                                version: 0,
                              } as Guide,
                              editing: true,
                            });
                        }}
                      >
                        <BookOpen size={15} />
                        新增客户练习指南
                      </button>
                    </details>
                  </aside>
                )}
              </div>
              <div className="browser-footer">
                <span>
                  <span className={`tiny-dot ${current ? "live" : ""}`} />
                  {current
                    ? `${current.status === "loading" ? "正在加载" : "网页已打开"} · ${host(current.url)}`
                    : "等待打开网页"}
                </span>
              </div>
            </div>
          </section>
        )}
        {view === "legacy" && (
          <section className="content-page">
            <div className="page-title">
              <div>
                <h1>让 Agent 知道，下一步怎么做。</h1>
                <p>保存网站的操作知识，让 AI 根据当前页面理解和完成流程。</p>
              </div>
              <div className="button-row">
                <Button
                  icon={Upload}
                  onClick={() => importInput.current?.click()}
                >
                  导入
                </Button>
                <Button
                  primary
                  icon={Plus}
                  onClick={() =>
                    libraryType === "guides"
                      ? createGuide()
                      : setEditor(
                          JSON.stringify(
                            { ...demo, id: "", name: "新的回放脚本" },
                            null,
                            2,
                          ),
                        )
                  }
                >
                  {libraryType === "guides" ? "创建指南" : "创建回放脚本"}
                </Button>
              </div>
            </div>
            <div className="library-tabs" role="tablist" aria-label="流程类型">
              <button
                role="tab"
                aria-selected={libraryType === "guides"}
                onClick={() => setLibraryType("guides")}
              >
                <BookOpen size={17} /> AI 操作指南{" "}
                <small>{guides.length}</small>
              </button>
              <button
                role="tab"
                aria-selected={libraryType === "scripts"}
                onClick={() => setLibraryType("scripts")}
              >
                <FileCode2 size={17} /> 脚本回放{" "}
                <small>{workflows.length}</small>
              </button>
            </div>
            <div className="library-explainer">
              {libraryType === "guides" ? (
                <>
                  <BookOpen size={20} />
                  <div>
                    <strong>给 AI 的操作知识</strong>
                    <p>
                      描述目标、页面线索、操作思路、完成判断和异常处理。Agent
                      读取指南后逐步决策；不自动回放固定动作。
                    </p>
                    <small>
                      guide_list → guide_get → 观察页面 → 决定动作 → 验证结果
                    </small>
                  </div>
                </>
              ) : (
                <>
                  <FileCode2 size={20} />
                  <div>
                    <strong>保留的自动化脚本</strong>
                    <p>
                      按已保存的固定动作和参数顺序执行，由应用检查完成断言。
                    </p>
                  </div>
                </>
              )}
            </div>
            <div className="library-bar">
              <div className="search-box">
                <Search size={16} />
                <input
                  aria-label="搜索流程"
                  placeholder="搜索名称、网站或标签"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <span>
                {libraryType === "guides"
                  ? `${guides.length} 份指南`
                  : `${workflows.length} 个脚本`}
              </span>
            </div>
            <div className="workflow-grid">
              {libraryType === "guides" &&
                guides
                  .filter((g) =>
                    `${g.name} ${g.description} ${g.domain} ${g.tags.join(" ")}`
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                  )
                  .map((g) => (
                    <article className="workflow-card guide-card" key={g.id}>
                      <div className="workflow-card-top">
                        <span className="workflow-icon">
                          <BookOpen size={22} />
                        </span>
                        <span className="subtle-badge">AI 操作指南</span>
                      </div>
                      <span className="card-domain">
                        {g.startUrl === "auto-browser://demo"
                          ? "本地练习页面"
                          : g.domain}
                      </span>
                      <h2>{g.name}</h2>
                      <p>{g.description || "尚未添加指南说明"}</p>
                      <div className="flow-meta">
                        <span>{g.parameters.length} 项输入</span>
                        <i />
                        <span>v{g.version}</span>
                        <i />
                        <span>Agent 自主操作</span>
                      </div>
                      <div className="card-tags">
                        {g.tags.map((t) => (
                          <span key={t}>{t}</span>
                        ))}
                      </div>
                      <div className="workflow-card-bottom">
                        <Button
                          small
                          icon={BookOpen}
                          onClick={() => void readGuide(g)}
                          disabled={busy}
                        >
                          阅读指南
                        </Button>
                        <div>
                          <IconButton
                            icon={ExternalLink}
                            title="打开指南入口网页"
                            onClick={() => void open(g.startUrl)}
                          />
                          <IconButton
                            icon={FileCode2}
                            title="编辑 AI 操作指南"
                            onClick={() => void readGuide(g, true)}
                            disabled={busy}
                          />
                        </div>
                      </div>
                    </article>
                  ))}
              {libraryType === "guides" && guides.length === 0 && (
                <div className="empty-state">
                  <BookOpen size={30} />
                  <h2>把操作经验，写成 Agent 能读懂的指南</h2>
                  <p>
                    用 Markdown 描述流程，或从操作记录整理一份待补充的草稿。
                  </p>
                  <Button
                    icon={Plus}
                    onClick={() =>
                      setGuideDialog({
                        guide: {
                          ...customerGuide,
                          id: "",
                          version: 0,
                        } as Guide,
                        editing: true,
                      })
                    }
                  >
                    添加示例指南
                  </Button>
                </div>
              )}
              {libraryType === "scripts" &&
                workflows
                  .filter((w) =>
                    `${w.name} ${w.domain} ${w.tags.join(" ")}`.includes(query),
                  )
                  .map((w) => (
                    <article className="workflow-card" key={w.id}>
                      <div className="workflow-card-top">
                        <span className="workflow-icon">
                          <Layers size={22} />
                        </span>
                        <Badge status={w.status} />
                      </div>
                      <span className="card-domain">
                        {w.startUrl === "auto-browser://demo"
                          ? "本地练习页面"
                          : w.domain}
                      </span>
                      <h2>{w.name}</h2>
                      <p>{w.description || "尚未添加流程描述"}</p>
                      <div className="flow-meta">
                        <span>{w.steps.length} 个步骤</span>
                        <i />
                        <span>{w.parameters.length} 个参数</span>
                        <i />
                        <span>v{w.version}</span>
                      </div>
                      <div className="card-tags">
                        {w.tags.map((t) => (
                          <span key={t}>{t}</span>
                        ))}
                      </div>
                      <div className="workflow-card-bottom">
                        <Button small icon={Play} onClick={() => runFlow(w)}>
                          运行脚本
                        </Button>
                        <div>
                          <IconButton
                            icon={ExternalLink}
                            title="打开入口网页"
                            onClick={() => void open(w.startUrl)}
                          />
                          <IconButton
                            icon={FileCode2}
                            title="编辑回放脚本"
                            onClick={() =>
                              setEditor(JSON.stringify(w, null, 2))
                            }
                          />
                          <IconButton
                            icon={Download}
                            title="导出回放脚本"
                            onClick={() => exportFlow(w)}
                          />
                        </div>
                      </div>
                    </article>
                  ))}
              {libraryType === "scripts" && !workflows.length && (
                <div className="empty-state">
                  <Layers size={30} />
                  <h2>还没有回放脚本</h2>
                  <p>在工作区另存操作记录，或导入已有的 JSON 脚本。</p>
                  <Button onClick={() => setView("workspace")}>
                    前往工作区
                  </Button>
                </div>
              )}
            </div>
            <input
              hidden
              ref={importInput}
              type="file"
              accept={
                libraryType === "guides"
                  ? ".md,.markdown,.json,text/markdown,application/json"
                  : ".json,application/json"
              }
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importFlow(file);
                e.target.value = "";
              }}
            />
          </section>
        )}
        {view === "history" && (
          <section className="content-page">
            <div className="page-title">
              <div>
                <h1>运行记录</h1>
                <p>查看 Jev 委派、包内 JS 调用和固定脚本回放。</p>
              </div>
              <Button icon={RefreshCw} onClick={() => void refresh()}>
                刷新记录
              </Button>
            </div>
            {status?.capabilities.jevDelegation === true && (
              <>
                <h2 className="history-section-title">Jev 网页委派</h2>
                <DelegateTasks
                  tasks={delegateTasks.filter(
                    (task) =>
                      !selectedDomain || task.domainId === selectedDomain,
                  )}
                  fail={setError}
                  refresh={refresh}
                />
              </>
            )}
            <h2 className="history-section-title">工作包 JS 脚本</h2>
            <p className="muted">
              显示函数执行结果。业务是否完成，由 Agent 根据页面判断。
            </p>
            {jsRuns.length ? (
              <div className="run-table">
                <div className="table-header">
                  <span>流程 / 脚本</span>
                  <span>状态</span>
                  <span>版本</span>
                  <span>开始时间</span>
                  <span />
                </div>
                {jsRuns.map((r) => (
                  <button
                    key={r.id}
                    className="table-row"
                    onClick={() =>
                      void perform(async () =>
                        setJsDetail(
                          await call("script_run_get", { scriptRunId: r.id }),
                        ),
                      )
                    }
                  >
                    <span className="run-name">
                      <FileCode2 size={17} />
                      <span>
                        <strong>{r.name}</strong>
                        <small>{r.scriptId}</small>
                      </span>
                    </span>
                    <span
                      className={`flow-badge ${r.status === "succeeded" ? "archived" : ""}`}
                    >
                      {r.status === "succeeded"
                        ? "函数返回"
                        : r.status === "uncertain"
                          ? "结果需核查"
                          : statuses[r.status] || r.status}
                    </span>
                    <span>v{r.version}</span>
                    <span>{time(r.startedAt)}</span>
                    <ChevronRight size={15} />
                  </button>
                ))}
              </div>
            ) : (
              <p className="muted">还没有包内脚本调用记录。</p>
            )}
            {jsDetail !== null && (
              <div className="script-result">
                <button
                  className="button small"
                  onClick={() => setJsDetail(null)}
                >
                  收起结果
                </button>
                <pre>{JSON.stringify(jsDetail, null, 2)}</pre>
              </div>
            )}
            <details className="legacy-run-history">
              <summary>
                原有固定脚本回放
                <span>{runs.length} 条记录</span>
              </summary>
              {runs.length ? (
                <div className="run-table">
                  <div className="table-header">
                    <span>流程与任务</span>
                    <span>状态</span>
                    <span>进度</span>
                    <span>开始时间</span>
                    <span />
                  </div>
                  {runs.map((r) => (
                    <button
                      className="table-row"
                      key={r.id}
                      onClick={() => setDetail(r)}
                    >
                      <span className="run-name">
                        <span className="run-icon">
                          <Layers size={17} />
                        </span>
                        <span>
                          <strong>{r.name}</strong>
                          <small>{r.id.slice(0, 8)}</small>
                        </span>
                      </span>
                      <Badge status={r.status} />
                      <span className="run-progress">
                        <span>
                          <i
                            style={{
                              width: `${r.totalSteps ? (r.currentStep / r.totalSteps) * 100 : 0}%`,
                            }}
                          />
                        </span>
                        {r.currentStep}/{r.totalSteps}
                      </span>
                      <span>{time(r.startedAt)}</span>
                      <ChevronRight size={15} />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="legacy-run-empty">
                  <p>还没有固定脚本回放记录。</p>
                  <Button icon={Layers} onClick={() => setView("legacy")} small>
                    打开旧版回放资料
                  </Button>
                </div>
              )}
            </details>
          </section>
        )}
        {view === "settings" && (
          <section className="content-page settings-page">
            <div className="page-title">
              <div>
                <h1>配置</h1>
                <p>管理模型服务和业务空间的使用权限。</p>
              </div>
            </div>
            <div className="settings-content">
              {status?.capabilities.jevDelegation === true ? (
                <JevPanel
                  domains={domains}
                  fail={setError}
                  notice={setNotice}
                  refresh={refresh}
                />
              ) : (
                <p className="muted">
                  {!desktop
                    ? "请在桌面应用中管理模型服务。"
                    : !status
                      ? "正在读取配置能力…"
                      : "当前应用版本尚不支持 Jev 配置。"}
                </p>
              )}
            </div>
          </section>
        )}
        {view === "agents" && (
          <section className="content-page agents-page">
            <div className="page-title">
              <div>
                <h1>Agent 接入</h1>
                <p>使用你自己的模型与客户端。</p>
              </div>
            </div>
            <div className="agent-layout">
              <section className="connection-card agent-setup-card">
                <h2>
                  {setupCopied ? "待 Agent 检查连接。" : "连接本机工作台。"}
                </h2>
                <p>
                  {setupCopied
                    ? "保持应用运行，Agent 需要访问本机工作台。"
                    : "复制指令发给自己的 Agent，并保持应用运行。"}
                </p>
                <Button
                  icon={setupCopied ? CheckCircle2 : Copy}
                  primary={!setupCopied}
                  disabled={!connection}
                  onClick={async () => {
                    setSetupCopied(false);
                    if (connection && (await copy(connection.instruction, "")))
                      setSetupCopied(true);
                  }}
                >
                  {setupCopied ? "已复制接入指令" : "复制接入指令"}
                </Button>
                <p
                  className="setup-hint"
                  data-copied={setupCopied}
                  role={setupCopied ? "status" : undefined}
                >
                  {setupCopied ? (
                    <>
                      <strong>下一步：发给你的 Agent</strong>
                      <span>等待它返回连接检查结果。</span>
                    </>
                  ) : connection ? (
                    "完成后，Agent 会返回连接与网页控制的检查结果。"
                  ) : desktop ? (
                    "获取本机路径后即可复制。"
                  ) : (
                    "请在桌面应用中复制，指令会包含本机接入路径。"
                  )}
                </p>
                {connection && (
                  <details className="setup-instruction">
                    <summary>查看接入指令</summary>
                    <p>{connection.instruction}</p>
                  </details>
                )}
              </section>
              <aside className="agent-side">
                <h3>当前能力</h3>
                <div className="capability">
                  <Check size={14} />
                  DOM 页面观察
                </div>
                <div className="capability">
                  <Check size={14} />
                  填表、点击、页面断言
                </div>
                <div className="capability">
                  <Check size={14} />
                  人工录制、Agent 归档与 JS 脚本调用
                </div>
                <p className="agent-limits">
                  截图、可信键鼠输入和自动文件上传尚未接入。复杂 iframe
                  控件需后续适配。
                </p>
                <div className="local-storage">
                  <Folder size={19} />
                  <strong>本地存储</strong>
                  <details className="storage-path">
                    <summary>查看文件位置</summary>
                    <p>{status?.dataPath || "系统应用数据目录"}</p>
                  </details>
                </div>
              </aside>
              <details className="manual-connection">
                <summary>
                  <span>手动配置 MCP、Skill 或 CLI</span>
                  <ChevronDown size={15} />
                </summary>
                <div className="manual-connection-content">
                  <section className="connection-card">
                    <div className="section-heading">
                      <span className="number-square">01</span>
                      <div>
                        <h2>添加 MCP 服务</h2>
                        <p>将以下配置添加到支持 MCP 的 Agent 客户端。</p>
                      </div>
                      <button
                        className="icon-button"
                        title="复制 MCP 配置"
                        aria-label="复制 MCP 配置"
                        disabled={!connection}
                        onClick={() => void copy(mcpConfig)}
                      >
                        <Copy size={16} />
                      </button>
                    </div>
                    <pre>{mcpConfig}</pre>
                    <div className="connection-note">
                      <Terminal size={15} />
                      同一个原生程序提供 MCP 和 CLI，无需额外 Node 运行时。
                    </div>
                  </section>
                  <section className="connection-card">
                    <div className="section-heading">
                      <span className="number-square">02</span>
                      <div>
                        <h2>安装操作 Skill</h2>
                        <p>让 Agent 知道怎样观察网页、验证结果和复用流程。</p>
                      </div>
                    </div>
                    <div className="skill-path">
                      <FileCode2 size={18} />
                      <code>
                        {connection?.skillPath || "在桌面应用中获取 Skill 路径"}
                      </code>
                      <IconButton
                        icon={Copy}
                        title="复制 Skill 路径"
                        disabled={!connection}
                        onClick={() =>
                          connection && void copy(connection.skillPath)
                        }
                      />
                    </div>
                    <p className="fine-print">
                      将 auto-browser 文件夹放入 Agent 的 skills
                      目录。客户端需支持 MCP 工具或调用本地 CLI。
                    </p>
                  </section>
                  <section className="connection-card">
                    <div className="section-heading">
                      <span className="number-square">03</span>
                      <div>
                        <h2>也可以直接使用 CLI</h2>
                        <p>
                          使用上方 command 的二进制，并设置相同的
                          AUTO_BROWSER_CONNECTION 环境变量。
                        </p>
                      </div>
                    </div>
                    <pre>
                      auto-browser-agent status{"\n"}auto-browser-agent call
                      browser_list '{"{}"}'
                    </pre>
                  </section>
                </div>
              </details>
            </div>
          </section>
        )}
        {notice && (
          <div className="toast" role="status">
            <CheckCircle2 size={17} />
            {notice}
          </div>
        )}
      </main>
      {spaceEdit && (
        <SpaceEditor
          initial={spaceEdit}
          close={closeSpaceEditor}
          fail={setError}
          save={async (space, created) => {
            setSpaceEdit(null);
            await refresh();
            if (created) await switchSpace(space.id, "workspace");
            setNotice(
              created ? `已创建并进入「${space.name}」` : "业务空间已更新",
            );
          }}
        />
      )}
      {assignPage && (
        <div className="modal-backdrop">
          <form
            className="modal recording-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="assign-space-title"
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                await call("browser_bind_domain", {
                  sessionId: assignPage.id,
                  domainId: assignSpace,
                });
                setAssignPage(null);
                selectDomain(assignSpace);
                setNewPage(false);
                await call("browser_focus", { sessionId: assignPage.id });
              }, "网页已分配到业务空间");
            }}
          >
            <div className="modal-header">
              <h2 id="assign-space-title">分配业务空间</h2>
              <button
                type="button"
                className="icon-button"
                aria-label="取消分配"
                disabled={busy}
                onClick={() => setAssignPage(null)}
              >
                <X size={18} />
              </button>
            </div>
            <p>将「{assignPage.title}」放到哪个业务空间？</p>
            <label>
              业务空间
              <select
                aria-label="分配到业务空间"
                required
                value={assignSpace}
                onChange={(e) => setAssignSpace(e.target.value)}
              >
                <option value="" disabled>
                  选择业务空间
                </option>
                {domains.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            {!domains.length && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setAssignPage(null);
                  createSpace();
                }}
              >
                先新建业务空间
              </button>
            )}
            <div className="modal-footer">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setAssignPage(null)}
              >
                取消
              </button>
              <button
                className="button primary"
                type="submit"
                disabled={busy || !assignSpace}
              >
                分配并进入空间
              </button>
            </div>
          </form>
        </div>
      )}
      {guideDialog && (
        <Suspense
          fallback={
            <div className="page-loading" role="status">
              正在打开指南…
            </div>
          }
        >
          <GuideDialog
            key={`${guideDialog.guide.id}-${guideDialog.guide.version}`}
            guide={guideDialog.guide}
            editing={guideDialog.editing}
            onClose={() => setGuideDialog(null)}
            onSave={saveGuide}
            onCopy={copyGuide}
            onExport={exportGuide}
          />
        </Suspense>
      )}
      {legacyModal && (
        <div className="modal-backdrop">
          <section
            className={`modal ${editor !== null ? "editor-modal" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-label={
              editor !== null
                ? "回放脚本定义"
                : runner
                  ? "运行回放脚本"
                  : "执行详情"
            }
          >
            <div className="modal-header">
              <h2>
                {editor !== null
                  ? "回放脚本定义"
                  : runner
                    ? `运行 · ${runner.name}`
                    : "执行详情"}
              </h2>
              <IconButton
                icon={X}
                title="关闭对话框"
                onClick={() => {
                  setEditor(null);
                  setRunner(null);
                  setDetail(null);
                }}
              />
            </div>
            {error && (
              <div className="detail-error" role="alert">
                <AlertCircle size={16} />
                {error}
              </div>
            )}
            {editor !== null && (
              <>
                <p className="modal-description">
                  修改参数、步骤和完成条件。保存会创建新版本，验证后才标记为已验证。
                </p>
                <textarea
                  className="json-editor"
                  aria-label="流程 JSON"
                  spellCheck={false}
                  value={editor}
                  onChange={(e) => setEditor(e.target.value)}
                />
                <div className="modal-footer">
                  <Button onClick={() => setEditor(null)}>取消</Button>
                  <Button
                    primary
                    icon={Save}
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await call("workflow_save", {
                          workflow: JSON.parse(editor),
                        });
                        setEditor(null);
                        setLibraryType("scripts");
                        setView("legacy");
                      }, "流程草稿已保存")
                    }
                  >
                    保存草稿
                  </Button>
                </div>
              </>
            )}
            {runner && (
              <>
                <p className="modal-description">
                  选择已登录的网页并填写参数。执行后会检查流程的完成条件。
                </p>
                <label className="form-label">
                  目标网页
                  <select
                    value={runSession}
                    onChange={(e) => setRunSession(e.target.value)}
                  >
                    <option value="">选择一个打开的网页</option>
                    {sessions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title} · {host(s.url)}
                      </option>
                    ))}
                  </select>
                </label>
                {!sessions.length && (
                  <Button
                    icon={ExternalLink}
                    onClick={() =>
                      void perform(async () => {
                        const s = await call<Session>("browser_open", {
                          url: runner.startUrl,
                        });
                        setRunSession(s.id);
                      })
                    }
                  >
                    先打开流程入口网页
                  </Button>
                )}
                {runner.parameters.map((p) => (
                  <label className="form-label" key={p.name}>
                    {p.label}
                    {p.required && <span> *</span>}
                    {p.kind === "boolean" ? (
                      <select
                        value={inputs[p.name]}
                        onChange={(e) =>
                          setInputs({ ...inputs, [p.name]: e.target.value })
                        }
                      >
                        <option value="">使用默认值</option>
                        <option value="true">是</option>
                        <option value="false">否</option>
                      </select>
                    ) : (
                      <input
                        type={p.kind === "number" ? "number" : "text"}
                        value={inputs[p.name] || ""}
                        onChange={(e) =>
                          setInputs({ ...inputs, [p.name]: e.target.value })
                        }
                        placeholder={p.name}
                      />
                    )}
                  </label>
                ))}
                <div className="modal-footer">
                  <Button onClick={() => setRunner(null)}>取消</Button>
                  <Button
                    primary
                    icon={Play}
                    disabled={
                      busy ||
                      !runSession ||
                      runner.parameters.some(
                        (p) => p.required && !inputs[p.name],
                      )
                    }
                    onClick={() => void startRun()}
                  >
                    开始执行
                  </Button>
                </div>
              </>
            )}
            {detail &&
              (() => {
                const r = runs.find((r) => r.id === detail.id) || detail;
                return (
                  <>
                    <div className="detail-title">
                      <strong>{r.name}</strong>
                      <Badge status={r.status} />
                    </div>
                    <p className="modal-description">
                      {time(r.startedAt)} · {r.currentStep} / {r.totalSteps} 步
                    </p>
                    {r.error && (
                      <div className="detail-error">
                        <AlertCircle size={16} />
                        {r.error}
                      </div>
                    )}
                    <div className="event-list">
                      {r.events.map((e) => (
                        <div
                          key={e.step}
                          className={`event ${e.result.ok ? "" : "event-failed"}`}
                        >
                          <span>
                            {e.result.ok ? (
                              <Check size={14} />
                            ) : (
                              <X size={14} />
                            )}
                          </span>
                          <div>
                            <strong>{e.description}</strong>
                            <small>
                              {e.result.verified
                                ? "页面断言通过"
                                : e.result.error || "动作已执行"}{" "}
                              · {time(e.at)}
                            </small>
                          </div>
                        </div>
                      ))}
                      {!r.events.length && (
                        <p className="muted">正在等待第一步结果…</p>
                      )}
                    </div>
                    <div className="modal-footer">
                      {["running", "paused"].includes(r.status) && (
                        <>
                          <Button
                            icon={Square}
                            onClick={() =>
                              void perform(() =>
                                call("run_control", {
                                  runId: r.id,
                                  action: "stop",
                                }),
                              )
                            }
                          >
                            停止
                          </Button>
                          <Button
                            icon={r.status === "paused" ? Play : Pause}
                            onClick={() =>
                              void perform(() =>
                                call("run_control", {
                                  runId: r.id,
                                  action:
                                    r.status === "paused" ? "resume" : "pause",
                                }),
                              )
                            }
                          >
                            {r.status === "paused" ? "继续" : "暂停"}
                          </Button>
                        </>
                      )}
                      <Button primary onClick={() => setDetail(null)}>
                        关闭
                      </Button>
                    </div>
                  </>
                );
              })()}
          </section>
        </div>
      )}
    </div>
  );
}
