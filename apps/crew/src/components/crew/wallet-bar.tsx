/**
 * The one wallet everything spends from, at the foot of the rail.
 *
 * Low in the layout on purpose: it is the source of all the money on this
 * screen and the thing a user checks once, not the thing they work with.
 *
 * Adding funds used to live here behind a plus icon. It moved to the bar at the
 * top, where a person actually looks for a wallet — this reports a balance, and
 * a control tucked beside a number reads as being about that number rather than
 * about the account.
 */
import { useState } from 'react';
import { Check, Copy, Wallet } from 'lucide-react';
import type { State } from '@/api';

export const WalletBar = ({ state, note }: { state: State; note?: string }) => {
  const [copied, setCopied] = useState(false);
  const name = state.identity?.name ?? null;

  return (
    <div className="flex flex-col gap-2">
      {note ? <p className="truncate text-[11px] text-muted-foreground">{note}</p> : null}

      <div className="flex items-center gap-2 text-xs">
        <Wallet className="size-3.5 shrink-0 text-muted-foreground" />
        {/*
          The crew's name when it has one — alex.crewai.eth reads as whose money
          this is, and a 42-character address does not. The address stays in the
          tooltip for anyone who needs to send to it.
        */}
        <span className={name ? 'truncate font-mono' : 'truncate text-muted-foreground'} title={state.account}>
          {name ?? state.account}
        </span>
        {/*
          Copying the name is how someone joins an organization: they give it to
          their employer, who invites it.
        */}
        {name ? (
          <button
            onClick={() =>
              void navigator.clipboard?.writeText(name).then(
                () => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                },
                () => undefined,
              )
            }
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            aria-label={copied ? 'Copied' : `Copy ${name}`}
            title={copied ? 'Copied' : 'Copy name'}
          >
            {copied ? <Check className="size-3.5 text-success" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
          </button>
        ) : null}
        {/*
          The total, not the spendable part. Gateway balance and wallet balance
          are one person's money; which contract holds it is the runtime's
          business, and auto-deposit keeps the difference to a few cents of gas.
        */}
        <span
          className="ml-auto shrink-0 font-mono font-medium tabular-nums"
          title={`${state.spendable} spendable${state.held ? `, ${state.held} in the wallet` : ''}`}
        >
          {state.total}
        </span>
      </div>
    </div>
  );
};
