/**
 * What the page knows, and how it finds out.
 *
 * The browser holds no key and no capability — it asks the local runtime to
 * act and watches a stream to see what happened. That is the whole client:
 * five calls and one EventSource.
 */
import { useEffect, useRef, useState } from 'react';

export type Step = {
  n: number;
  at: number;
  text: string;
  /** Present when the step called tools instead of, or as well as, speaking. */
  tools?: string[];
  costMinor: string;
  ms: number;
};

export type Task = {
  id: string;
  prompt: string;
  startedAt: number;
  endedAt?: number;
  steps: Step[];
  outcome?: string;
  answer?: string;
};

export type Agent = {
  id: string;
  /** The ENS label. `cto`. Fixed. */
  label: string;
  /** The full ENS name, once minted. */
  name?: string;
  /** The display name. `Chief Technical Officer`. Absent means use the alias. */
  title?: string;
  brief: string;
  model: string;
  budgetMinor: string;
  spentMinor: string;
  budget: string;
  spent: string;
  /** What it may do, beyond spend. Always sent, defaults resolved by the runtime. */
  permissions: string[];
  /** Directories it may reach. Empty unless it also holds files:host. */
  grants: Grant[];
  /** Its picture and banner. Also written to ENS, where others can see them. */
  avatar?: string;
  header?: string;
  account?: string;
  network: string;
  createdAt: number;
  status: 'idle' | 'running' | 'done' | 'stopped' | 'broke' | 'revoked';
  running: boolean;
  /** Hired on another chain; visible, and unable to work here. */
  offNetwork: boolean;
  tasks: Task[];
};

/**
 * How to put money into this crew from a wallet the user controls.
 *
 * Served by the runtime rather than known by the page: every field is a
 * contract address, and a page carrying its own copy is a page that can be
 * wrong about where money goes. Null when the chain has no such route.
 */
export type FundingRoute = {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  token: string;
  tokenSymbol: string;
  tokenDecimals: number;
  gatewayWallet: string;
  depositor: string;
};

/** A directory on this machine that agents can be given. */
export type Project = {
  id: string;
  name: string;
  path: string;
  mode: 'read' | 'write';
  createdAt: number;
};

export type Grant = { projectId: string; mode: 'read' | 'write' };

/** An agent asking for more budget, waiting for a person. */
export type BudgetRequest = {
  id: string;
  agentId: string;
  askedMinor: string;
  asked: string;
  reason: string;
  at: number;
};

/** One permission the runtime enforces, as it describes itself. */
export type PermissionInfo = { name: string; label: string; detail: string; default: boolean };

/** What the wallet signs to unlock the crew. Sent by the runtime, which verifies the same text. */
export type UnlockTemplate = {
  domain: { name: string; version: string };
  types: { CrewSigner: { name: string; type: string }[] };
  primaryType: 'CrewSigner';
  purpose: string;
  warning: string;
};

/**
 * A runtime with no key yet, waiting for a signature to derive one from.
 *
 * Deliberately thin: nothing about agents, money or names exists until there is
 * a key, and a page that received empty versions of those would render a crew
 * that is not there.
 */
export type LockedState = {
  locked: true;
  network: string;
  privyAppId: string | null;
  crewBackend: string | null;
  funding: FundingRoute | null;
  unlock: UnlockTemplate;
};

export type State = {
  locked: false;
  /** The wallet this crew's key was derived from, or null for a generated key. */
  signer: { derivedFrom: string | null };
  gate: string;
  network: string;
  account: string;
  spendable: string;
  /** Total USDC: spendable (Gateway and tab) plus what is still in the wallet. */
  total: string;
  spendableMinor: string;
  held?: string;
  /** False until the wallet can actually pay for something. */
  funded: boolean;
  /** Why not, when it cannot. `empty` needs money; `undeposited` needs one transaction. */
  shortfall?: 'empty' | 'undeposited';
  /**
   * The wallet balance from which USDC is deposited into Gateway automatically,
   * formatted. Null when auto-deposit is off or does not apply, and the manual
   * deposit is offered instead.
   */
  autoDepositFrom: string | null;
  /** A deposit into Gateway is being sent right now. */
  depositing: boolean;
  /**
   * Sepolia ETH that pays for agent names, held by the crew signer. Null when
   * naming is off. `low` means likely not enough for one more name.
   */
  nameGas: { address: string; balance: string; lowBelow: string; ask: string; low: boolean } | null;
  naming: boolean;
  funding: FundingRoute | null;
  /** Public client id for Privy. Null turns wallet connection off entirely. */
  privyAppId: string | null;
  /** The crew backend, where organizations are created and kept. Null turns organizations off. */
  crewBackend: string | null;
  /** The name agents are minted under — the person's own. Null until they choose one. */
  root: string | null;
  identity: { name: string; registry: string; resolver: string } | null;
  models: string[];
  permissions: PermissionInfo[];
  file: string;
  requests: BudgetRequest[];
  projects: Project[];
  agents: Agent[];
};

