import { parse, stringify } from "yaml";
import type { Guide, Step, Parameter } from "./types";

export function blankGuide(startUrl = "", domain = ""): Guide {
  return {
    id: "",
    name: "新的操作指南",
    description: "",
    version: 0,
    startUrl,
    domain,
    tags: [],
    parameters: [],
    updatedAt: "",
    content: `## 目标\n\n说明这次流程要达成什么业务结果。\n\n## 开始之前\n\n说明适用页面、登录要求和本次需要提供的信息。\n\n## 操作思路\n\n### 1. 第一步\n\n- 观察：根据哪些页面线索判断当前位置。\n- 操作：要完成什么，不要求使用固定选择器。\n- 检查：如何判断这一步已完成，再进入下一步。\n\n## 完成判断\n\n说明哪些页面结果能证明整个任务完成，以及应向用户返回什么。\n\n## 异常处理\n\n说明遇到校验错误、登录过期、页面变化或结果不确定时如何处理。`,
  };
}

export function guideFromTrace(
  steps: Step[],
  startUrl: string,
  domain: string,
): Guide {
  const guide = blankGuide(startUrl, domain);
  const verbs: Record<string, string> = {
    fill: "填写本次输入",
    click: "点击对应入口或按钮",
    select: "根据本次要求选择选项",
    check: "根据本次要求设置勾选状态",
    press: "执行适合当前页面的键盘操作",
    scroll: "滚动以找到目标内容",
    wait: "等待所需页面状态出现",
  };
  const hints = steps
    .filter((s) => !s.kind.startsWith("assert_"))
    .map((s, i) => {
      // Never copy recorded business values, CSS selectors or arbitrary descriptions.
      const target = s.target?.label || s.target?.text;
      const clue = target
        ? `查找含义为「${target}」的可见控件，核查唯一性`
        : "重新观察页面，补充本步对应的业务控件与页面线索";
      return `### ${i + 1}. 待补充的操作\n\n- 观察：${clue}。\n- 操作：${verbs[s.kind] || "结合当前页面完成本步操作"}；补充业务目的与输入名称。\n- 检查：补充本步完成的页面标志。`;
    })
    .join("\n\n");
  guide.content = `> 这是依据操作类型与控件标签整理的草稿，尚未经过 AI 归纳或业务验证。记录中的实际填写值未复制，请补充目标、输入、完成条件与异常策略。\n\n## 目标\n\n待补充。\n\n## 开始之前\n\n待补充：适用页面、登录要求、本次输入。\n\n## 操作思路\n\n${hints || "待补充：此次记录只有断言，请填写实际操作思路。"}\n\n## 完成判断\n\n待补充：根据业务结果判断成功，不能只根据动作返回成功。\n\n## 异常处理\n\n待补充：页面变化、校验错误、登录过期与提交结果不确定的处理。`;
  return guide;
}

export function guideMarkdown(g: Guide): string {
  const metadata = {
    kind: "ai-guide",
    name: g.name,
    description: g.description,
    startUrl: g.startUrl,
    domain: g.domain,
    tags: g.tags,
    parameters: g.parameters,
  };
  return `---\n${stringify(metadata)}---\n\n${g.content}\n`;
}

export function parseGuideFile(text: string, filename: string): Guide {
  if (filename.toLowerCase().endsWith(".json")) {
    const data = JSON.parse(text);
    if (!data || typeof data.content !== "string")
      throw new Error(
        "指南 JSON 需要 Markdown content 正文；回放脚本请在「脚本回放」中导入。",
      );
    return importedGuide(data, data.content);
  }
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(
    text,
  );
  const base = blankGuide();
  if (!match)
    return { ...base, name: filename.replace(/\.[^.]+$/, ""), content: text };
  const data = parse(match[1], { maxAliasCount: 20 });
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("指南元信息必须是对象");
  if (data.kind && data.kind !== "ai-guide")
    throw new Error("该文件不是 AI 操作指南");
  return importedGuide(data, match[2].trim());
}

function importedGuide(data: Record<string, unknown>, content: string): Guide {
  const result = blankGuide();
  for (const key of ["name", "description", "startUrl", "domain"] as const) {
    if (data[key] !== undefined) {
      if (typeof data[key] !== "string")
        throw new Error(`指南 ${key} 必须是文本`);
      result[key] = data[key];
    }
  }
  if (data.tags !== undefined) {
    if (
      !Array.isArray(data.tags) ||
      !data.tags.every((t) => typeof t === "string")
    )
      throw new Error("指南标签必须是文本列表");
    result.tags = data.tags;
  }
  if (data.parameters !== undefined) {
    if (!Array.isArray(data.parameters)) throw new Error("指南输入必须是列表");
    result.parameters = data.parameters.map((p) => {
      if (
        !p ||
        typeof p !== "object" ||
        typeof p.name !== "string" ||
        typeof p.label !== "string" ||
        (p.kind !== undefined &&
          !["string", "number", "boolean"].includes(p.kind)) ||
        (p.required !== undefined && typeof p.required !== "boolean")
      )
        throw new Error("指南输入格式无效，需要参数名、说明和有效类型");
      return {
        name: p.name,
        label: p.label,
        kind: p.kind || "string",
        required: p.required ?? false,
        ...(p.default != null ? { default: p.default } : {}),
      } as Parameter;
    });
  }
  result.content = content;
  return result;
}
