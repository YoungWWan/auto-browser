import type { AppStatus } from "./types";

type ConnectionStatus = Pick<
  AppStatus,
  "agentBinary" | "skillPath" | "dataPath" | "connectionPath"
>;

export function agentConnection(status?: ConnectionStatus) {
  if (!status) return;
  const separator = status.dataPath?.includes("\\") ? "\\" : "/";
  const connectionPath =
    status.connectionPath ||
    (status.dataPath &&
      `${status.dataPath.replace(/[\\/]+$/, "")}${separator}agent.json`);
  const absolute = (path?: string) =>
    !!path && /^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(path);
  if (
    !absolute(status.agentBinary) ||
    !absolute(status.skillPath) ||
    !absolute(connectionPath)
  )
    return;

  const config = {
    mcpServers: {
      "auto-browser": {
        command: status.agentBinary,
        args: ["mcp"],
        env: { AUTO_BROWSER_CONNECTION: connectionPath },
      },
    },
  };
  const instruction = `请帮我接入当前运行的 Auto Browser 桌面应用：先读取本机 Skill ${JSON.stringify(status.skillPath)}，按你所用客户端的规范安装该 Skill 所在的整个 auto-browser 目录，并将 MCP 服务配置 ${JSON.stringify(config)} 合并到现有配置（保留其他服务与 Skill，已有 auto-browser 配置则核对并更新）；使用配置中的 AUTO_BROWSER_CONNECTION，依次只读调用 app_status、domain_list、browser_list、flow_list 验证并报告接入结果，若当前会话无法加载新 MCP，则先使用同一 command 的 CLI 并设置同一环境变量，执行 status 和 call <工具名> '{}' 验证，再明确告知是否需要重启客户端。`;
  return { config, instruction, skillPath: status.skillPath };
}
