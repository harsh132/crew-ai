/**
 * Which crew you are looking at: your own, or an organization's.
 *
 * Beside the brand, because it answers the question the brand starts — this is
 * Crew, and this is whose. The same place Slack, Linear and Vercel put it, so
 * nobody has to be told where to look.
 *
 * A real menu (Radix), not a hand-rolled popover: keyboard, focus return and
 * dismissal all behave the way a menu is expected to.
 */
import { Building2, Check, ChevronDown, Plus, User } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { cn } from '@/lib/utils';
import type { Org } from '@/lib/orgs';

export type Workspace = { kind: 'personal' } | { kind: 'org'; id: string };

const ROLE_LABEL = { owner: 'Owner', manager: 'Manager', employee: 'Employee' } as const;

const itemClass =
  'flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-2 text-sm outline-none select-none data-[highlighted]:bg-accent';

export const WorkspaceSwitcher = ({
  workspace,
  orgs,
  account,
  onSelect,
  onCreate,
}: {
  workspace: Workspace;
  orgs: Org[];
  /** The personal crew's wallet address, shown so "Personal" means something specific. */
  account: string;
  onSelect: (workspace: Workspace) => void;
  onCreate: () => void;
}) => {
  const current = workspace.kind === 'org' ? orgs.find((org) => org.id === workspace.id) : undefined;
  const short = `${account.slice(0, 6)}…${account.slice(-4)}`;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className={cn(
          'flex h-8 max-w-64 items-center gap-2 rounded-full border px-3 text-sm transition-colors',
          'hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
          'data-[state=open]:bg-accent',
        )}
      >
        {current ? (
          <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <User className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className={cn('truncate', current && 'font-mono')}>{current ? current.name : 'Personal'}</span>
        {current?.role ? (
          <span className="shrink-0 rounded-full bg-info-soft px-2 py-px text-[11px] text-info">
            {ROLE_LABEL[current.role]}
          </span>
        ) : null}
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          /*
            Focus goes where the choice leads, not back to this button. Radix
            returns focus to the trigger on close by default, which silently
            took it away from the name field on the create screen — typing
            straight after choosing "Create organization" typed into nothing.
          */
          onCloseAutoFocus={(event) => event.preventDefault()}
          className={cn(
            'z-50 w-72 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          )}
        >
          <DropdownMenu.Item className={itemClass} onSelect={() => onSelect({ kind: 'personal' })}>
            <User className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span>Personal</span>
            <span className="ml-auto font-mono text-xs text-muted-foreground">{short}</span>
            {workspace.kind === 'personal' ? <Check className="size-4 shrink-0" aria-hidden /> : null}
          </DropdownMenu.Item>

          {orgs.length > 0 ? (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <DropdownMenu.Label className="px-2.5 pt-1.5 pb-1 text-xs text-muted-foreground">
                Organizations
              </DropdownMenu.Label>
              {orgs.map((org) => {
                const selected = workspace.kind === 'org' && workspace.id === org.id;
                return (
                  <DropdownMenu.Item
                    key={org.id}
                    className={itemClass}
                    onSelect={() => onSelect({ kind: 'org', id: org.id })}
                  >
                    <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate font-mono">{org.name}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {org.status === 'setting_up'
                        ? 'Setting up'
                        : org.status === 'failed'
                          ? 'Setup stopped'
                          : org.role
                            ? ROLE_LABEL[org.role]
                            : ''}
                    </span>
                    {selected ? <Check className="size-4 shrink-0" aria-hidden /> : null}
                  </DropdownMenu.Item>
                );
              })}
            </>
          ) : null}

          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item className={itemClass} onSelect={onCreate}>
            <Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span>Create organization</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
};
