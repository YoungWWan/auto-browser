import { test } from "node:test";
import assert from "node:assert/strict";
import { agentConnection } from "../src/agentConnection.ts";

test("setup instruction targets the current instance and preserves existing agent configuration", () => {
  const status = {
    agentBinary:
      "/Applications/Auto Browser Preview.app/Contents/MacOS/auto-browser-agent",
    skillPath:
      "/Applications/Auto Browser Preview.app/Contents/Resources/skills/auto-browser/SKILL.md",
    dataPath: "/Users/test/Library/Application Support/dev.autobrowser.preview",
    connectionPath:
      "/Users/test/Library/Application Support/dev.autobrowser.preview/agent.json",
    token: "must-not-be-copied",
  };
  const setup = agentConnection(status);
  const embeddedConfig = JSON.parse(
    setup.instruction.match(/MCP 服务配置 (.*?) 合并到现有配置/)[1],
  );
  assert.deepEqual(embeddedConfig, setup.config);
  const server = embeddedConfig.mcpServers["auto-browser"];
  assert.equal(server.command, status.agentBinary);
  assert.deepEqual(server.args, ["mcp"]);
  assert.equal(server.env.AUTO_BROWSER_CONNECTION, status.connectionPath);
  assert.equal(setup.instruction.includes("\n"), false);
  assert.equal(setup.instruction.includes(status.token), false);
  assert.match(setup.instruction, /保留其他服务与 Skill/);
  assert.match(
    setup.instruction,
    /只读调用 app_status、domain_list、browser_list、flow_list/,
  );
  assert.match(setup.instruction, /同一环境变量/);
  assert.match(setup.instruction, /是否需要重启客户端/);
});

test("legacy status and Windows paths retain spaces, Unicode, quotes and backslashes as data", () => {
  for (const [directory, expected] of [
    ["/home/用户/Auto Browser/", "/home/用户/Auto Browser/agent.json"],
    [
      "C:\\Users\\用户\\Auto Browser\\",
      "C:\\Users\\用户\\Auto Browser\\agent.json",
    ],
    [
      "\\\\server\\share\\Auto Browser",
      "\\\\server\\share\\Auto Browser\\agent.json",
    ],
  ]) {
    const status = {
      dataPath: directory,
      agentBinary: `${directory}tools\\agent \"quoted\".exe`,
      skillPath: `${directory}skills\\auto-browser\\SKILL.md`,
    };
    const setup = agentConnection(status);
    const embedded = JSON.parse(
      setup.instruction.match(/MCP 服务配置 (.*?) 合并到现有配置/)[1],
    );
    assert.equal(
      embedded.mcpServers["auto-browser"].command,
      status.agentBinary,
    );
    assert.equal(
      embedded.mcpServers["auto-browser"].env.AUTO_BROWSER_CONNECTION,
      expected,
    );
    assert.equal(
      setup.instruction.includes(JSON.stringify(status.skillPath)),
      true,
    );
  }
});

test("unavailable or relative paths cannot produce a setup instruction", () => {
  assert.equal(agentConnection(), undefined);
  assert.equal(agentConnection({}), undefined);
  const complete = {
    agentBinary: "/app/auto-browser-agent",
    skillPath: "/app/skills/auto-browser/SKILL.md",
    dataPath: "/data/app",
  };
  for (const key of Object.keys(complete)) {
    assert.equal(agentConnection({ ...complete, [key]: "" }), undefined);
    assert.equal(
      agentConnection({ ...complete, [key]: "relative/path" }),
      undefined,
    );
  }
});
