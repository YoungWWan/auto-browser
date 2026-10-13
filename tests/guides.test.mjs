import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blankGuide,
  guideMarkdown,
  parseGuideFile,
  guideFromTrace,
} from "../src/guides.ts";

test("portable Markdown preserves instructions and typed inputs while creating a new identity", () => {
  const guide = {
    ...blankGuide("https://example.com/form", "example.com"),
    id: "local-id",
    version: 7,
    name: "客户: 新增\n指南",
    tags: ["表单", "客户"],
    parameters: [
      {
        name: "notify",
        label: "订阅",
        kind: "boolean",
        required: false,
        default: false,
      },
    ],
    content:
      "## 目标\n\n按当前页面判断下一步。\n\n## 完成判断\n\n核查业务结果。",
  };
  const imported = parseGuideFile(
    guideMarkdown(guide).replaceAll("\n", "\r\n"),
    "guide.md",
  );
  assert.equal(imported.id, "");
  assert.equal(imported.version, 0);
  assert.equal(imported.content.replaceAll("\r\n", "\n"), guide.content);
  assert.deepEqual(imported.parameters, guide.parameters);
  assert.equal(imported.name, guide.name);
  assert.deepEqual(imported.tags, guide.tags);
});

test("plain Markdown stays editable and trace scaffolding omits recorded values and selectors", () => {
  const plain = parseGuideFile("## 目标\n填写客户资料", "我的流程.md");
  assert.equal(plain.name, "我的流程");
  assert.equal(plain.startUrl, "");
  const guide = guideFromTrace(
    [
      {
        kind: "fill",
        target: { label: "邮箱" },
        value: "private@example.com",
        description: "填写 private@example.com",
      },
      {
        kind: "click",
        target: { selector: "#unstable-123" },
        description: "private-name",
      },
    ],
    "https://example.com/form",
    "example.com",
  );
  assert.match(guide.content, /邮箱/);
  assert.match(guide.content, /待补充/);
  for (const literal of [
    "private@example.com",
    "#unstable-123",
    "private-name",
  ])
    assert.equal(guide.content.includes(literal), false);
  assert.equal("steps" in guide, false);
});

test("invalid imported metadata fails before reaching the editor", () => {
  assert.throws(
    () => parseGuideFile('{"steps":[]}', "script.json"),
    /脚本回放/,
  );
  assert.throws(
    () => parseGuideFile("---\nname: 12\n---\n正文", "guide.md"),
    /name/,
  );
  assert.throws(
    () =>
      parseGuideFile('{"content":"正文","parameters":"oops"}', "guide.json"),
    /输入必须是列表/,
  );
});
