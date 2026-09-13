/**
 * The bar across the top: what this is, whose crew it is, and who you are.
 *
 * Left to right it answers three questions in the order a person asks them.
 * The brand says which application. The switcher says whose crew — your own or
 * an organization's — which decides every name, budget and member below it.
 * The wallet, at the far end, says who is paying.
 */
import { ChevronDown, Moon, Sun, Wallet as WalletIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { setTheme, useTheme } from '@/lib/theme';
import { shortAddress, useWallet } from '@/lib/use-wallet';
import { cn } from '@/lib/utils';
import type { Org } from '@/lib/orgs';
import type { State } from '@/api';
import { WorkspaceSwitcher, type Workspace } from './workspace-switcher';
import { CrewMark } from './crew-mark';

/** The wordmark. Drawn rather than an image, so it follows light and dark with everything else. */
const Brand = () => (
  <div className="flex items-center gap-2">
    <CrewMark />
    <span className="text-sm font-medium tracking-tight">Crew AI</span>
  </div>
);

export const TopBar = ({
  state,
  onWallet,
  workspace,
  orgs,
  onWorkspace,
  onCreateOrg,
}: {
  state: State;
  onWallet: () => void;
  workspace: Workspace;
  orgs: Org[];
  onWorkspace: (workspace: Workspace) => void;
  onCreateOrg: () => void;
}) => {
  const { account, ensName, connecting, connect, ready } = useWallet();
  const theme = useTheme();

  /*
    Connecting goes straight to Privy's modal rather than through a dialog of
    ours first. Privy renders into its own portal, and opening it from inside a
    Radix dialog leaves two focus traps fighting over the same email field.
    Our dialog is for depositing, which only means anything once a wallet is
    attached, so it is what the connected pill opens instead.
  */
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-background px-4">
      <Brand />

      {/*
        Organizations need the crew backend. Without one configured the switcher
        would offer a create button that can only fail, so it is not offered.
      */}
      {state.crewBackend ? (
        <WorkspaceSwitcher
          workspace={workspace}
          orgs={orgs}
          account={state.account}
          onSelect={onWorkspace}
          onCreate={onCreateOrg}
        />
      ) : null}

      <div className="ml-auto flex items-center gap-2">
        {/*
          Labelled with what it does, not what is showing: the icon is the
          mode a click switches to, the way most apps draw this control.
        */}
        <button
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          className={cn(
            'grid size-8 place-items-center rounded-full border text-muted-foreground transition-colors',
            'hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
          )}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
        </button>

        {account ? (
          <button
            onClick={onWallet}
            className={cn(
              'flex h-8 items-center gap-2 rounded-full border py-1 pr-2 pl-3 transition-colors',
              'hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
            )}
            title={account}
          >
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />
            <span className={cn('text-sm', ensName ? '' : 'font-mono text-xs')}>
              {ensName ?? shortAddress(account)}
            </span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        ) : (
          <Button size="sm" disabled={!ready || connecting} onClick={connect}>
            <WalletIcon className="size-3.5" aria-hidden />
            {connecting ? 'Connecting…' : 'Connect wallet'}
          </Button>
        )}
      </div>
    </header>
  );
};