const post = async (path: string, body?: unknown): Promise<unknown> => {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `the runtime refused (${response.status})`);
  return payload;
};

export const hire = (agent: {
  label: string;
  title?: string;
  permissions?: string[];
  grants?: Grant[];
  brief: string;
  budgetMinor: string;
  model: string;
  avatar?: string;
  header?: string;
}) => post('/api/agents', agent);

export const assign = (id: string, prompt: string) => post(`/api/agents/${id}/task`, { prompt });

/**
 * Changes an agent that already exists.
 *
 * Only the fields passed are touched — each one that reaches the chain is a
 * transaction, so sending the whole agent back would charge for rewriting
 * records that did not change.
 */
export const edit = (
  id: string,
  changes: {
    title?: string;
    permissions?: string[];
    grants?: Grant[];
    brief?: string;
    model?: string;
    budgetMinor?: string;
    avatar?: string;
    header?: string;
  },
) => post(`/api/agents/${id}/edit`, changes);
/**
 * Answers a request for more budget.
 *
 * The amount is sent rather than implied, because approving is not agreeing —
 * a person may grant a tenth of what was asked, and the number they typed is
 * the limit rather than the one the agent proposed.
 */
/**
 * Grants a directory to the crew.
 *
 * The path is typed rather than picked, because a browser file picker hands
 * back a file, not the directory path the runtime needs — and a path the user
 * wrote is one they can see before they commit to it.
 */
export const addProject = (project: { name: string; path: string; mode: 'read' | 'write' }) =>
  post('/api/projects', project);

export const removeProject = async (id: string): Promise<void> => {
  const response = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('the runtime refused to remove it');
};

/**
 * Asks the runtime to look at the chain now.
 *
 * The wallet is polled slowly, which is right for a balance that rarely
 * changes and wrong for the minute after somebody confirms a deposit and sits
 * watching this page. This is that minute.
 */
export const refreshFunding = () => post('/api/funding/refresh');

/** Hands the runtime two signatures of the unlock message; it derives and keeps the key. */
export const unlockSigner = (account: string, signatures: string[]) =>
  post('/api/signer/unlock', { account, signatures });

/** Tells the runtime to name agents under this name. It checks the chain before agreeing. */
export const claimIdentity = (name: string) => post('/api/identity', { name });

export const approve = (id: string, grantedMinor: string) =>
  post(`/api/requests/${id}/approve`, { grantedMinor });
export const decline = (id: string) => post(`/api/requests/${id}/decline`);

export const halt = (id: string) => post(`/api/agents/${id}/stop`);
export const fire = (id: string) => post(`/api/agents/${id}/fire`);
/**
 * Deletes an agent. One not yet revoked is revoked on chain first, so it cannot
 * spend again; the runtime refuses while the agent is working.
 */
export const removeAgent = (id: string) => post(`/api/agents/${id}/remove`);

/**
 * The live roster.
 *
 * Every change is a whole new state rather than a patch. The roster is a few
 * dozen agents; sending all of it removes an entire class of bug where the page
 * and the runtime disagree about what happened, and no user could ever perceive
 * the difference.
 */
export const useCrew = (): { state: State | LockedState | null; connected: boolean; log: string[] } => {
  const [state, setState] = useState<State | LockedState | null>(null);
  const [connected, setConnected] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const source = useRef<EventSource | null>(null);

  useEffect(() => {
    const events = new EventSource('/api/events');
    source.current = events;

    events.onopen = () => setConnected(true);
    events.onerror = () => setConnected(false);
    events.onmessage = (message) => {
      const event = JSON.parse(message.data) as
        | { type: 'state'; state: State | LockedState }
        | { type: 'log'; text: string }
        | { type: 'delta'; agentId: string; n: number; text: string }
        | { type: 'step' | 'status' };

      if (event.type === 'state') {
        setState(event.state);
        setConnected(true);
      } else if (event.type === 'delta') {
        /*
          Patched in place rather than answered with a fresh state.

          A delta arrives for every chunk the model produces, and rebuilding the
          whole roster that often would send the entire crew — every agent,
          every task, every step — down the wire several times a second to
          change one string. The step being written already exists here; it is
          found by agent and step number, because those are stable and array
          positions are not.
        */
        setState((previous) => {
          if (!previous || previous.locked) return previous;
          return {
            ...previous,
            agents: previous.agents.map((agent) => {
              if (agent.id !== event.agentId) return agent;
              const tasks = [...agent.tasks];
              const last = tasks.length - 1;
              const task = tasks[last];
              if (!task) return agent;
              tasks[last] = {
                ...task,
                steps: task.steps.map((step) => (step.n === event.n ? { ...step, text: event.text } : step)),
              };
              return { ...agent, tasks };
            }),
          };
        });
      } else if (event.type === 'log') {
        /*
          Kept short on purpose. This is the line under the roster that says
          what the chain is doing right now — minting, clearing — and it is
          the only place a slow transaction is visible at all.
        */
        setLog((previous) => [...previous.slice(-4), event.text]);
      }
    };

    return () => events.close();
  }, []);

  return { state, connected, log };
};
