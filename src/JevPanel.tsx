import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Bot,
  ChevronDown,
  KeyRound,
  LoaderCircle,
  Save,
  Square,
  Trash2,
} from "lucide-react";
import { call } from "./api";
import type { Domain } from "./flowTypes";

export type DelegateTask = {
  id: string;
  sessionId: string;
  domainId: string;
  goal: string;
  provider: string;
  model: string;
  status: string;
  startedAt: string;
  finishedAt?: string | null;
  error?: string | null;
  elapsedMs: number;
  apiMs: number;
  inputTokens: number;
  outputTokens: number;
  events: {
    at: string;
    choice: string;
    confidence?: number | null;
    action: string;
    executed: boolean;
    reason?: string | null;
    apiMs: number;
  }[];
};
type Settings = {
  provider: "typesafe" | "openrouter";
  model: string;
  enabledDomainIds: string[];
  minConfidence: number;
};
type SettingsStatus = Settings & {
  credentials: Record<Settings["provider"], boolean>;
  configurationError?: string | null;
};
const taskLabels: Record<string, string> = {
  running: "执行中",
  stopping: "正在停止",
  stopped: "已停止",
  needs_verification: "等待 Agent 核查",
  blocked: "需要 Agent 接手",
  low_confidence: "Jev 不确定",
  no_progress: "页面没有变化",
  budget: "时间限制",
  step_limit: "次数限制",
  loading_timeout: "等待超时",
  action_error: "操作失败",
  error: "请求或页面异常",
  interrupted: "已中断",
};
const providerLabels = { typesafe: "TypeSafe", openrouter: "OpenRouter" };
export async function stopDelegate(taskId: string) {
  return call("browser_delegate_stop", { taskId });
}
export function DelegateTasks({
  tasks,
  fail,
  refresh,
  compact = false,
}: {
  tasks: DelegateTask[];
  fail: (message: string) => void;
  refresh: () => Promise<void>;
  compact?: boolean;
}) {
  const [stopping, setStopping] = useState<string[]>([]);
  async function stop(id: string) {
    setStopping((old) => [...old, id]);
    try {
      await stopDelegate(id);
      await refresh();
    } catch (error) {
      fail(String(error));
      setStopping((old) => old.filter((item) => item !== id));
    }
  }
  return (
    <div className={`delegate-tasks ${compact ? "compact" : ""}`}>
      {tasks.slice(0, compact ? 1 : 10).map((task) => (
        <article
          className={`delegate-task status-${task.status}`}
          key={task.id}
        >
          <div className="delegate-task-heading">
            <Bot size={17} />
            <div>
              <strong>{task.goal}</strong>
              <span>
                {taskLabels[task.status] || task.status} ·{" "}
                {providerLabels[task.provider as Settings["provider"]] ||
                  task.provider}
              </span>
            </div>
            {!task.finishedAt && (
              <button
                className="button small"
                disabled={
                  stopping.includes(task.id) || task.status === "stopping"
                }
                onClick={() => void stop(task.id)}
              >
                <Square size={13} />
                {stopping.includes(task.id) || task.status === "stopping"
                  ? "正在停止"
                  : "停止委派"}
              </button>
            )}
          </div>
          {task.error && <p className="delegate-error">{task.error}</p>}
          {!compact && (
            <>
              <p className="delegate-metrics">
                {task.events.filter((event) => event.executed).length} 次操作 ·{" "}
                {(task.elapsedMs / 1000).toFixed(1)} 秒 · 决策{" "}
                {(task.apiMs / 1000).toFixed(1)} 秒 · {task.inputTokens} 输入 /{" "}
                {task.outputTokens} 输出 token
              </p>
              {task.events.length > 0 && (
                <details>
                  <summary>
                    查看决策与操作记录 <ChevronDown size={13} />
                  </summary>
                  <ol className="operation-sequence" role="list">
                    {task.events.map((event, index) => (
                      <li key={`${event.at}-${index}`}>
                        <span className="operation-index" aria-hidden="true">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <div>
                          <strong>{event.action}</strong>
                          <span>
                            {event.executed
                              ? "已执行"
                              : event.reason === "stale_state"
                                ? "页面变化，重新观察"
                                : "未执行"}
                            {event.confidence != null &&
                              ` · 置信度 ${event.confidence.toFixed(2)}`}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </>
          )}
        </article>
      ))}
      {!tasks.length && !compact && (
        <p className="jev-empty">
          还没有委派记录。配置后，让你的 Agent 指定网页和子目标开始操作。
        </p>
      )}
    </div>
  );
}

export function JevPanel({
  domains,
  fail,
  notice,
  refresh,
}: {
  domains: Domain[];
  fail: (message: string) => void;
  notice: (message: string) => void;
  refresh: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<Settings>();
  const [saved, setSaved] = useState<SettingsStatus>();
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  async function load() {
    setLoadError("");
    try {
      const result = await invoke<SettingsStatus>("jev_settings");
      setSettings({
        provider: result.provider,
        model: result.model,
        enabledDomainIds: result.enabledDomainIds,
        minConfidence: result.minConfidence,
      });
      setSaved(result);
    } catch (error) {
      setLoadError(String(error));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!settings) return;
    setBusy(true);
    try {
      await invoke("jev_save_settings", {
        settings,
        apiKey: apiKey.trim() || null,
      });
      setApiKey("");
      await load();
      await refresh();
      notice("Jev 配置已保存，Agent 可以委派已启用空间的网页操作");
    } catch (error) {
      fail(String(error));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!settings) return;
    setBusy(true);
    try {
      await invoke("jev_remove_credential", { provider: settings.provider });
      setApiKey("");
      await load();
      await refresh();
      notice("API Key 已移除，相关空间的 Jev 已停用");
    } catch (error) {
      fail(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="connection-card jev-panel">
      <div className="jev-title">
        <Bot size={22} />
        <div>
          <h2>Jev 快速网页操作</h2>
          <p>让你的 Agent 把一段网页操作委派给 Jev。</p>
        </div>
        <span>可选</span>
      </div>
      {!settings ? (
        <div className="jev-loading">
          {loadError || "正在读取本机配置…"}
          {loadError && (
            <button className="button small" onClick={() => void load()}>
              重新读取配置
            </button>
          )}
        </div>
      ) : (
        <form onSubmit={(event) => void save(event)}>
          {saved?.configurationError && (
            <p role="alert" className="delegate-error">
              {saved.configurationError}
            </p>
          )}
          <fieldset disabled={busy}>
            <div className="jev-fields">
              <label>
                供应商
                <select
                  aria-label="Jev 供应商"
                  value={settings.provider}
                  onChange={(event) => {
                    const provider = event.target.value as Settings["provider"];
                    setSettings({
                      ...settings,
                      provider,
                      model:
                        provider === "typesafe"
                          ? "jev-latest"
                          : "~typesafe/jev-latest",
                    });
                    setApiKey("");
                  }}
                >
                  <option value="typesafe">TypeSafe</option>
                  <option value="openrouter">OpenRouter</option>
                </select>
              </label>
              <label>
                模型
                <input
                  aria-label="Jev 模型"
                  value={settings.model}
                  required
                  onChange={(event) =>
                    setSettings({ ...settings, model: event.target.value })
                  }
                />
              </label>
            </div>
            <label className="jev-key-label">
              <span>
                <KeyRound size={14} />
                API Key{" "}
                <small>
                  {saved?.credentials[settings.provider]
                    ? "已保存在系统凭据库"
                    : "尚未配置"}
                </small>
              </span>
              <input
                aria-label="Jev API Key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                placeholder={
                  saved?.credentials[settings.provider]
                    ? "留空保留已有密钥，输入新密钥可替换"
                    : `输入 ${providerLabels[settings.provider]} 的 API Key`
                }
                onChange={(event) => setApiKey(event.target.value)}
              />
            </label>
            <div className="jev-domain-consent">
              <h3>允许 Jev 操作的业务空间</h3>
              <p>
                启用后，这些空间的网页文字与任务目标会发送给{" "}
                {providerLabels[settings.provider]}，用于选择下一步动作。
              </p>
              {domains.map((domain) => (
                <label key={domain.id}>
                  <input
                    type="checkbox"
                    checked={settings.enabledDomainIds.includes(domain.id)}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        enabledDomainIds: event.target.checked
                          ? [...settings.enabledDomainIds, domain.id]
                          : settings.enabledDomainIds.filter(
                              (id) => id !== domain.id,
                            ),
                      })
                    }
                  />
                  允许 Jev 操作「{domain.name}」
                </label>
              ))}
              {!domains.length && <p>先新建业务空间，再为它启用 Jev。</p>}
            </div>
            <details className="jev-advanced">
              <summary>决策设置</summary>
              <label>
                最低置信度
                <input
                  aria-label="Jev 最低置信度"
                  type="number"
                  min="0.55"
                  max="1"
                  step="0.05"
                  value={settings.minConfidence}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      minConfidence: Number(event.target.value),
                    })
                  }
                />
              </label>
              <p>低于阈值时返回主 Agent；达到阈值也不代表业务已完成。</p>
            </details>
            <div className="jev-actions">
              <button type="submit" className="button primary">
                {busy ? <LoaderCircle size={14} /> : <Save size={14} />}保存 Jev
                配置
              </button>
              {saved?.credentials[settings.provider] && (
                <button
                  className="button small"
                  type="button"
                  onClick={() => void remove()}
                >
                  <Trash2 size={13} />
                  移除 API Key
                </button>
              )}
            </div>
          </fieldset>
          <p className="jev-save-note">保存配置会停止当前委派。</p>
          <details className="jev-scope">
            <summary>Jev 的操作范围</summary>
            <p>
              支持点击、链接导航、滚动和等待；填写资料、调用工作包脚本、归档与最终核查由主
              Agent 完成。
            </p>
          </details>
        </form>
      )}
    </section>
  );
}
