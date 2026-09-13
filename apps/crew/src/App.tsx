/**
 * The room: a rail of agents, a thread with one of them, and its money.
 *
 * Layout and selection only — every pane is its own component, so this file
 * stays the one place that answers "what is on screen and which agent is it
 * about". The familiar three-pane shape is deliberate: what is being shown is
 * unfamiliar enough already, and two departures carry it. Every reply states
 * what it cost, and the right-hand panel is a budget rather than a settings
 * page. An agent here is a name on a chain with money attached, and both can be
 * taken away while it is mid-sentence.
 */
import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AgentDetail } from '@/components/crew/agent-detail';
import { AgentRail } from '@/components/crew/agent-rail';
import { AgentThread } from '@/components/crew/agent-thread';
import { FirstRun } from '@/components/crew/first-run';
import { HireDialog } from '@/components/crew/hire-dialog';
import { ProjectManager } from '@/components/crew/project-fields';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { TopBar } from '@/components/crew/top-bar';
import { DepositPanel } from '@/components/crew/connect-wallet';
import { CreateOrg } from '@/components/crew/create-org';
import { OrgOverview } from '@/components/crew/org-overview';
import { Unlock } from '@/components/crew/unlock';
import { ChooseName } from '@/components/crew/choose-name';
import { InviteReceived } from '@/components/crew/invite-received';
import { NameGasDialog, NameGasOnboarding, dismissNameGas } from '@/components/crew/name-gas-dialog';
import type { Workspace } from '@/components/crew/workspace-switcher';
import { useWallet, WalletProvider } from '@/lib/use-wallet';
import { useOrgs } from '@/lib/orgs';
import { useCrew, type State } from './api';

const Waiting = ({ connected }: { connected: boolean }) => (
  <div className="grid h-full place-items-center p-10">
    <div className="flex max-w-sm flex-col items-center gap-3 text-center">
      <h2 className="text-base font-semibold">{connected ? 'Starting…' : 'Waiting for the runtime'}</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">
        Run <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">bun run server</code> in{' '}
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">apps/crew</code>. It holds the wallet; this
        page never sees it.
      </p>
    </div>
  </div>
);

const NoAgents = ({ root, onHire }: { root: string | null; onHire: () => void }) => (
  <div className="grid place-items-center p-10">
    <div className="flex max-w-md flex-col items-center gap-4 text-center">
      <h2 className="text-base font-semibold">No agents yet</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">
        {root ? (
          <>
            Every agent gets a name under <span className="font-mono">{root}</span> and a budget drawn from one
            wallet. Neither is a label: the name is checked before each payment, and the budget is enforced by the
            side holding the money.
          </>
        ) : (
          <>
            Every agent gets a budget drawn from one wallet, enforced by the side holding the money. Choose a name to
            give them names on chain as well.
          </>
        )}
      </p>
      <Button onClick={onHire}>
        <Plus /> Hire the first one
      </Button>
    </div>
  </div>
);

/**
 * Everything below the bar.
 *
 * Split out so the wallet provider can sit above it: the bar and the funding
 * dialog are the same connection, and a provider inside the component that
 * renders both would be a provider that remounts with them.
 */
/**
 * The wallet, opened from the bar.
 *
 * One dialog for both states rather than a menu and a separate funding screen:
 * connecting and depositing are the same errand, and someone who opens this
 * having never connected should not have to find a second thing to click.
 */
const WalletDialog = ({
  state,
  open,
  onClose,
}: {
  state: State;
  open: boolean;
  onClose: () => void;
}) => {
  const { account } = useWallet();

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Your wallet</DialogTitle>
          <DialogDescription>
            {state.funding ? (
              <>
                Agents pay per call from the crew&rsquo;s balance. Depositing puts money straight into what
                they spend from — it never sits in a hot wallet as loose {state.funding.tokenSymbol}.
              </>
            ) : (
              <>
                There is no wallet funding route on <span className="font-mono">{state.network}</span>. Send
                funds to the crew&rsquo;s address directly.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {state.funding && account ? (
          <DepositPanel route={state.funding} />
        ) : (
          <p className="font-mono text-xs break-all">{state.account}</p>
        )}
      </DialogContent>
    </Dialog>
  );
};

const WORKSPACE_KEY = 'crew.workspace';
const DETAILS_KEY = 'crew.details';

/*
  Remembered per browser, and read defensively: storage can be unavailable
  (private windows, blocked site data), and the right answer then is simply the
  personal crew rather than a page that fails to start.
*/
const storedWorkspace = (): Workspace => {
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Workspace) : null;
    return parsed?.kind === 'org' && typeof parsed.id === 'string' ? parsed : { kind: 'personal' };
  } catch {
    return { kind: 'personal' };
  }
};

