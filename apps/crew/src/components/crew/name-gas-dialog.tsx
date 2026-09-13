/**
 * Asking for Sepolia ETH, which pays for agent names.
 *
 * Agent names live on Sepolia and the crew signer pays their gas itself — the
 * backend deliberately does not, because names a person brings from elsewhere
 * have to work the same way. When the signer runs low, hiring still works but
 * the agent is created without a name, and the only trace used to be a revert
 * in the rail. So the page asks, in two places:
 *
 *   onboarding   a full step after choosing a name, while the crew has no
 *                agents — the moment someone is already setting things up
 *   pop-up       whenever the balance drops below the threshold later
 *
 * Both show the same thing: the address, how much to send, and a faucet.
 */
import { useState } from 'react';
import { Check, Copy, ExternalLink, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { refreshFunding, type State } from '@/api';
import { CrewMark } from './crew-mark';

type NameGas = NonNullable<State['nameGas']>;

const DISMISSED_KEY = 'crew.nameGas.dismissed';

/*
  Google's public Sepolia faucet. A suggestion, not a dependency: any Sepolia
  ETH sent to the address works, from any faucet or wallet.
*/
const FAUCET_URL = 'https://cloud.google.com/application/web3/faucet/ethereum/sepolia';

const readDismissed = (): string | null => {
  try {
    return sessionStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
};

/** Hides the pop-up for this balance, this session. Also used by the onboarding skip. */
export const dismissNameGas = (balance: string): void => {
  try {
    sessionStorage.setItem(DISMISSED_KEY, balance);
  } catch {
    /* dismissed for this visit */
  }
};

/** The address to send to, how much, and where to get it. */
const FundingDetails = ({ gas }: { gas: NameGas }) => {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">Send Sepolia ETH to</span>
        <button
          onClick={() => {
            void navigator.clipboard?.writeText(gas.address).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              },
              () => undefined,
            );
          }}
          className="flex w-full items-center gap-2 rounded-lg border bg-muted px-3 py-2.5 text-left transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <span className="min-w-0 flex-1 font-mono text-xs break-all">{gas.address}</span>
          {copied ? (
            <Check className="size-3.5 shrink-0 text-success" aria-hidden />
          ) : (
            <Copy className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <span className="shrink-0 text-[11px] text-muted-foreground">{copied ? 'Copied' : 'Copy'}</span>
        </button>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Send at least <span className="font-medium text-foreground">{gas.ask}</span> — enough for many agent names.
          This is Sepolia test ETH, not mainnet.
        </p>
      </div>

      <a
        href={FAUCET_URL}
        target="_blank"
        rel="noreferrer"
        className="flex items-center justify-between rounded-lg border px-3 py-2.5 text-sm transition-colors hover:bg-accent"
      >
        <span>Get free Sepolia ETH from a faucet</span>
        <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </a>
    </div>
  );
};

/** "I've sent it": asks the runtime to read the balance now rather than at the next poll. */
const useCheckAgain = () => {
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    try {
      await refreshFunding();
    } finally {
      setChecking(false);
    }
  };
  return { checking, check };
};

/** The pop-up, for a balance that drops low after onboarding. */
export const NameGasDialog = ({ state }: { state: State }) => {
  const gas = state.nameGas;
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const { checking, check } = useCheckAgain();

  if (!gas) return null;
  const open = gas.low && dismissed !== gas.balance && readDismissed() !== gas.balance;

  const dismiss = () => {
    dismissNameGas(gas.balance);
    setDismissed(gas.balance);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && dismiss()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Your crew needs Sepolia ETH</DialogTitle>
          <DialogDescription>
            Agent names live on Sepolia, and your crew pays the gas to create them. It has {gas.balance}, below{' '}
            {gas.lowBelow}. You can still hire, but new agents may not get a name until it&rsquo;s topped up.
          </DialogDescription>
        </DialogHeader>

        <FundingDetails gas={gas} />

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={dismiss}>
            Later
          </Button>
          <Button onClick={() => void check()} disabled={checking}>
            {checking ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
            {checking ? 'Checking' : 'I’ve sent it'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

/**
 * The onboarding step, after choosing a name.
 *
 * Shown by the onboarding gate only while the balance is low; once the ETH
 * lands, the next state update removes it and the crew opens.
 */
export const NameGasOnboarding = ({ state, onSkip }: { state: State; onSkip: () => void }) => {
  const gas = state.nameGas;
  const { checking, check } = useCheckAgain();
  if (!gas) return null;

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4">
        <CrewMark />
        <span className="text-sm font-medium tracking-tight">Crew AI</span>
      </header>

      <main className="flex min-h-0 flex-1 justify-center overflow-y-auto p-6">
        <div className="my-auto flex w-full max-w-md flex-col gap-6 py-6">
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-medium tracking-tight text-balance">Add Sepolia ETH for agent names</h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Every agent you hire gets a name under{' '}
              {state.root ? <span className="font-mono">{state.root}</span> : 'your name'}, created on Sepolia. Your
              crew pays that gas itself, from its own address.
            </p>
          </div>

          <div className="flex items-center justify-between rounded-lg bg-muted px-4 py-3 text-sm">
            <span className="text-muted-foreground">Current balance</span>
            <span className="font-mono">{gas.balance}</span>
          </div>

          <FundingDetails gas={gas} />

          <div className="flex flex-col gap-3">
            <Button className="w-full" onClick={() => void check()} disabled={checking}>
              {checking ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
              {checking ? 'Checking' : 'I’ve sent it — check balance'}
            </Button>
            <button
              onClick={onSkip}
              className="w-fit text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
            >
              Skip for now — agents may be hired without names
            </button>
          </div>
        </div>
      </main>
    </div>
  );
};
