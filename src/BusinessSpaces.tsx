import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Folder,
  Globe,
  Pencil,
  Plus,
  Search,
  Settings2,
  X,
} from "lucide-react";
import type { Domain, Website } from "./flowTypes";
import type { Session } from "./types";
import { call } from "./api";

export function SpaceSwitcher({
  domains,
  selected,
  managementView,
  expanded,
  disabled,
  toggle,
  select,
  create,
  manage,
}: {
  domains: Domain[];
  selected: string;
  managementView?: boolean;
  expanded: boolean;
  disabled: boolean;
  toggle: (open: boolean) => void;
  select: (id: string) => void;
  create: () => void;
  manage: () => void;
}) {
  const [query, setQuery] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const current = domains.find((d) => d.id === selected);
  useEffect(() => {
    if (!expanded) return;
    setQuery("");
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        toggle(false);
        trigger.current?.focus();
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [expanded, toggle]);
  function close() {
    toggle(false);
    trigger.current?.focus();
  }
  return (
    <div className="space-switcher">
      <span className="space-label">当前工作空间</span>
      <button
        ref={trigger}
        className={`space-trigger ${expanded ? "expanded" : ""} ${managementView ? "management-selected" : ""}`}
        aria-current={managementView ? "page" : undefined}
        aria-label={`切换业务空间：${current?.name || "全部业务空间"}`}
        aria-expanded={expanded}
        aria-controls="space-picker"
        title={current?.name || "选择或管理业务空间"}
        disabled={disabled}
        onClick={() => toggle(!expanded)}
      >
        <Folder size={18} />
        <strong>
          {current?.name ||
            (domains.length ? "全部业务空间" : "创建你的第一个空间")}
        </strong>
        <ChevronDown size={15} />
      </button>
      {expanded && (
        <>
          <button
            className="space-menu-dismiss"
            aria-label="关闭业务空间菜单"
            onClick={close}
            tabIndex={-1}
          />
          <div
            className="space-menu"
            id="space-picker"
            role="dialog"
            aria-label="切换业务空间"
          >
            <label className="space-search">
              <Search size={15} />
              <input
                autoFocus
                placeholder="搜索业务空间"
                aria-label="搜索业务空间"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="space-options">
              {!query && (
                <button
                  className="space-option"
                  onClick={() => {
                    close();
                    select("");
                  }}
                >
                  <Globe size={17} />
                  <span>
                    <strong>全部业务空间</strong>
                    <small>查看所有网页与流程</small>
                  </span>
                  {!selected && <Check size={16} />}
                </button>
              )}
              {domains
                .filter((d) =>
                  d.name.toLowerCase().includes(query.toLowerCase()),
                )
                .map((d) => (
                  <button
                    className={`space-option ${d.id === selected ? "current" : ""}`}
                    key={d.id}
                    onClick={() => {
                      close();
                      select(d.id);
                    }}
                  >
                    <Folder size={17} />
                    <span>
                      <strong>{d.name}</strong>
                      <small>
                        {d.websites.length
                          ? `${d.websites.length} 个网站入口`
                          : "尚未添加网站入口"}
                      </small>
                    </span>
                    {d.id === selected && <Check size={16} />}
                  </button>
                ))}
              {query &&
                !domains.some((d) =>
                  d.name.toLowerCase().includes(query.toLowerCase()),
                ) && <p className="space-search-empty">没有找到这个业务空间</p>}
              {!domains.length && (
                <p className="space-search-empty">
                  为一类业务建一个空间，留下相关网页和流程。
                </p>
              )}
            </div>
            <div className="space-menu-actions">
              <button
                onClick={() => {
                  close();
                  create();
                }}
              >
                <Plus size={16} />
                新建业务空间
              </button>
              <button
                onClick={() => {
                  close();
                  manage();
                }}
              >
                <Settings2 size={16} />
                管理业务空间
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function BusinessSpaces({
  domains,
  selected,
  sessions,
  enter,
  edit,
  create,
  open,
}: {
  domains: Domain[];
  selected: string;
  sessions: Session[];
  enter: (id: string) => void;
  edit: (space: Domain) => void;
  create: () => void;
  open: (url: string, domainId: string) => Promise<void>;
}) {
  const [inspected, setInspected] = useState(selected);
  const [query, setQuery] = useState("");
  const space =
    domains.find((d) => d.id === inspected) ||
    domains.find((d) => d.id === selected) ||
    domains[0];
  return (
    <section className="flow-page spaces-page">
      <div className="page-heading">
        <div>
          <h1>业务空间</h1>
          <p>把相关网站和流程放在一起，按业务切换。</p>
        </div>
        <button className="button primary" onClick={create}>
          <Plus size={15} />
          新建业务空间
        </button>
      </div>
      {!domains.length ? (
        <div className="flow-empty">
          <Folder size={32} />
          <h2>创建你的第一个业务空间</h2>
          <p>
            例如「客户管理」或「内容发布」。每个空间可以添加一个或多个网站。
          </p>
          <button className="button primary" onClick={create}>
            新建业务空间
          </button>
        </div>
      ) : (
        <div className="spaces-layout">
          <div className="spaces-directory">
            <label className="space-search">
              <Search size={15} />
              <input
                aria-label="查找业务空间"
                placeholder="查找业务空间"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="spaces-directory-list">
              {domains
                .filter((d) =>
                  d.name.toLowerCase().includes(query.toLowerCase()),
                )
                .map((d) => (
                  <button
                    className={`space-directory-item ${space?.id === d.id ? "selected" : ""}`}
                    key={d.id}
                    aria-pressed={space?.id === d.id}
                    onClick={() => setInspected(d.id)}
                  >
                    <Folder size={18} />
                    <span>
                      <strong>{d.name}</strong>
                      <small>
                        {d.websites.length} 个网站 ·{" "}
                        {sessions.filter((s) => s.domainId === d.id).length}{" "}
                        个已打开网页
                      </small>
                    </span>
                    {d.id === selected && (
                      <span className="space-current-label">当前</span>
                    )}
                  </button>
                ))}
              {query &&
                !domains.some((d) =>
                  d.name.toLowerCase().includes(query.toLowerCase()),
                ) && <p className="space-search-empty">没有找到这个业务空间</p>}
            </div>
          </div>
          {space && (
            <article className="space-overview">
              <div className="space-overview-header">
                <span className="space-folder">
                  <Folder size={23} />
                </span>
                <div>
                  <h2>{space.name}</h2>
                  <p>
                    {space.description ||
                      "在这个空间里打开网页，录制并积累业务流程。"}
                  </p>
                </div>
              </div>
              <div className="space-overview-actions">
                <div>
                  <button
                    className="button primary"
                    aria-describedby="space-enter-note"
                    onClick={() => enter(space.id)}
                  >
                    进入业务空间
                    <ArrowRight size={15} />
                  </button>
                  <p className="space-action-note" id="space-enter-note">
                    切换到这个空间的网页工作区。
                  </p>
                </div>
                <div>
                  <button
                    className="button"
                    aria-describedby="space-edit-note"
                    onClick={() => edit(space)}
                  >
                    <Pencil size={14} />
                    编辑空间
                  </button>
                  <p className="space-action-note" id="space-edit-note">
                    编辑名称与网站入口，保持当前工作区。
                  </p>
                </div>
              </div>
              <div className="space-sites-heading">
                <h3>网站入口</h3>
                <button className="text-button" onClick={() => edit(space)}>
                  <Plus size={14} />
                  管理网站
                </button>
              </div>
              <div className="space-sites">
                {space.websites.map((w) => (
                  <button
                    key={w.id}
                    onClick={() => void open(w.entryUrl, space.id)}
                    aria-label={`打开网站 ${w.name || w.entryUrl}`}
                  >
                    <Globe size={19} />
                    <span>
                      <strong>{w.name || "网站"}</strong>
                      <small>{w.entryUrl}</small>
                    </span>
                    <ArrowUpRight size={16} aria-hidden="true" />
                  </button>
                ))}
              </div>
              {!space.websites.length && (
                <div className="space-sites-empty">
                  <p>
                    还没有网站入口。进入空间后可以直接输入网址，也可以把常用网站加在这里。
                  </p>
                  <button className="button small" onClick={() => edit(space)}>
                    <Plus size={14} />
                    添加网站入口
                  </button>
                </div>
              )}
            </article>
          )}
        </div>
      )}
    </section>
  );
}

export function SpaceEditor({
  initial,
  save,
  close,
  fail,
}: {
  initial: Partial<Domain>;
  save: (space: Domain, created: boolean) => Promise<void>;
  close: () => void;
  fail: (message: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const created = !initial.id;
  const form = useRef<HTMLFormElement>(null);
  const busyState = useRef(busy);
  busyState.current = busy;
  const returnFocus = useRef(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyState.current) close();
      if (e.key !== "Tab") return;
      const elements = [
        ...(form.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input, textarea",
        ) || []),
      ];
      const first = elements[0],
        last = elements.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      }
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      returnFocus.current?.focus();
    };
  }, [close]);
  function updateWebsite(id: string, patch: Partial<Website>) {
    setDraft({
      ...draft,
      websites: draft.websites?.map((w) =>
        w.id === id ? { ...w, ...patch } : w,
      ),
    });
  }
  return (
    <div className="modal-backdrop">
      <form
        ref={form}
        className="modal domain-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="space-editor-title"
        onSubmit={(e) => {
          e.preventDefault();
          void (async () => {
            setBusy(true);
            setError("");
            try {
              const space = await call<Domain>(
                created ? "domain_create" : "domain_update",
                {
                  ...(initial.id ? { domainId: initial.id } : {}),
                  name: draft.name?.trim(),
                  description: draft.description || "",
                  websites: draft.websites || [],
                },
              );
              await save(space, created);
            } catch (err) {
              setError(String(err));
              fail(String(err));
            } finally {
              setBusy(false);
            }
          })();
        }}
      >
        <div className="modal-header">
          <h2 id="space-editor-title">
            {created ? "新建业务空间" : "编辑业务空间"}
          </h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭空间编辑"
            disabled={busy}
            onClick={close}
          >
            <X size={18} />
          </button>
        </div>
        <p className="space-editor-description">
          给一类业务起个名字。网站入口可以稍后添加。
        </p>
        <label>
          空间名称
          <input
            required
            autoFocus
            maxLength={120}
            placeholder="例如：客户管理"
            value={draft.name || ""}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label>
          业务说明<span className="field-optional">选填</span>
          <textarea
            placeholder="这个空间用于处理哪些业务？"
            value={draft.description || ""}
            onChange={(e) =>
              setDraft({ ...draft, description: e.target.value })
            }
          />
        </label>
        <div className="domain-websites">
          <h3>
            网站入口 <span className="field-optional">选填，可添加多个</span>
          </h3>
          {draft.websites?.map((w, i) => (
            <div key={w.id}>
              <input
                aria-label={`网站 ${i + 1} 名称`}
                placeholder="网站名称"
                value={w.name}
                onChange={(e) => updateWebsite(w.id, { name: e.target.value })}
              />
              <input
                aria-label={`网站 ${i + 1} 地址`}
                required
                placeholder="https://…"
                value={w.entryUrl}
                onChange={(e) =>
                  updateWebsite(w.id, { entryUrl: e.target.value })
                }
              />
              <button
                type="button"
                className="icon-button"
                aria-label={`移除网站 ${i + 1}`}
                onClick={() =>
                  setDraft({
                    ...draft,
                    websites: draft.websites?.filter((s) => s.id !== w.id),
                  })
                }
              >
                <X size={15} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="button small"
            disabled={(draft.websites?.length || 0) >= 30 || busy}
            onClick={() =>
              setDraft({
                ...draft,
                websites: [
                  ...(draft.websites || []),
                  { id: crypto.randomUUID(), name: "", entryUrl: "" },
                ],
              })
            }
          >
            <Plus size={14} />
            添加网站入口
          </button>
        </div>
        {error && (
          <p className="space-editor-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-footer">
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={close}
          >
            取消
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={busy || !draft.name?.trim()}
          >
            {busy ? "保存中…" : created ? "创建并进入空间" : "保存修改"}
          </button>
        </div>
      </form>
    </div>
  );
}