const Room = ({ state, log }: { state: State; log: string[] }) => {
  const [selected, setSelected] = useState<string | null>(null);
  const [hiring, setHiring] = useState(false);
  const [folders, setFolders] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const [workspace, setWorkspace] = useState<Workspace>(storedWorkspace);
  const [creatingOrg, setCreatingOrg] = useState(false);
  /*
    The details panel, shown or hidden and remembered per browser — the thread
    gets the room when someone just wants to talk to an agent.
  */
  const [detailsOpen, setDetailsOpen] = useState(() => {
    try {
      return localStorage.getItem(DETAILS_KEY) !== 'hidden';
    } catch {
      return true;
    }
  });
  const toggleDetails = () =>
    setDetailsOpen((open) => {
      try {
        localStorage.setItem(DETAILS_KEY, open ? 'hidden' : 'shown');
      } catch {
        /* applies for this visit */
      }
      return !open;
    });
  const wallet = useWallet();
  const { orgs, refresh: refreshOrgs } = useOrgs(state.crewBackend, wallet);

  const chooseWorkspace = (next: Workspace) => {
    setCreatingOrg(false);
    setWorkspace(next);
    try {
      localStorage.setItem(WORKSPACE_KEY, JSON.stringify(next));
    } catch {
      /* the choice still applies for this visit */
    }
  };

  const agent = state?.agents.find((candidate) => candidate.id === selected) ?? null;

  /*
    Selection follows the roster rather than being held against it. An agent can
    disappear from under the cursor — revoked from elsewhere, or a runtime that
    restarted — and a pane rendering an id that no longer exists is a blank
    screen with no way back.
  */
  useEffect(() => {
    if (!agent && state.agents.length > 0) setSelected(state.agents[0]!.id);
  }, [state, agent]);

  const backend = state.crewBackend;

  return (
    <div className="flex h-full flex-col">
      <TopBar
        state={state}
        onWallet={() => setWalletOpen(true)}
        workspace={workspace}
        orgs={orgs}
        onWorkspace={chooseWorkspace}
        onCreateOrg={() => setCreatingOrg(true)}
      />

      {/*
        Creating an organization, and an organization's own home, take the whole
        width below the bar. Neither is about an agent, so the agent rail and
        detail panel would be three columns of the wrong thing.
      */}
      {backend && creatingOrg ? (
        <CreateOrg
          backend={backend}
          onCancel={() => setCreatingOrg(false)}
          onCreated={(orgId) => {
            chooseWorkspace({ kind: 'org', id: orgId });
            void refreshOrgs();
          }}
        />
      ) : backend && workspace.kind === 'org' ? (
        <OrgOverview backend={backend} orgId={workspace.id} onPersonal={() => chooseWorkspace({ kind: 'personal' })} />
      ) : (
      <div
        className={
          detailsOpen && agent
            ? 'grid min-h-0 flex-1 grid-cols-[17rem_minmax(0,1fr)_20rem]'
            : 'grid min-h-0 flex-1 grid-cols-[17rem_minmax(0,1fr)]'
        }
      >
      <AgentRail
        state={state}
        selected={selected}
        onSelect={setSelected}
        onHire={() => setHiring(true)}
        onFolders={() => setFolders(true)}
        {...(log.at(-1) ? { note: log.at(-1)! } : {})}
      />

      {/*
        Funding comes before everything, because nothing else can happen without
        it — an agent cannot be hired against a wallet with no money, and
        offering the button would be offering a failure.
      */}
      {!state.funded ? (
        <FirstRun state={state} />
      ) : agent ? (
        <AgentThread agent={agent} state={state} detailsOpen={detailsOpen} onToggleDetails={toggleDetails} />
      ) : (
        <NoAgents root={state.root} onHire={() => setHiring(true)} />
      )}

      {agent && detailsOpen ? <AgentDetail agent={agent} state={state} /> : null}
      </div>
      )}

      <HireDialog state={state} open={hiring} onClose={() => setHiring(false)} />

      <WalletDialog state={state} open={walletOpen} onClose={() => setWalletOpen(false)} />

      <NameGasDialog state={state} />

      {/*
        Invites to organizations, addressed to this person's Crew name. Shown
        wherever they are in the app; accepting adds the organization to the
        switcher, and opening it goes straight there.
      */}
      {backend ? (
        <InviteReceived
          backend={backend}
          onJoined={(orgId, open) => {
            void refreshOrgs();
            if (open) chooseWorkspace({ kind: 'org', id: orgId });
          }}
        />
      ) : null}

      <Dialog open={folders} onOpenChange={(next) => !next && setFolders(false)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Folders</DialogTitle>
            <DialogDescription>
              Directories on this machine that agents can be given. Paths stay here — an agent's capability
              carries an opaque id, and the chain records only that it may reach files at all.
            </DialogDescription>
          </DialogHeader>
          <ProjectManager projects={state.projects} />
        </DialogContent>
      </Dialog>
    </div>
  );
};

export const App = () => {
  const { state, connected, log } = useCrew();
  if (!state) return <Waiting connected={connected} />;

  /*
    No key yet. Everything else — agents, balances, names — hangs off the key,
    so until a signature makes one there is only the screen that asks for it.
  */
  if (state.locked) {
    return (
      <WalletProvider route={state.funding} appId={state.privyAppId}>
        <Unlock state={state} />
      </WalletProvider>
    );
  }

  /*
    The provider wraps the room rather than living inside it, so the bar and the
    funding dialog share one connection — and so it survives every re-render the
    event stream causes, which is most of them.
  */
  return (
    <WalletProvider route={state.funding} appId={state.privyAppId}>
      <Onboarding state={state} log={log} />
    </WalletProvider>
  );
};

const NAME_SKIPPED_KEY = 'crew.name.skipped';
const NAME_GAS_SKIPPED_KEY = 'crew.nameGas.skipped';

/**
 * Choosing a name comes before the room, once per crew signer.
 *
 * A skip is remembered against the signer's address rather than as a flag, so
 * a different crew on the same browser is still asked. Read defensively, like
 * every other stored preference here.
 */
const Onboarding = ({ state, log }: { state: State; log: string[] }) => {
  const [skipped, setSkipped] = useState(() => {
    try {
      return localStorage.getItem(NAME_SKIPPED_KEY) === state.account;
    } catch {
      return false;
    }
  });

  const [gasSkipped, setGasSkipped] = useState(() => {
    try {
      return localStorage.getItem(NAME_GAS_SKIPPED_KEY) === state.account;
    } catch {
      return false;
    }
  });

  if (!state.identity && state.crewBackend && !skipped) {
    return (
      <ChooseName
        state={state}
        onSkip={() => {
          try {
            localStorage.setItem(NAME_SKIPPED_KEY, state.account);
          } catch {
            /* skipped for this visit */
          }
          setSkipped(true);
        }}
      />
    );
  }

  /*
    Sepolia ETH for agent names, asked for as an onboarding step while the crew
    has no agents yet. After that the pop-up in the room takes over. Skipping
    here also quiets the pop-up for this balance, so it does not ask again the
    moment the room opens.
  */
  if (state.nameGas?.low && state.agents.length === 0 && !gasSkipped) {
    return (
      <NameGasOnboarding
        state={state}
        onSkip={() => {
          try {
            localStorage.setItem(NAME_GAS_SKIPPED_KEY, state.account);
          } catch {
            /* skipped for this visit */
          }
          dismissNameGas(state.nameGas!.balance);
          setGasSkipped(true);
        }}
      />
    );
  }
  return <Room state={state} log={log} />;
};
