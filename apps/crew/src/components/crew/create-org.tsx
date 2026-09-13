/**
 * Creating an organization: pick a name, see what you'll get, create it.
 *
 * A full screen in the middle column rather than a dialog, because what follows
 * the button is minutes of setup worth watching, and a dialog either traps the
 * person for those minutes or closes on work still happening.
 *
 * The name is checked as it is typed — against the rule, then against the chain
 * — so the button is only offered for a name that can actually be had.
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, LoaderCircle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useWallet } from '@/lib/use-wallet';
import { BackendError, createOrg, isOrgLabel, quoteName, roughUsdc, type NameQuote } from '@/lib/orgs';

type Check =
  | { state: 'empty' }
  | { state: 'invalid' }
  | { state: 'checking' }
  | { state: 'available'; quote: NameQuote }
  | { state: 'taken' }
  | { state: 'error'; message: string };

export const CreateOrg = ({
  backend,
  onCreated,
  onCancel,
}: {
  backend: string;
  onCreated: (orgId: string) => void;
  onCancel: () => void;
}) => {
  const { authenticated, ready, connect, getAccessToken } = useWallet();
  const [label, setLabel] = useState('');
  const [check, setCheck] = useState<Check>({ state: 'empty' });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement | null>(null);

  /*
    Focused a beat after mounting rather than with `autoFocus`. This screen
    opens from the workspace menu, and the menu's focus trap is still active
    when it mounts — so `autoFocus` lands, the trap pulls focus back into the
    menu, and the menu then closes with focus nowhere. Typing straight after
    choosing "Create organization" typed into nothing. Waiting for the menu to
    finish closing puts the cursor where the person expects it.
  */
  useEffect(() => {
    const timer = setTimeout(() => field.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, []);

  /*
    Debounced so a name is asked about once the person pauses, not once per
    keystroke — each check is a read against the chain.
  */
  useEffect(() => {
    if (!label) return setCheck({ state: 'empty' });
    if (!isOrgLabel(label)) return setCheck({ state: 'invalid' });

    setCheck({ state: 'checking' });
    let cancelled = false;
    const timer = setTimeout(() => {
      quoteName(backend, label)
        .then((quote) => {
          if (!cancelled) setCheck(quote.available ? { state: 'available', quote } : { state: 'taken' });
        })
        .catch((problem: Error) => {
          if (!cancelled) setCheck({ state: 'error', message: problem.message });
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [backend, label]);

  const create = async () => {
    if (check.state !== 'available') return;
    if (!authenticated) {
      connect();
      return;
    }
    setError(null);
    setCreating(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Your login expired. Log in again to create an organization.');
      const created = await createOrg(backend, token, label);
      onCreated(created.org.id);
    } catch (problem) {
      setError(
        problem instanceof BackendError && problem.code === 'name_taken'
          ? `${label}.eth was just taken. Try another name.`
          : (problem as Error).message,
      );
      setCreating(false);
    }
  };

  const name = label ? `${label}.eth` : 'yourcompany.eth';
  const price = check.state === 'available' ? roughUsdc(check.quote.priceMinor) : null;

  return (
    <section className="flex min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-8 px-6 py-10">
        <button
          onClick={onCancel}
          className="flex w-fit items-center gap-1.5 rounded-md text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2"
        >
          <ArrowLeft className="size-4" aria-hidden /> Back
        </button>

        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-medium tracking-tight text-balance">Create an organization</h1>
          <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
            Your organization gets its own .eth name, owned by a wallet only its owners control. Everyone you add
            gets a name under it.
          </p>
        </div>

        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label htmlFor="org-label" className="text-sm font-medium">
            Name
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="org-label"
              ref={field}
              autoComplete="off"
              spellCheck={false}
              placeholder="acme"
              value={label}
              maxLength={32}
              onChange={(event) => setLabel(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              aria-describedby="org-label-status"
              aria-invalid={check.state === 'invalid' || check.state === 'taken'}
              className="h-10 font-mono text-base"
            />
            <span className="font-mono text-base text-muted-foreground">.eth</span>
          </div>

          <p id="org-label-status" className="flex min-h-5 items-center gap-1.5 text-sm" aria-live="polite">
            {check.state === 'invalid' ? (
              <span className="text-muted-foreground">
                3 to 32 lower-case letters, digits and single hyphens.
              </span>
            ) : check.state === 'checking' ? (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> Checking{' '}
                {name}
              </span>
            ) : check.state === 'available' ? (
              <span className="flex items-center gap-1.5 text-success">
                <Check className="size-4" aria-hidden /> {name} is available
                {price ? <span className="text-muted-foreground">· about {price} a year, paid by Crew</span> : null}
              </span>
            ) : check.state === 'taken' ? (
              <span className="flex items-center gap-1.5 text-destructive">
                <X className="size-4" aria-hidden /> {name} is taken. Try another name.
              </span>
            ) : check.state === 'error' ? (
              <span className="text-destructive">{check.message}</span>
            ) : null}
          </p>

          <div className="mt-2 flex flex-col gap-1 rounded-lg bg-muted px-4 py-3 font-mono text-sm">
            <span>{name}</span>
            <span className="text-muted-foreground">crew.{name}</span>
            <span className="text-muted-foreground">you.crew.{name}</span>
          </div>

          <p className="text-sm leading-relaxed text-muted-foreground">
            You'll be the only owner at first. You can add owners and require more than one of you to approve
            changes at any time.
          </p>

          {error ? (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          <div className="mt-2 flex items-center gap-3">
            <Button type="submit" disabled={check.state !== 'available' || creating || !ready}>
              {creating ? (
                <>
                  <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> Creating
                </>
              ) : authenticated ? (
                'Create organization'
              ) : (
                'Log in to create'
              )}
            </Button>
            {!authenticated ? (
              <span className="text-xs text-muted-foreground">Uses your Crew login. No transaction to sign.</span>
            ) : null}
          </div>
        </form>
      </div>
    </section>
  );
};
