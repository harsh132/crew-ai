/**
 * An invite arriving: the pop-up an employee sees when an organization invites
 * their Crew name.
 *
 * Checked when the app opens and every half minute after, while logged in. One
 * invite at a time, newest first. "Later" hides that invite for this visit; it
 * comes back the next time Crew is opened, until it is answered or expires.
 */
import { useCallback, useEffect, useState } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useWallet } from '@/lib/use-wallet';
import { answerInvite, listMyInvites, type ReceivedInvite } from '@/lib/orgs';

const POLL_MS = 30_000;
const ROLE_LABEL = { manager: 'a manager', employee: 'an employee' } as const;

export const InviteReceived = ({
  backend,
  onJoined,
}: {
  backend: string;
  /** Called after accepting, with the organization; `open` when the person asks to go there now. */
  onJoined: (orgId: string, open: boolean) => void;
}) => {
  const { authenticated, getAccessToken } = useWallet();
  const [invites, setInvites] = useState<ReceivedInvite[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [answering, setAnswering] = useState<'accept' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState<{ invite: ReceivedInvite } | null>(null);

  const refresh = useCallback(async () => {
    if (!authenticated) return;
    const token = await getAccessToken();
    if (!token) return;
    const result = await listMyInvites(backend, token).catch(() => null);
    if (result) setInvites(result.invites);
  }, [authenticated, backend, getAccessToken]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const current = joined?.invite ?? invites.find((invite) => !hidden.includes(invite.id)) ?? null;

  const answer = async (invite: ReceivedInvite, choice: 'accept' | 'decline') => {
    setAnswering(choice);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Your login expired. Log in again to answer this invite.');
      await answerInvite(backend, token, invite.id, choice);
      setInvites((previous) => previous.filter((candidate) => candidate.id !== invite.id));
      if (choice === 'accept') {
        setJoined({ invite });
        onJoined(invite.org.id, false);
      }
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setAnswering(null);
    }
  };

  if (!current) return null;

  const close = () => {
    if (joined) setJoined(null);
    else setHidden((previous) => [...previous, current.id]);
    setError(null);
  };

  return (
    <Dialog open onOpenChange={(next) => !next && !answering && close()}>
      <DialogContent className="sm:max-w-md">
        {joined ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Check className="size-5 text-success" aria-hidden /> You joined {current.org.name}
              </DialogTitle>
              <DialogDescription>
                Your name <span className="font-mono">{current.name}</span> is being issued to your wallet. It takes
                about half a minute and needs nothing from you.
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={close}>
                Stay here
              </Button>
              <Button
                onClick={() => {
                  onJoined(current.org.id, true);
                  close();
                }}
              >
                Open {current.org.name}
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>You&rsquo;re invited to {current.org.name}</DialogTitle>
              <DialogDescription>
                {current.org.name} invited you to join as {ROLE_LABEL[current.role]}. If you accept, you&rsquo;ll get
                the name <span className="font-mono">{current.name}</span>, owned by your own wallet.
              </DialogDescription>
            </DialogHeader>

            <p className="text-xs text-muted-foreground">
              Expires {new Date(current.expiresAt).toLocaleDateString()}.
              {invites.length > 1 ? ` ${invites.length - 1} more invite${invites.length > 2 ? 's' : ''} waiting.` : ''}
            </p>

            {error ? (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}

            <div className="flex items-center justify-between gap-2">
              <Button variant="ghost" onClick={close} disabled={answering !== null}>
                Later
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => void answer(current, 'decline')} disabled={answering !== null}>
                  {answering === 'decline' ? 'Declining…' : 'Decline'}
                </Button>
                <Button onClick={() => void answer(current, 'accept')} disabled={answering !== null}>
                  {answering === 'accept' ? (
                    <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />
                  ) : null}
                  {answering === 'accept' ? 'Joining' : 'Accept'}
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};
