import type { Feedback, Snapshot } from './api';
import type { Command } from './commands';

export type Page =
  | 'Overview'
  | 'Network'
  | 'Agents'
  | 'Deliverables'
  | 'Tasks'
  | 'Workflows'
  | 'Canvas'
  | 'Approvals'
  | 'Communications'
  | 'Runtime'
  | 'Events';

export const PAGES: readonly Page[] = [
  'Overview',
  'Network',
  'Agents',
  'Deliverables',
  'Tasks',
  'Workflows',
  'Canvas',
  'Approvals',
  'Communications',
  'Runtime',
  'Events',
];

/**
 * The outcome of one operator command.
 *
 * `ok` is what a page branches on; `failure` is the sentence the Control Plane (or the transport
 * layer) actually answered with. Keeping both means a page can render the refusal next to the
 * button the operator pressed instead of relying on the console-wide banner alone.
 */
export interface CommandRun {
  readonly ok: boolean;
  readonly failure: string | null;
}

/**
 * What every page gets from the shell: the shared read model, the poll tick, the command
 * runner and the console's hold on the runtime (used while a gate waits for the operator).
 */
export interface ConsoleControl {
  readonly snapshot: Snapshot;
  readonly refreshToken: number;
  readonly companyId: string;
  readonly simTime: number;
  /** True while the console holds the runtime paused for gate review. */
  readonly held: boolean;
  readonly run: (command: Command, success: string | null, detail?: string | null) => Promise<boolean>;
  /** The same run, keeping the refusal sentence so the caller can report it where the human looks. */
  readonly runDetailed: (command: Command, success: string | null, detail?: string | null) => Promise<CommandRun>;
  readonly navigate: (page: Page) => void;
  /** Open the delivery page for one task (`/results/:taskId`) — the CEO's read of the outcome. */
  readonly openResults: (taskId: string) => void;
  /** Pause the runtime so approval gates wait for the operator; `ok` when the console holds it. */
  readonly beginHold: () => Promise<CommandRun>;
  /** Give the runtime back; `silent` lets the caller report the decision itself. */
  readonly releaseHold: (silent?: boolean) => Promise<boolean>;
  readonly setFeedback: (feedback: Feedback | null) => void;
}
