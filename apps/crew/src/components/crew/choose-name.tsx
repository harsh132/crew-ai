/**
 * Choosing your name: alex.crewai.eth, owned by your wallet.
 *
 * The step after unlocking. Every agent is named beneath this — so the name
 * comes before hiring, and before funding, because both are easier to reason
 * about once the crew is somebody's.
 *
 * Three states, in the order a person meets them: pick a name, watch it being
 * set up, and then the crew is connected to it. Skippable — agents then work
 * without names — because a backend that is down should not stand between
 * someone and their own crew.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { shortAddress, useWallet } from '@/lib/use-wallet';
import { isOrgLabel } from '@/lib/orgs';
import { BackendError } from '@/lib/orgs';
import { CREWAI_NAME, USER_NAME_PARTS, checkUsername, claimUsername, useMyName, type UserName } from '@/lib/user-name';
import { claimIdentity, type State } from '@/api';
import { CrewMark } from './crew-mark';

type Availability =
  | { state: 'empty' }
  | { state: 'invalid' }
  | { state: 'checking' }
  | { state: 'available' }
  | { state: 'taken' }
  | { state: 'error'; message: string };

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div className="flex h-full flex-col">
    <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4">
      <CrewMark />
      <span className="text-sm font-medium tracking-tight">Crew AI</span>
    </header>
    <main className="flex min-h-0 flex-1 justify-center overflow-y-auto p-6">
      <div className="my-auto flex w-full max-w-md flex-col gap-6 py-6">{children}</div>
    </main>
  </div>
);

/**
 * Setup progress.
 *
 * One transaction does all four parts, so they finish together: one status line
 * for the transaction, and the parts ticked at once when it lands. Spinning four
 * rows in turn would be animating a sequence that no longer exists.
 */
