/**
 * One agent's money and identity — the two things that can stop it working.
 *
 * Where a chat app would put settings, because there is nothing to configure
 * here: an agent is a name and a budget, and the only action is to take both
 * away.
 */
import { useMemo, useState } from 'react';
import { LoaderCircle, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { AgentMark } from './agent-mark';
import { FactList } from './fact-list';
import { Ledger } from './ledger';
import { EditDialog } from './edit-dialog';
import { PermissionList } from './permission-fields';
import { Section } from './section';
import { SpendMeter } from './spend-meter';
import { nameOf, when } from '@/lib/format';
import { cn } from '@/lib/utils';
import { fire, removeAgent, type Agent, type State } from '@/api';

export const AgentDetail = ({ agent, state }: { agent: Agent; state: State }) => {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  /*
    The tail, newest first. An agent that has run all day has hundreds of steps
    and the interesting ones are the recent ones; the thread is where the whole
    history lives.
  */
  const steps = useMemo(() => agent.tasks.flatMap((task) => task.steps).slice(-14).reverse(), [agent.tasks]);

  const revoked = agent.status === 'revoked';

  return (
    <aside className="flex flex-col gap-5 overflow-y-auto border-l bg-card">
      {/*
        The banner, laid out the way ENS lays one out — the mark sitting over
        its bottom edge — because that is where these two records are read from
        by everyone who is not us.
      */}
      <div className="relative">
        <div className="h-20 w-full bg-accent/30">
          {agent.header ? <img src={agent.header} alt="" className="size-full object-cover" /> : null}
        </div>
        <div className="flex flex-col items-center gap-2 px-5 pb-1 text-center">
          <AgentMark agent={agent} size="lg" className="-mt-7 rounded-xl ring-4 ring-card" />
          <div className="text-sm font-semibold">{nameOf(agent)}</div>
        <div
          className={cn(
            'font-mono text-[11px] break-all',
            agent.name ? 'text-muted-foreground' : 'text-muted-foreground/60 italic',
          )}
        >
          {agent.name ?? (state.naming ? 'name could not be minted' : 'names are off on this chain')}
          </div>

          {agent.status !== 'revoked' ? (
            <Button variant="outline" size="sm" className="mt-1 h-7 px-2.5 text-xs" onClick={() => setEditing(true)}>
              <Pencil className="size-3" /> Edit
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-5 px-5 pb-5">
      <Section title="Budget" className="gap-2.5">
        <SpendMeter
          spentMinor={agent.spentMinor}
          budgetMinor={agent.budgetMinor}
          spent={agent.spent}
          budget={agent.budget}
        />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Enforced by the authority holding the wallet, not by the agent. It has no key and cannot raise this.
        </p>
      </Section>

      <Separator />

      <Section title="Identity">
        <FactList
          facts={[
            {
              term: 'pays from',
              value: agent.account ? `${agent.account.slice(0, 12)}…` : '—',
              ...(agent.account ? { title: agent.account } : {}),
            },
            { term: 'model', value: agent.model },
            { term: 'hired', value: when(agent.createdAt) },
          ]}
        />
      </Section>

      <Section title="Permissions">
        <PermissionList
          granted={agent.permissions}
          available={state.permissions}
        />
      </Section>

      {steps.length > 0 ? (
        <>
          <Separator />
          <Section title="Ledger">
            <Ledger steps={steps} network={agent.network} />
          </Section>
        </>
      ) : null}

      <div className="mt-auto flex flex-col gap-2 pt-2">
        {revoked ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Its address record was cleared, so the authority refuses to sign for it — including on a restart, and
            including mid-task.
          </p>
        ) : (
          <Button
            variant="outline"
            className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await fire(agent.id);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Revoking…' : agent.name ? 'Revoke on chain' : 'Revoke'}
          </Button>
        )}

        {/*
          Deleting takes the agent off the roster, revoking it first if it is
          still live — so a deleted agent can never be left able to spend.
        */}
        <Button
          variant="outline"
          className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={busy}
          onClick={() => {
            setDeleteError(null);
            setConfirmingDelete(true);
          }}
        >
          <Trash2 className="size-4" aria-hidden /> Delete agent
        </Button>
      </div>
      </div>

      <Dialog open={confirmingDelete} onOpenChange={(next) => !next && !deleting && setConfirmingDelete(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {nameOf(agent)}?</DialogTitle>
            <DialogDescription>
              {revoked
                ? 'It is already revoked. Deleting removes it and its history from your crew.'
                : agent.name
                  ? `This revokes ${agent.name} on chain first — its address record is cleared and its budget is taken back, so it can never spend again — then removes it and its history from your crew.`
                  : 'This revokes its budget first, so it can never spend again, then removes it and its history from your crew.'}{' '}
              This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {agent.running ? (
            <p className="text-sm text-muted-foreground">It is working right now. Stop it before deleting it.</p>
          ) : null}
          {deleteError ? (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
              {deleteError}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmingDelete(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleting || agent.running}
              onClick={async () => {
                setDeleting(true);
                setDeleteError(null);
                try {
                  await removeAgent(agent.id);
                  setConfirmingDelete(false);
                } catch (problem) {
                  setDeleteError((problem as Error).message);
                } finally {
                  setDeleting(false);
                }
              }}
            >
              {deleting ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
              {deleting ? (revoked ? 'Deleting' : 'Revoking and deleting') : 'Delete agent'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {editing ? (
        /*
          Keyed on the agent, so switching agents while it is open rebuilds the
          form rather than leaving one agent's description in another's fields.
        */
        <EditDialog key={agent.id} agent={agent} state={state} open onClose={() => setEditing(false)} />
      ) : null}
    </aside>
  );
};
