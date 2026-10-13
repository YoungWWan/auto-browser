import { useState, useCallback } from "react";
import Markdown from "react-markdown";
import { BookOpen, Copy, Download, Pencil, Plus, Save, X } from "lucide-react";
import type { Guide, Parameter } from "./types";
import { useDialogFocus } from "./useDialogFocus";

export function GuideDialog({
  guide,
  editing,
  onClose,
  onSave,
  onCopy,
  onExport,
}: {
  guide: Guide;
  editing: boolean;
  onClose: () => void;
  onSave: (guide: Guide) => Promise<void>;
  onCopy: (guide: Guide) => void;
  onExport: (guide: Guide) => void;
}) {
  const [draft, setDraft] = useState(guide);
  const [edit, setEdit] = useState(editing);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [tagsText, setTagsText] = useState(guide.tags.join(", "));
  const dismiss = useCallback(() => { if (!saving) onClose(); }, [saving, onClose]);
  useDialogFocus(true, dismiss);
  const field = <K extends keyof Guide>(key: K, value: Guide[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const parameter = (index: number, patch: Partial<Parameter>) =>
    field(
      "parameters",
      draft.parameters.map((p, i) => (i === index ? { ...p, ...patch } : p)),
    );
  async function save() {
    setSaving(true);
    setError("");
    try {
      await onSave({
        ...draft,
        tags: tagsText
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean),
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        className="modal guide-modal"
        role="dialog"
        aria-modal="true"
        aria-label={edit ? "编辑 AI 操作指南" : "AI 操作指南"}
      >
        <div className="modal-header">
          <h2>
            <BookOpen size={20} /> {edit ? "编辑 AI 操作指南" : draft.name}
          </h2>
          <button
            className="icon-button"
            aria-label="关闭指南"
            onClick={onClose}
            disabled={saving}
          >
            <X size={18} />
          </button>
        </div>
        <p className="modal-description">
          {edit
            ? "用文字说明业务目标、页面线索和完成条件，让 Agent 根据实际网页选择动作。"
            : "Agent 读取这份指南，观察当前页面并决定下一步。读取指南不会自动操作网页。"}
        </p>
        {error && (
          <div className="detail-error" role="alert">
            {error}
          </div>
        )}
        <div className="guide-scroll">
          {edit ? (
            <>
              <div className="guide-fields">
                <label className="form-label">
                  指南名称
                  <input
                    value={draft.name}
                    onChange={(e) => field("name", e.target.value)}
                  />
                </label>
                <label className="form-label">
                  一句话说明
                  <input
                    value={draft.description}
                    onChange={(e) => field("description", e.target.value)}
                  />
                </label>
                <label className="form-label">
                  入口网址
                  <input
                    placeholder="https://example.com/…"
                    value={draft.startUrl}
                    onChange={(e) => {
                      const url = e.target.value;
                      field("startUrl", url);
                      try {
                        field(
                          "domain",
                          url === "auto-browser://demo"
                            ? "127.0.0.1"
                            : new URL(url).hostname,
                        );
                      } catch {}
                    }}
                  />
                </label>
                <label className="form-label">
                  适用域名
                  <input
                    placeholder="example.com"
                    value={draft.domain}
                    onChange={(e) => field("domain", e.target.value)}
                  />
                </label>
                <label className="form-label guide-tags">
                  标签（逗号分隔）
                  <input
                    value={tagsText}
                    onChange={(e) => setTagsText(e.target.value)}
                  />
                </label>
              </div>
              <div className="guide-input-heading">
                <strong>本次输入</strong>
                <button
                  className="button small"
                  onClick={() =>
                    field("parameters", [
                      ...draft.parameters,
                      { name: "", label: "", kind: "string", required: false },
                    ])
                  }
                >
                  <Plus size={14} /> 添加输入
                </button>
              </div>
              <p className="guide-help">
                声明 Agent
                需要的资料；正文中可以直接用参数名说明用途，无需编写替换表达式。
              </p>
              {draft.parameters.map((p, i) => (
                <div className="guide-parameter" key={i}>
                  <input
                    aria-label={`输入 ${i + 1} 的参数名`}
                    placeholder="参数名，如 name"
                    value={p.name}
                    onChange={(e) => parameter(i, { name: e.target.value })}
                  />
                  <input
                    aria-label={`输入 ${i + 1} 的说明`}
                    placeholder="说明，如客户姓名"
                    value={p.label}
                    onChange={(e) => parameter(i, { label: e.target.value })}
                  />
                  <select
                    aria-label={`输入 ${i + 1} 的类型`}
                    value={p.kind}
                    onChange={(e) =>
                      parameter(i, {
                        kind: e.target.value as Parameter["kind"],
                        default: undefined,
                      })
                    }
                  >
                    <option value="string">文本</option>
                    <option value="number">数字</option>
                    <option value="boolean">布尔值</option>
                  </select>
                  <label className="guide-required">
                    <input
                      type="checkbox"
                      checked={p.required}
                      onChange={(e) =>
                        parameter(i, { required: e.target.checked })
                      }
                    />{" "}
                    必填
                  </label>
                  <button
                    className="icon-button"
                    aria-label={`移除输入 ${i + 1}`}
                    onClick={() =>
                      field(
                        "parameters",
                        draft.parameters.filter((_, n) => n !== i),
                      )
                    }
                  >
                    <X size={15} />
                  </button>
                  {p.default != null && (
                    <small>默认值：{String(p.default)}</small>
                  )}
                </div>
              ))}
              <div className="guide-input-heading">
                <strong>指南正文</strong>
                <div
                  className="guide-tabs"
                  role="tablist"
                  aria-label="正文视图"
                >
                  <button
                    role="tab"
                    aria-selected={!preview}
                    onClick={() => setPreview(false)}
                  >
                    Markdown
                  </button>
                  <button
                    role="tab"
                    aria-selected={preview}
                    onClick={() => setPreview(true)}
                  >
                    阅读预览
                  </button>
                </div>
              </div>
              {preview ? (
                <GuideBody content={draft.content} />
              ) : (
                <textarea
                  className="guide-editor"
                  aria-label="指南 Markdown 正文"
                  spellCheck={false}
                  value={draft.content}
                  onChange={(e) => field("content", e.target.value)}
                />
              )}
            </>
          ) : (
            <>
              <div className="guide-context">
                <span>
                  {draft.startUrl === "auto-browser://demo"
                    ? "本地练习页面"
                    : draft.domain}
                </span>
                <span>v{draft.version}</span>
                <span>AI 操作指南</span>
              </div>
              {draft.parameters.length > 0 && (
                <div className="guide-inputs">
                  <strong>需要提供的资料</strong>
                  {draft.parameters.map((p) => (
                    <div key={p.name}>
                      <code>{p.name}</code>
                      <span>{p.label}</span>
                      <small>
                        {p.required ? "必填" : "可选"}
                        {p.default != null
                          ? ` · 默认 ${String(p.default)}`
                          : ""}
                      </small>
                    </div>
                  ))}
                </div>
              )}
              <GuideBody content={draft.content} />
            </>
          )}
        </div>
        <div className="modal-footer">
          {edit ? (
            <>
              <button className="button" onClick={onClose} disabled={saving}>
                取消
              </button>
              <button
                className="button primary"
                onClick={() => void save()}
                disabled={saving}
              >
                <Save size={15} /> {saving ? "保存中…" : "保存指南"}
              </button>
            </>
          ) : (
            <>
              <button className="button" onClick={() => setEdit(true)}>
                <Pencil size={15} /> 编辑
              </button>
              <button className="button" onClick={() => onExport(draft)}>
                <Download size={15} /> 导出 Markdown
              </button>
              <button className="button primary" onClick={() => onCopy(draft)}>
                <Copy size={15} /> 复制给 Agent
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function GuideBody({ content }: { content: string }) {
  return (
    <div className="guide-markdown">
      <Markdown
        skipHtml
        components={{
          a: ({ children, href }) => <span title={href}>{children}</span>,
          img: ({ alt }) => <span>{alt || "图片"}</span>,
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