const Progress = ({ name }: { name: UserName }) => {
  const done = name.status === 'ready';
  const failed = name.status === 'failed';

  return (
    <div className="flex flex-col gap-3">
      {!done ? (
        <p className="flex items-center gap-2 text-sm">
          {failed ? (
            <TriangleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
          ) : (
            <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
          )}
          {failed ? 'The transaction did not go through' : 'Sending one transaction to Sepolia'}
        </p>
      ) : null}
      <ul className="flex flex-col gap-2.5">
        {USER_NAME_PARTS.map((part) => (
          <li key={part} className="flex items-center gap-2.5 text-sm">
            {done ? (
              <Check className="size-4 shrink-0 text-success" aria-hidden />
            ) : (
              <span aria-hidden className="grid size-4 shrink-0 place-items-center">
                <span className="size-1.5 rounded-full bg-border" />
              </span>
            )}
            <span className={done ? '' : 'text-muted-foreground'}>{part}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

export const ChooseName = ({ state, onSkip }: { state: State; onSkip: () => void }) => {
  const wallet = useWallet();
  const { account, authenticated, ready, connecting, connect, getAccessToken } = wallet;
  const backend = state.crewBackend!;
  const mine = useMyName(backend, wallet);

  const [label, setLabel] = useState('');
  const [availability, setAvailability] = useState<Availability>({ state: 'empty' });
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const field = useRef<HTMLInputElement | null>(null);
  const linked = useRef<string | null>(null);

  useEffect(() => {
    if (!label) return setAvailability({ state: 'empty' });
    if (!isOrgLabel(label)) return setAvailability({ state: 'invalid' });
    setAvailability({ state: 'checking' });
    let cancelled = false;
    const timer = setTimeout(() => {
      checkUsername(backend, label)
        .then((quote) => !cancelled && setAvailability({ state: quote.available ? 'available' : 'taken' }))
        .catch((problem: Error) => !cancelled && setAvailability({ state: 'error', message: problem.message }));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [backend, label]);

  /*
    Once the name is ready and was issued to this crew's signer, the runtime is
    told — once. It checks the chain itself before agreeing, so a name set up for
    some other signer is refused there rather than trusted from here.
  */
  const claimed = mine.name;
  const forThisCrew = claimed ? claimed.signer.toLowerCase() === state.account.toLowerCase() : false;
  useEffect(() => {
    if (!claimed || claimed.status !== 'ready' || !forThisCrew || linked.current === claimed.name) return;
    linked.current = claimed.name;
    setLinking(true);
    setError(null);
    claimIdentity(claimed.name)
      .catch((problem: Error) => {
        linked.current = null;
        setError(problem.message);
      })
      .finally(() => setLinking(false));
  }, [claimed, forThisCrew]);

  const claim = async () => {
    if (availability.state !== 'available') return;
    if (!authenticated || !account) return connect();
    setClaiming(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Your login expired. Log in again to choose a name.');
      const result = await claimUsername(backend, token, { label, wallet: account, signer: state.account });
      mine.setName(result.name);
      mine.refresh();
    } catch (problem) {
      setError(
        problem instanceof BackendError && problem.code === 'name_taken'
          ? `${label}.${CREWAI_NAME} was just taken. Try another.`
          : (problem as Error).message,
      );
    } finally {
      setClaiming(false);
    }
  };

  const skip = (
    <button
      onClick={onSkip}
      className="w-fit text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
    >
      Skip for now — agents will work without names
    </button>
  );

  const errorLine = error ? (
    <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
      {error}
    </p>
  ) : null;

  /* ---------------------------------------------------- already claimed */
  if (claimed) {
    return (
      <Shell>
        <div className="flex flex-col gap-2">
          <h1 className="font-mono text-2xl font-medium tracking-tight break-all">{claimed.name}</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {claimed.status === 'ready'
              ? forThisCrew
                ? linking
                  ? 'Connecting your crew to it…'
                  : 'Ready. Your agents will be named beneath it.'
                : 'This name lets a different crew signer name agents, so this crew cannot use it.'
              : claimed.status === 'failed'
                ? 'Setting up your name stopped. The backend retried and gave up.'
                : 'Setting up your name — one transaction, usually under half a minute.'}
          </p>
        </div>

        <div className="rounded-lg bg-muted px-4 py-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Owned by</span>
            <span className="font-mono" title={claimed.wallet}>
              {shortAddress(claimed.wallet)}
            </span>
          </div>
        </div>

        <Progress name={claimed} />
        {claimed.error ? <p className="text-xs text-muted-foreground">Last error: {claimed.error}</p> : null}
        {errorLine}
        {claimed.status !== 'setting_up' && (!forThisCrew || claimed.status === 'failed' || error) ? skip : null}
      </Shell>
    );
  }

  /* ------------------------------------------------------------- choose */
  const preview = label && isOrgLabel(label) ? label : 'you';

  return (
    <Shell>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium tracking-tight text-balance">Choose your name</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Your crew gets a name under <span className="font-mono">{CREWAI_NAME}</span>, owned by your wallet. Every agent
          you hire is named beneath it.
        </p>
      </div>

      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void claim();
        }}
      >
        <label htmlFor="user-label" className="text-sm font-medium">
          Name
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="user-label"
            ref={field}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder="alex"
            value={label}
            maxLength={32}
            onChange={(event) => setLabel(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            aria-describedby="user-label-status"
            aria-invalid={availability.state === 'invalid' || availability.state === 'taken'}
            className="h-10 font-mono text-base"
          />
          <span className="shrink-0 font-mono text-base text-muted-foreground">.{CREWAI_NAME}</span>
        </div>

        <p id="user-label-status" className="flex min-h-5 items-center gap-1.5 text-sm" aria-live="polite">
          {availability.state === 'invalid' ? (
            <span className="text-muted-foreground">3 to 32 lower-case letters, digits and single hyphens.</span>
          ) : availability.state === 'checking' ? (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> Checking
            </span>
          ) : availability.state === 'available' ? (
            <span className="flex items-center gap-1.5 text-success">
              <Check className="size-4" aria-hidden /> {label}.{CREWAI_NAME} is available, free
            </span>
          ) : availability.state === 'taken' ? (
            <span className="flex items-center gap-1.5 text-destructive">
              <X className="size-4" aria-hidden /> {label}.{CREWAI_NAME} is taken.
            </span>
          ) : availability.state === 'error' ? (
            <span className="text-destructive">{availability.message}</span>
          ) : null}
        </p>

        <div className="flex flex-col gap-1 rounded-lg bg-muted px-4 py-3 font-mono text-sm">
          <span>
            {preview}.{CREWAI_NAME}
          </span>
          <span className="text-muted-foreground">
            researcher.{preview}.{CREWAI_NAME}
          </span>
        </div>

        {account ? (
          <p className="text-sm text-muted-foreground">
            Owned by <span className="font-mono">{shortAddress(account)}</span>. Only your crew can name agents under it,
            and your wallet can take that away.
          </p>
        ) : null}

        {errorLine}

        <div className="mt-1 flex flex-col gap-3">
          {authenticated && account ? (
            <Button type="submit" className="w-full" disabled={availability.state !== 'available' || claiming}>
              {claiming ? (
                <>
                  <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> Claiming
                </>
              ) : (
                'Claim name'
              )}
            </Button>
          ) : (
            <Button type="button" className="w-full" disabled={!ready || connecting} onClick={connect}>
              {connecting ? 'Connecting…' : 'Log in to claim'}
            </Button>
          )}
          {skip}
        </div>
      </form>
    </Shell>
  );
};
