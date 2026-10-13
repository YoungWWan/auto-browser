import type { Parameter } from "./types";
export type Website = { id: string; name: string; entryUrl: string };
export type Domain = {
  id: string;
  name: string;
  description: string;
  websites: Website[];
  updatedAt: string;
};
export type Flow = {
  id: string;
  domainId: string;
  name: string;
  description: string;
  tags: string[];
  archiveState: "unarchived" | "archived";
  origin: string;
  revision: number;
  recordingIds: string[];
  updatedAt: string;
};
export type Recording = {
  id: string;
  flowId: string;
  domainId: string;
  sessionId: string;
  captureState: string;
  eventCount: number;
  startedAt: string;
  limitations: string[];
  summary?: {
    actionCount: number;
    steps: { order: number; kind: string; label: string }[];
    omittedActions: number;
  };
};
export type FlowScript = {
  id: string;
  name: string;
  description: string;
  content: string;
  inputs: Parameter[];
  usageMarkdown: string;
};
export type ArchivedRevision = {
  id: string;
  version: number;
  submittedBy: string;
  sourceRecordingIds: string[];
  sourceNotes: string;
  scripts: FlowScript[];
  knowledge: {
    purpose: string;
    inputs: Parameter[];
    procedureMarkdown: string;
    judgementMarkdown: string;
    prerequisitesMarkdown: string;
    exceptionsMarkdown: string;
    outputs: string[];
  };
};
export type FlowDetail = {
  flow: Flow;
  archivedRevision: ArchivedRevision | null;
  revisions: { version: number; submittedBy: string; scriptCount: number }[];
  recordings: Recording[];
};
