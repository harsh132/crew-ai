/**
 * An organization's home: its names, its wallet, and who is in it.
 *
 * Only what exists today. Invitations, grants and owner approvals come next and
 * are deliberately absent rather than shown as disabled buttons — a control
 * that does nothing yet is a promise the page cannot keep.
 */
import { useState } from 'react';
import { ArrowRight, Copy, LoaderCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useWallet } from '@/lib/use-wallet';
import { useOrg, type MemberRole } from '@/lib/orgs';
import { OrgSetup } from './org-setup';
import { InviteMembers } from './invite-members';

const ROLE_LABEL: Record<MemberRole, string> = { owner: 'Owner', manager: 'Manager', employee: 'Employee' };

const CopyValue = ({ value }: { value: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() =>
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
      className="flex min-w-0 items-center gap-2 rounded-md font-mono text-sm transition-colors hover:text-primary focus-visible:outline-2"
      title="Copy"
    >
      <span className="truncate">{value}</span>
      <Copy className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="sr-only">{copied ? 'Copied' : 'Copy'}</span>
      {copied ? <span className="shrink-0 text-xs text-muted-foreground">Copied</span> : null}
    </button>
  );
};

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex items-center gap-4 border-b py-3 last:border-b-0">
    <dt className="w-32 shrink-0 text-sm text-muted-foreground">{label}</dt>
    <dd className="flex min-w-0 flex-1 items-center">{children}</dd>
  </div>
);

/**
 * What a person can do from here, always present.
 *
 * The organization features that would make this page busy — invitations,
 * member names, budgets — do not exist yet. So the section says that plainly,
 * and offers the one thing that does work: going back to the personal crew,
 * where agents are hired and given work. A page with no way forward reads as
 * broken even when everything on it succeeded.
 */
const NextSteps = ({ status, name, onPersonal }: { status: string; name: string; onPersonal: () => void }) => (
  <div className="flex flex-col gap-3 rounded-lg border px-5 py-4">
    <h2 className="text-base font-medium">What&rsquo;s next</h2>
    {status === 'ready' ? (
      <ul className="flex flex-col gap-2 text-sm leading-relaxed text-muted-foreground">
        <li>
          <span className="text-foreground">{name} is live on ENS.</span> Its names resolve to the organization&rsquo;s
          wallet, which only its owners control.
        </li>
        <li>
          <span className="text-foreground">Hire agents and give them work</span> in your personal crew.
        </li>
        <li>
          <span className="text-foreground">Invite members</span> below by the Crew name they claimed, like
          alex.crewai.eth. They accept in their own Crew and get a name under crew.{name}. Giving members budgets
          isn&rsquo;t in the app yet.
        </li>
      </ul>
    ) : status === 'failed' ? (
      <p className="text-sm leading-relaxed text-muted-foreground">
        Setup stopped after several retries, so this organization isn&rsquo;t usable. The reason is shown above.
        Your personal crew is unaffected.
      </p>
    ) : (
      <p className="text-sm leading-relaxed text-muted-foreground">
        Setup takes about three minutes and carries on without this page open. You can keep working in your personal
        crew meanwhile — this page updates by itself.
      </p>
    )}
    <Button className="w-fit" onClick={onPersonal}>
      Go to your personal crew <ArrowRight aria-hidden />
    </Button>
  </div>
);

export const OrgOverview = ({
  backend,
  orgId,
  onPersonal,
}: {
  backend: string;
  orgId: string;
  onPersonal: () => void;
}) => {
  const wallet = useWallet();
  const { detail, error } = useOrg(backend, orgId, wallet);

  if (!wallet.authenticated) {
    return (
      <section className="grid place-items-center p-10">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <h2 className="text-lg font-medium">Log in to see this organization</h2>
          <p className="text-sm text-muted-foreground">Organizations belong to your Crew login.</p>
        </div>
      </section>
    );
  }

  if (!detail) {
    return (
      <section className="grid place-items-center p-10 text-sm text-muted-foreground">
        {error ? (
          <p className="text-destructive">{error}</p>
        ) : (
          <span className="flex items-center gap-2">
            <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden /> Loading
          </span>
        )}
      </section>
    );
  }

  const { org, members, role } = detail;

  return (
    <section className="flex min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-10 px-6 py-10">
        <header className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <h1 className="font-mono text-2xl font-medium tracking-tight">{org.name}</h1>
            <Badge className="bg-info-soft text-info">{ROLE_LABEL[role]}</Badge>
            {org.status !== 'ready' ? (
              <Badge
                className={org.status === 'failed' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'}
              >
                {org.status === 'failed' ? 'Setup stopped' : 'Setting up'}
              </Badge>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {org.status === 'ready'
              ? `Members get names under crew.${org.name}.`
              : 'Your organization is being registered on ENS.'}
          </p>
        </header>

        {org.status !== 'ready' ? (
          <div className="flex flex-col gap-3">
            <h2 className="text-base font-medium">Setup</h2>
            <OrgSetup org={org} />
          </div>
        ) : null}

        <NextSteps status={org.status} name={org.name} onPersonal={onPersonal} />

        <div className="flex flex-col gap-1">
          <h2 className="text-base font-medium">Details</h2>
          <dl className="flex flex-col">
            <Row label="Name">
              <span className="font-mono text-sm">{org.name}</span>
            </Row>
            <Row label="Members under">
              <span className="font-mono text-sm">crew.{org.name}</span>
            </Row>
            <Row label="Owner wallet">
              <CopyValue value={org.wallet.address} />
            </Row>
            <Row label="Owners">
              <span className="text-sm">
                {members.filter((member) => member.role === 'owner').length} · any one can approve changes
              </span>
            </Row>
          </dl>
        </div>

        <div className="flex flex-col gap-3">
          <h2 className="text-base font-medium">Members</h2>
          {org.status === 'ready' && role !== 'employee' ? (
            <InviteMembers backend={backend} org={org} role={role} />
          ) : null}
          <ul className="flex flex-col">
            {members.map((member) => (
              <li key={member.user_id} className="flex items-center gap-3 border-b py-3 last:border-b-0">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-mono text-sm">
                    {member.subname ?? `${member.user_id.replace(/^did:privy:/, '').slice(0, 10)}…`}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {member.name_status === 'setting_up'
                      ? 'Issuing their name…'
                      : member.name_status === 'failed'
                        ? `Their name could not be issued${member.name_error ? `: ${member.name_error}` : ''}`
                        : member.role === 'owner' && !member.subname
                          ? 'Owner — no member name'
                          : (member.address ?? 'No name issued yet')}
                  </span>
                </div>
                <Badge variant="outline" className="ml-auto">
                  {ROLE_LABEL[member.role]}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
};
