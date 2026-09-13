/**
 * Unlocking a crew: sign once with your wallet, get the same crew anywhere.
 *
 * Shown instead of everything else while the runtime has no key. The key is
 * derived from the signature (server/signer.ts), so there is nothing to back up
 * and nothing lost with a laptop — the same wallet signing the same message
 * makes the same crew on any computer.
 *
 * The wallet is asked twice, and the page says why before it happens. Two
 * prompts for one action looks like a bug unless the reason is on screen: the
 * second signature is how a wallet that would derive a different crew each time
 * gets caught now, rather than on the next computer.
 */
import { useState } from 'react';
import { LoaderCircle, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { shortAddress, useWallet } from '@/lib/use-wallet';
import { unlockSigner, type LockedState } from '@/api';
import { CrewMark } from './crew-mark';

type Phase = 'idle' | 'first' | 'second' | 'unlocking';

const LABEL: Record<Phase, string> = {
  idle: 'Sign to unlock',
  first: 'Waiting for signature 1 of 2',
  second: 'Waiting for signature 2 of 2',
  unlocking: 'Unlocking',
};

export const Unlock = ({ state }: { state: LockedState }) => {
  const { ready, wallet, account, connecting, connect, error: walletError } = useWallet();
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);

  const sign = async () => {
    if (!wallet || !account) return;
    setError(null);

    /*
      Built from the runtime's template, with only the account filled in here.
      `EIP712Domain` is spelled out because the raw JSON-RPC method needs it and
      the runtime's viem call derives it instead.
    */
    const typedData = JSON.stringify({
      domain: state.unlock.domain,
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
        ],
        ...state.unlock.types,
      },
      primaryType: state.unlock.primaryType,
      message: { account, purpose: state.unlock.purpose, warning: state.unlock.warning },
    });
    const request = () =>
      wallet.provider.request({ method: 'eth_signTypedData_v4', params: [account, typedData] }) as Promise<string>;

    try {
      setPhase('first');
      const first = await request();
      setPhase('second');
      const second = await request();
      setPhase('unlocking');
      await unlockSigner(account, [first, second]);
      /* The event stream replaces this screen once the runtime has started. */
    } catch (problem) {
      setError((problem as Error).message.split('\n')[0] || 'the wallet refused');
      setPhase('idle');
    }
  };

  const shownError = error ?? walletError;

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4">
        <CrewMark />
        <span className="text-sm font-medium tracking-tight">Crew AI</span>
      </header>

      <main className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
        <div className="flex w-full max-w-md flex-col gap-6">
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-medium tracking-tight text-balance">Unlock your crew</h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Your crew pays from a key made from your wallet&rsquo;s signature. Sign with the same wallet on any
              computer and you get the same crew back — there is nothing to back up.
            </p>
          </div>

          {account ? (
            <div className="flex items-center justify-between rounded-lg bg-muted px-4 py-3 text-sm">
              <span className="text-muted-foreground">Signing with</span>
              <span className="font-mono" title={account}>
                {shortAddress(account)}
              </span>
            </div>
          ) : null}

          <div className="flex gap-3 rounded-lg border px-4 py-3">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <p className="text-sm leading-relaxed text-muted-foreground">
              Only sign this here. Anyone holding the signature can spend what the crew holds, so keep working money
              in it, not savings.
            </p>
          </div>

          {shownError ? (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
              {shownError}
            </p>
          ) : null}

          <div className="flex flex-col gap-2">
            {!state.privyAppId ? (
              <p className="text-sm text-muted-foreground">
                Wallet login is not configured. Set <span className="font-mono">PRIVY_APP_ID</span> and restart the
                runtime.
              </p>
            ) : account && wallet ? (
              <Button className="w-full" disabled={phase !== 'idle'} onClick={() => void sign()}>
                {phase === 'idle' ? null : <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />}
                {LABEL[phase]}
              </Button>
            ) : (
              <Button className="w-full" disabled={!ready || connecting} onClick={connect}>
                {connecting ? 'Connecting…' : 'Connect wallet'}
              </Button>
            )}
            <p className="text-xs leading-relaxed text-muted-foreground">
              {account
                ? 'Your wallet asks twice. The second signature proves it signs the same way every time — a wallet that does not would make a different crew on every computer.'
                : 'Email, a browser wallet, or WalletConnect. Smart and passkey wallets cannot unlock a crew.'}
            </p>
          </div>
        </div>
      </main>
    </div>
  );
};
