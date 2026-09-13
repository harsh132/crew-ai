/**
 * Inviting members into an organization, by the Crew name they claimed.
 *
 * An employee claims alex.crewai.eth and gives that name to their employer. The
 * employer types it here, and the invite appears in the employee's Crew the next
 * time they open it — no link to pass around. Their name inside the
 * organization follows from the one they claimed: alex.crew.org.eth.
 */
import { useCallback, useEffect, useState } from 'react';
import { Check, LoaderCircle, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useWallet } from '@/lib/use-wallet';
import { CREWAI_NAME } from '@/lib/user-name';
import { cn } from '@/lib/utils';
import { createInvite, isOrgLabel, listInvites, revokeInvite, type Invite, type MemberRole, type Org } from '@/lib/orgs';

const ROLE_LABEL = { manager: 'Manager', employee: 'Employee' } as const;

/** What someone typed, as a full Crew name — or null when it cannot be one. */
const crewNameOf = (input: string): string | null => {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  const full = trimmed.endsWith(`.${CREWAI_NAME}`) ? trimmed : `${trimmed}.${CREWAI_NAME}`;
  return isOrgLabel(full.slice(0, -(CREWAI_NAME.length + 1))) ? full : null;
};

export const InviteMembers = ({
  backend,
  org,
  role,
}: {
  backend: string;
  org: Org;
  role: MemberRole;
}) => {
  const { getAccessToken } = useWallet();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [inviteRole, setInviteRole] = useState<Invite['role']>('employee');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Invite | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [revoking, setRevoking] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) return;
    setInvites((await listInvites(backend, token, org.id).catch(() => ({ invites: [] }))).invites);
  }, [backend, org.id, getAccessToken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const reset = () => {
    setTyped('');
    setInviteRole('employee');
    setError(null);
    setSent(null);
  };

  const inviteeName = crewNameOf(typed);
  const memberName = inviteeName ? `${inviteeName.slice(0, -(CREWAI_NAME.length + 1))}.crew.${org.name}` : null;

  const send = async () => {
    if (!inviteeName) return;
    setSending(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Your login expired. Log in again to invite members.');
      const result = await createInvite(backend, token, org.id, { name: inviteeName, role: inviteRole });
      setSent(result.invite);
      void refresh();
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setSending(false);
    }
  };

  const revoke = async (inviteId: string) => {
    setRevoking(inviteId);
    try {
      const token = await getAccessToken();
      if (token) await revokeInvite(backend, token, org.id, inviteId);
      await refresh();
    } finally {
      setRevoking(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Button
        variant="outline"
        className="w-fit"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        <UserPlus aria-hidden /> Invite member
      </Button>

      {invites.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Waiting for them to accept</span>
          <ul className="flex flex-col">
            {invites.map((invite) => (
              <li key={invite.id} className="flex items-center gap-3 border-b py-2.5 last:border-b-0">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-mono text-sm">{invite.inviteeName}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {ROLE_LABEL[invite.role]} · will be {invite.name} · expires{' '}
                    {new Date(invite.expiresAt).toLocaleDateString()}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto text-muted-foreground hover:text-destructive"
                  disabled={revoking === invite.id}
                  onClick={() => void revoke(invite.id)}
                >
                  {revoking === invite.id ? 'Revoking…' : 'Revoke'}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Dialog open={open} onOpenChange={(next) => !next && !sending && setOpen(false)}>
        <DialogContent className="sm:max-w-md">
          {sent ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Check className="size-5 text-success" aria-hidden /> Invite sent
                </DialogTitle>
                <DialogDescription>
                  <span className="font-mono">{sent.inviteeName}</span> will see it the next time they open Crew. When
                  they accept, they join {org.name} as {ROLE_LABEL[sent.role].toLowerCase()} and get the name{' '}
                  <span className="font-mono">{sent.name}</span>. The invite expires in 7 days.
                </DialogDescription>
              </DialogHeader>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={reset}>
                  Invite another
                </Button>
                <Button onClick={() => setOpen(false)}>Done</Button>
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Invite a member</DialogTitle>
                <DialogDescription>
                  Enter the Crew name they claimed. They&rsquo;ll get the invite in Crew and can accept it there.
                </DialogDescription>
              </DialogHeader>

              <form
                className="flex flex-col gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void send();
                }}
              >
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="invite-name" className="text-sm font-medium">
                    Their Crew name
                  </label>
                  <Input
                    id="invite-name"
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={`alex.${CREWAI_NAME}`}
                    value={typed}
                    maxLength={64}
                    onChange={(event) => setTyped(event.target.value)}
                    className="font-mono"
                  />
                  <span className="min-h-4 text-xs text-muted-foreground">
                    {typed && !inviteeName
                      ? `A name like alex.${CREWAI_NAME} — lower-case letters, digits and single hyphens.`
                      : memberName
                        ? `In ${org.name} they'll be ${memberName}.`
                        : 'They can copy it from the bottom of their Crew sidebar.'}
                  </span>
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium">Role</span>
                  <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Role">
                    {(['employee', 'manager'] as const).map((option) => {
                      const allowed = option === 'employee' || role === 'owner';
                      return (
                        <button
                          key={option}
                          type="button"
                          role="radio"
                          aria-checked={inviteRole === option}
                          disabled={!allowed}
                          onClick={() => setInviteRole(option)}
                          className={cn(
                            'flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                            inviteRole === option ? 'border-primary bg-primary/10' : 'hover:bg-accent',
                          )}
                        >
                          <span className="text-sm font-medium">{ROLE_LABEL[option]}</span>
                          <span className="text-xs text-muted-foreground">
                            {option === 'employee' ? 'Works within the budget they are given' : 'Can invite employees'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {role !== 'owner' ? (
                    <span className="text-xs text-muted-foreground">Only owners can invite managers.</span>
                  ) : null}
                </div>

                {error ? (
                  <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
                    {error}
                  </p>
                ) : null}

                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={sending}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={!inviteeName || sending}>
                    {sending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
                    {sending ? 'Sending' : 'Send invite'}
                  </Button>
                </div>
              </form>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};
