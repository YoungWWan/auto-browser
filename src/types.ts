export type Target = { selector?: string; label?: string; text?: string };
export type Step = {
  kind: string;
  target?: Target;
  value?: unknown;
  description: string;
};
export type Parameter = {
  name: string;
  label: string;
  kind: "string" | "number" | "boolean";
  required: boolean;
  default?: unknown;
};
export type Workflow = {
  id: string;
  name: string;
  description: string;
  version: number;
  startUrl: string;
  domain: string;
  tags: string[];
  parameters: Parameter[];
  steps: Step[];
  completion: Step;
  status: string;
  updatedAt: string;
};
export type Guide = {
  id: string;
  name: string;
  description: string;
  version: number;
  startUrl: string;
  domain: string;
  tags: string[];
  parameters: Parameter[];
  content: string;
  updatedAt: string;
};
export type GuideSummary = Omit<Guide, "content">;
export type Session = {
  domainId?: string;
  id: string;
  title: string;
  url: string;
  status: string;
  createdAt: string;
};
export type Run = {
  id: string;
  sessionId: string;
  name: string;
  status: string;
  currentStep: number;
  totalSteps: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  events: {
    at: string;
    step: number;
    description: string;
    result: { ok: boolean; error?: string; verified?: boolean };
  }[];
  definition?: Workflow;
};
export type Snapshot = {
  url: string;
  title: string;
  text: string;
  elements: {
    tag: string;
    type?: string;
    role?: string;
    label: string;
    text: string;
    selector: string;
    value?: string;
  }[];
};
export type AppStatus = {
  version: string;
  platform: string;
  endpoint: string;
  dataPath: string;
  connectionPath?: string;
  agentBinary: string;
  skillPath: string;
  capabilities: Record<string, unknown>;
  sessionCount: number;
  activeSessionId?: string;
};
