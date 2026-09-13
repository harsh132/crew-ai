/**
 * An organization's setup, step by step, as it happens on chain.
 *
 * The steps are the backend's real ones, read from it every few seconds — not a
 * timed animation. A step shown done is a step whose transaction landed.
 */
import { Check, Circle, LoaderCircle, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SETUP_STEPS, type Org } from '@/lib/orgs';

export const OrgSetup = ({ org }: { org: Org }) => {
  const current = SETUP_STEPS.findIndex((entry) => entry.step === org.step);
  const failed = org.status === 'failed';

  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col">
        <li className="flex items-center gap-3 py-1.5 text-sm">
          <Check className="size-4 shrink-0 text-success" aria-hidden />
          <span>Create the owner wallet</span>
        </li>
        {SETUP_STEPS.map((entry, index) => {
          const done = org.status === 'ready' || (current >= 0 && index < current);
          const active = !done && index === current;
          return (
            <li
              key={entry.step}
              aria-current={active ? 'step' : undefined}
              className={cn(
                'flex items-center gap-3 py-1.5 text-sm',
                !done && !active && 'text-muted-foreground',
              )}
            >
              {done ? (
                <Check className="size-4 shrink-0 text-success" aria-hidden />
              ) : active && failed ? (
                <TriangleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
              ) : active ? (
                <LoaderCircle className="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-hidden />
              ) : (
                <Circle className="size-4 shrink-0" aria-hidden />
              )}
              <span>{entry.label}</span>
              {active && entry.step === 'register' && !failed ? (
                <span className="ml-auto text-xs text-muted-foreground">Waiting about a minute</span>
              ) : null}
            </li>
          );
        })}
      </ol>

      {failed ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Setup stopped after several attempts{org.error ? `: ${org.error}` : '.'}
        </p>
      ) : org.error ? (
        <p className="text-xs text-muted-foreground">Retrying — {org.error}</p>
      ) : org.status === 'setting_up' ? (
        <p className="text-xs text-muted-foreground">Takes about four minutes. You can leave; it keeps going.</p>
      ) : null}
    </div>
  );
};
