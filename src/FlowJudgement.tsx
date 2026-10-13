import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import Markdown, { type ExtraProps } from "react-markdown";

const CriteriaContext = createContext<{
  checked: Set<number>;
  toggle: (key: number) => void;
} | null>(null);

function CriterionItem({ children, node }: ComponentProps<"li"> & ExtraProps) {
  const id = useId();
  const criteria = useContext(CriteriaContext);
  const key = node?.position?.start.offset;
  if (!criteria || key === undefined) return <li>{children}</li>;
  return (
    <li
      className="flow-criterion"
      data-checked={criteria.checked.has(key)}
      onClick={(event) => {
        // Text and whitespace share the checkbox's hit area. Keep native label
        // activation, nested criteria and selecting the instructions intact.
        const target = event.target as Element;
        if (
          target.closest("input, label") ||
          target.closest(".flow-criterion") !== event.currentTarget ||
          window.getSelection()?.toString()
        )
          return;
        event.currentTarget
          .querySelector<HTMLInputElement>("input")
          ?.focus({ preventScroll: true });
        criteria.toggle(key);
      }}
    >
      <label className="flow-criterion-control">
        <input
          type="checkbox"
          className="flow-criterion-check"
          aria-labelledby={id}
          checked={criteria.checked.has(key)}
          onChange={() => criteria.toggle(key)}
        />
      </label>
      <div id={id} className="flow-criterion-text">
        {children}
      </div>
    </li>
  );
}

const components = {
  li: CriterionItem,
  ul: ({ children }: ComponentProps<"ul">) => <ul role="list">{children}</ul>,
  ol: ({ children, start }: ComponentProps<"ol">) => (
    <ol role="list" start={start}>
      {children}
    </ol>
  ),
  a: ({ children }: ComponentProps<"a">) => <span>{children}</span>,
  img: () => null,
};

export function FlowJudgement({ markdown }: { markdown: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [total, setTotal] = useState(0);
  useEffect(() => {
    setChecked(new Set());
    setTotal(
      container.current?.querySelectorAll(".flow-criterion-check").length || 0,
    );
  }, [markdown]);
  const toggle = (key: number) =>
    setChecked((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <div
      className="flow-criteria"
      ref={container}
      data-tracks-criteria={total > 0}
      data-complete={total > 0 && checked.size === total}
    >
      <div className="flow-criteria-heading">
        <h3 id="flow-judgement" tabIndex={-1}>
          判断条件
        </h3>
        {total > 0 && (
          <span
            className="flow-criteria-progress"
            role="status"
            aria-live="polite"
          >
            已核对 {checked.size} / {total}
          </span>
        )}
      </div>
      <CriteriaContext.Provider value={{ checked, toggle }}>
        <Markdown components={components}>{markdown}</Markdown>
      </CriteriaContext.Provider>
      {total > 0 && <p className="flow-criteria-note">标记仅本次查看有效。</p>}
    </div>
  );
}
