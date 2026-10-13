import { ArrowRight, Braces, Globe2, Layers } from "lucide-react";

/** A compact map of the real product workflow, used in the first-run state. */
export function WorkflowPath() {
  return (
    <ol className="workflow-path" aria-label="从网页到可复用流程">
      <li>
        <span className="path-node">
          <Globe2 size={21} />
        </span>
        <span className="path-number">01</span>
        <strong>打开网页</strong>
        <small>在应用内登录与操作</small>
        <ArrowRight className="path-arrow" size={16} aria-hidden="true" />
      </li>
      <li>
        <span className="path-node">
          <Braces size={21} />
        </span>
        <span className="path-number">02</span>
        <strong>录制与整理</strong>
        <small>由你的 Agent 归档</small>
        <ArrowRight className="path-arrow" size={16} aria-hidden="true" />
      </li>
      <li>
        <span className="path-node path-node-final">
          <Layers size={21} />
        </span>
        <span className="path-number">03</span>
        <strong>留下工作流</strong>
        <small>换一份数据，再次使用</small>
      </li>
    </ol>
  );
}
