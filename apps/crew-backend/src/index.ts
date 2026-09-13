/**
 * The crew backend: organizations for Crew AI.
 *
 *   GET  /health
 *   GET  /v1/names/:label     is label.eth free, and what it costs
 *   POST /v1/orgs             create an organization { label }
 *   GET  /v1/orgs             the organizations you belong to
 *   GET  /v1/orgs/:id         one of them, with its members and setup progress
 *   GET  /v1/usernames/:label is label.crewai.eth free
 *   POST /v1/me/name          claim label.crewai.eth { label, wallet, signer }
 *   GET  /v1/me               your name under crewai.eth, and its setup progress
 *   POST /v1/orgs/:id/invites                  invite a Crew user by name { name, role }
 *   GET  /v1/orgs/:id/invites                  pending invites
 *   POST /v1/orgs/:id/invites/:inviteId/revoke take an invite back
 *   GET  /v1/me/invites                        invites waiting for you
 *   POST /v1/me/invites/:inviteId/accept       join the organization
 *   POST /v1/me/invites/:inviteId/decline      turn it down
 *
 * Every route but /health, /v1/names and /v1/usernames needs a Privy access
 * token as a bearer token.
 *
 * ## What this backend is trusted with, and what it is not
 *
 * It creates an organization's Privy key quorum and wallet, pays for the
 * organization's name, and issues members' names. It does not own any of it.
 * The name belongs to the org wallet; the wallet belongs to the quorum; and the
 * quorum's members are the organization's owners. `privy-check.ts` showed live
 * that the app secret this Worker holds cannot change a quorum, a wallet's owner
 * or its signers — so a breach of this Worker exposes a member list, not an
 * organization.
 */
import { PrivyClient } from '@privy-io/node';
import { getAddress, isAddress } from 'viem';
import { clientsFor, isOrgLabel, managerAddress, quoteName } from './ens';
import { CREWAI_NAME, isUserNameFree } from './names';
import type { Env } from './env';

export { OrgSetup } from './setup';
export { NameSetup } from './user-setup';
export { MemberNameSetup } from './member-setup';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      /*
        Any origin, and no credentials. Authentication is a bearer token the
        caller attaches deliberately, never a cookie a browser attaches on its
        own — so allowing every origin lets the crew app run from wherever it
        is served without letting a third-party page act as a logged-in user.
      */
      'access-control-allow-origin': '*',
    },
  });

const refuse = (code: string, detail: string, status: number): Response =>
  json({ error: { code, detail } }, status);

const preflight = (): Response =>
  new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-max-age': '86400',
    },
  });

/*
  One client per isolate. It caches Privy's verification keys, which is the
  difference between checking a token locally and asking Privy on every request.
*/
let privy: PrivyClient | null = null;
const privyFor = (env: Env): PrivyClient =>
  (privy ??= new PrivyClient({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET }));

type Caller = { userId: string };

const authenticate = async (request: Request, env: Env): Promise<Caller | Response> => {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    return refuse('unauthenticated', 'send a Privy access token as a Bearer token', 401);
  }
  try {
    const verified = await privyFor(env).utils().auth().verifyAccessToken(header.slice(7).trim());
    return { userId: verified.user_id };
  } catch {
    // Why a token failed is not described: expired, forged and malformed are
    // all the same answer to the caller, and a distinction is a hint.
    return refuse('unauthenticated', 'the access token is not valid', 401);
  }
};

type OrgRow = {
  id: string;
  label: string;
  name: string;
  founder_user_id: string;
  owner_quorum_id: string;
  wallet_id: string;
  wallet_address: string;
  status: string;
  step: string;
  error: string | null;
  resolver: string | null;
  registry: string | null;
  crew_registry: string | null;
  created_at: number;
  updated_at: number;
};

/** An organization as the API shows it. Quorum and wallet ids are Privy's, and not secret. */
const present = (org: OrgRow) => ({
  id: org.id,
  name: org.name,
  label: org.label,
  status: org.status,
  step: org.step,
  error: org.error,
  wallet: { id: org.wallet_id, address: org.wallet_address },
  ownerQuorumId: org.owner_quorum_id,
  contracts:
    org.resolver && org.registry && org.crew_registry
      ? { resolver: org.resolver, registry: org.registry, crewRegistry: org.crew_registry }
      : null,
  createdAt: org.created_at,
  updatedAt: org.updated_at,
});

const createOrg = async (request: Request, env: Env, caller: Caller): Promise<Response> => {
  let body: { label?: unknown };
  try {
    body = (await request.json()) as { label?: unknown };
  } catch {
    return refuse('bad_request', 'body must be JSON', 400);
  }
  const label = typeof body.label === 'string' ? body.label.trim().toLowerCase() : '';
  if (!isOrgLabel(label)) {
    return refuse(
      'bad_label',
      'a label is 3 to 32 lower-case letters, digits and single hyphens, starting and ending with a letter or digit',
      400,
    );
  }

  /*
    Checked in this order because each is cheaper than the next and every one of
    them can refuse: our own table, then the chain, then Privy — the only step
    that creates anything. A name taken on chain is refused before a quorum and
    wallet are made for an organization that can never exist.
  */
  const taken = await env.DB.prepare('SELECT id FROM orgs WHERE label = ?').bind(label).first();
  if (taken) return refuse('name_taken', `${label}.eth already belongs to an organization here`, 409);

  const quote = await quoteName(clientsFor(env), label);
  if (!quote.available) return refuse('name_taken', `${label}.eth is already registered`, 409);

  const client = privyFor(env);
  /*
    The founder is the quorum's only member, at a threshold of one. They can
    add owners and raise the threshold on their own; after that, changing the
    quorum needs as many owners as the threshold says.
  */
  const quorum = await client.keyQuorums().create({
    user_ids: [caller.userId],
    authorization_threshold: 1,
    display_name: `${label}.eth owners`.slice(0, 50),
  });
  const wallet = await client.wallets().create({ chain_type: 'ethereum', owner_id: quorum.id });

  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO orgs (id, label, name, founder_user_id, owner_quorum_id, wallet_id, wallet_address,
                           status, step, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'setting_up', 'contracts', ?, ?)`,
      ).bind(id, label, `${label}.eth`, caller.userId, quorum.id, wallet.id, wallet.address, now, now),
      env.DB.prepare(
        "INSERT INTO members (org_id, user_id, address, role, subname, created_at) VALUES (?, ?, NULL, 'owner', NULL, ?)",
      ).bind(id, caller.userId, now),
      env.DB.prepare('INSERT INTO audit (org_id, at, actor, action, detail) VALUES (?, ?, ?, ?, ?)').bind(
        id,
        now,
        caller.userId,
        'org_created',
        JSON.stringify({ label, quorum: quorum.id, wallet: wallet.address }),
      ),
    ]);
  } catch {
    /*
      Lost a race for the label between the check above and this insert. The
      quorum and wallet just created are left unused in Privy; they own nothing
      and hold nothing.
    */
    return refuse('name_taken', `${label}.eth was just taken by another organization`, 409);
  }

  await env.ORG_SETUP.getByName(id).start({ orgId: id, label, orgWallet: wallet.address as `0x${string}` });

  const org = await env.DB.prepare('SELECT * FROM orgs WHERE id = ?').bind(id).first<OrgRow>();
  return json({ org: present(org!), priceMinor: quote.priceMinor }, 202);
};

const listOrgs = async (env: Env, caller: Caller): Promise<Response> => {
  const { results } = await env.DB.prepare(
    `SELECT orgs.*, members.role AS role FROM orgs
     JOIN members ON members.org_id = orgs.id
     WHERE members.user_id = ?
     ORDER BY orgs.created_at DESC`,
  )
    .bind(caller.userId)
    .all<OrgRow & { role: string }>();
  return json({ orgs: results.map((org) => ({ ...present(org), role: org.role })) });
};

const getOrg = async (env: Env, caller: Caller, id: string): Promise<Response> => {
  const membership = await env.DB.prepare('SELECT role FROM members WHERE org_id = ? AND user_id = ?')
    .bind(id, caller.userId)
    .first<{ role: string }>();
  /*
    Not found rather than forbidden. Saying an organization exists to someone
    outside it is already telling them something.
  */
  if (!membership) return refuse('not_found', 'no such organization', 404);

  const org = await env.DB.prepare('SELECT * FROM orgs WHERE id = ?').bind(id).first<OrgRow>();
  if (!org) return refuse('not_found', 'no such organization', 404);

  const { results: members } = await env.DB.prepare(
    'SELECT user_id, address, role, subname, name_status, name_error, created_at FROM members WHERE org_id = ? ORDER BY created_at',
  )
    .bind(id)
    .all();

  const setup = await env.ORG_SETUP.getByName(id).status();
  return json({ org: present(org), role: membership.role, members, setup });
};

/* ------------------------------------------------------------------ invites */

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Member names expire just inside the crew name's first year, which began when the org was created. */
const MEMBER_NAME_MS = 360 * 24 * 60 * 60 * 1000;

type InviteRow = {
  id: string;
  org_id: string;
  invitee_user_id: string;
  invitee_name: string;
  label: string;
  role: 'manager' | 'employee';
  created_by: string;
  status: 'pending' | 'accepted' | 'revoked' | 'declined';
  expires_at: number;
  created_at: number;
  updated_at: number;
};

/**
 * A Crew user's name as someone typed it: `alex`, `alex.crewai.eth`, or with
 * stray capitals. Null when it cannot be a name this backend issued.
 */
const crewNameOf = (input: string): string | null => {
  const trimmed = input.trim().toLowerCase();
  const full = trimmed.endsWith(`.${CREWAI_NAME}`) ? trimmed : `${trimmed}.${CREWAI_NAME}`;
  const label = full.slice(0, -(CREWAI_NAME.length + 1));
  return isOrgLabel(label) ? full : null;
};

const presentInvite = (invite: InviteRow, orgName: string) => ({
  id: invite.id,
  inviteeName: invite.invitee_name,
  label: invite.label,
  name: `${invite.label}.crew.${orgName}`,
  role: invite.role,
  status: invite.status === 'pending' && invite.expires_at <= Date.now() ? 'expired' : invite.status,
  expiresAt: invite.expires_at,
  createdAt: invite.created_at,
});

const roleIn = async (env: Env, orgId: string, userId: string): Promise<string | null> =>
  (
    await env.DB.prepare('SELECT role FROM members WHERE org_id = ? AND user_id = ?')
      .bind(orgId, userId)
      .first<{ role: string }>()
  )?.role ?? null;

/**
 * Invites a Crew user, by the name they claimed.
 *
 * Owners may invite managers and employees; managers only employees — a manager
 * who could mint managers could mint anyone. The person is found through their
 * crewai.eth name, which this backend issued, so the invite is addressed to a
 * real Privy user rather than to whoever holds a link. Their name inside the
 * organization defaults to the same label: alex.crewai.eth becomes
 * alex.crew.org.eth.
 */
const createInvite = async (request: Request, env: Env, caller: Caller, orgId: string): Promise<Response> => {
  const role = await roleIn(env, orgId, caller.userId);
  if (!role) return refuse('not_found', 'no such organization', 404);
  if (role === 'employee') return refuse('forbidden', 'only owners and managers can invite members', 403);

  const org = await env.DB.prepare('SELECT * FROM orgs WHERE id = ?').bind(orgId).first<OrgRow>();
  if (!org) return refuse('not_found', 'no such organization', 404);
  if (org.status !== 'ready' || !org.crew_registry || !org.resolver) {
    return refuse('not_ready', 'the organization is still being set up', 409);
  }

  let body: { name?: unknown; role?: unknown; label?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return refuse('bad_request', 'body must be JSON', 400);
  }
  const inviteeName = typeof body.name === 'string' ? crewNameOf(body.name) : null;
  if (!inviteeName) return refuse('bad_name', `enter their Crew name, like alex.${CREWAI_NAME}`, 400);
  const inviteRole = body.role === 'manager' ? 'manager' : body.role === 'employee' ? 'employee' : null;
  if (!inviteRole) return refuse('bad_role', 'role must be manager or employee', 400);
  if (inviteRole === 'manager' && role !== 'owner') return refuse('forbidden', 'only owners can invite managers', 403);

  const invitee = await env.DB.prepare('SELECT * FROM user_names WHERE name = ?').bind(inviteeName).first<UserNameRow>();
  if (!invitee) return refuse('unknown_user', `${inviteeName} isn't a Crew user — they need to claim it in Crew first`, 404);
  if (invitee.status !== 'ready') return refuse('user_not_ready', `${inviteeName} is still being set up; try again shortly`, 409);
  if (await roleIn(env, orgId, invitee.user_id)) {
    return refuse('already_member', `${inviteeName} is already a member of ${org.name}`, 409);
  }

  const now = Date.now();
  const alreadyInvited = await env.DB.prepare(
    "SELECT 1 FROM invites WHERE org_id = ? AND invitee_user_id = ? AND status = 'pending' AND expires_at > ?",
  )
    .bind(orgId, invitee.user_id, now)
    .first();
  if (alreadyInvited) return refuse('already_invited', `${inviteeName} already has an invite waiting`, 409);

  const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().toLowerCase() : invitee.label;
  if (!isOrgLabel(label)) {
    return refuse('bad_label', 'a name is 3 to 32 lower-case letters, digits and single hyphens', 400);
  }
  const name = `${label}.crew.${org.name}`;
  const clash = await env.DB.prepare(
    `SELECT 1 FROM members WHERE org_id = ? AND subname = ?
     UNION ALL
     SELECT 1 FROM invites WHERE org_id = ? AND label = ? AND status = 'pending' AND expires_at > ?`,
  )
    .bind(orgId, name, orgId, label, now)
    .first();
  if (clash) return refuse('name_taken', `${name} is already taken or invited`, 409);

  const invite: InviteRow = {
    id: crypto.randomUUID(),
    org_id: orgId,
    invitee_user_id: invitee.user_id,
    invitee_name: inviteeName,
    label,
    role: inviteRole,
    created_by: caller.userId,
    status: 'pending',
    expires_at: now + INVITE_TTL_MS,
    created_at: now,
    updated_at: now,
  };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO invites (id, org_id, invitee_user_id, invitee_name, label, role, created_by, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).bind(invite.id, orgId, invitee.user_id, inviteeName, label, inviteRole, caller.userId, invite.expires_at, now, now),
    env.DB.prepare('INSERT INTO audit (org_id, at, actor, action, detail) VALUES (?, ?, ?, ?, ?)').bind(
      orgId,
      now,
      caller.userId,
      'invite_created',
      JSON.stringify({ invite: invite.id, invitee: inviteeName, label, role: inviteRole }),
    ),
  ]);

  return json({ invite: presentInvite(invite, org.name) }, 201);
};

const listInvites = async (env: Env, caller: Caller, orgId: string): Promise<Response> => {
  const role = await roleIn(env, orgId, caller.userId);
  if (!role) return refuse('not_found', 'no such organization', 404);
  if (role === 'employee') return refuse('forbidden', 'only owners and managers can see invites', 403);
  const org = await env.DB.prepare('SELECT name FROM orgs WHERE id = ?').bind(orgId).first<{ name: string }>();
  const { results } = await env.DB.prepare(
    "SELECT * FROM invites WHERE org_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC",
  )
    .bind(orgId, Date.now())
    .all<InviteRow>();
  return json({ invites: results.map((invite) => presentInvite(invite, org!.name)) });
};

const revokeInvite = async (env: Env, caller: Caller, orgId: string, inviteId: string): Promise<Response> => {
  const role = await roleIn(env, orgId, caller.userId);
  if (!role) return refuse('not_found', 'no such organization', 404);
  if (role === 'employee') return refuse('forbidden', 'only owners and managers can revoke invites', 403);
  const now = Date.now();
  const result = await env.DB.prepare(
    "UPDATE invites SET status = 'revoked', updated_at = ? WHERE id = ? AND org_id = ? AND status = 'pending'",
  )
    .bind(now, inviteId, orgId)
    .run();
  if (!result.meta.changes) return refuse('not_found', 'no pending invite with that id', 404);
  await env.DB.prepare('INSERT INTO audit (org_id, at, actor, action, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(orgId, now, caller.userId, 'invite_revoked', JSON.stringify({ invite: inviteId }))
    .run();
  return json({ revoked: true });
};

/** Invites waiting for the caller, with the organization each one is from. */
const myInvites = async (env: Env, caller: Caller): Promise<Response> => {
  const { results } = await env.DB.prepare(
    `SELECT invites.*, orgs.name AS org_name FROM invites
     JOIN orgs ON orgs.id = invites.org_id
     WHERE invites.invitee_user_id = ? AND invites.status = 'pending' AND invites.expires_at > ?
     ORDER BY invites.created_at DESC`,
  )
    .bind(caller.userId, Date.now())
    .all<InviteRow & { org_name: string }>();
  return json({
    invites: results.map((invite) => ({
      id: invite.id,
      org: { id: invite.org_id, name: invite.org_name },
      role: invite.role,
      name: `${invite.label}.crew.${invite.org_name}`,
      expiresAt: invite.expires_at,
    })),
  });
};

/**
 * Accepts or declines an invite addressed to the caller.
 *
 * Accepting claims the invite atomically before anything else, so answering
 * twice at once joins once. The member's name is issued to the wallet that owns
 * their crewai.eth name — the wallet this backend already checked against Privy
 * when that name was claimed, and the only one invites can find them by.
 */
const answerInvite = async (env: Env, caller: Caller, inviteId: string, accept: boolean): Promise<Response> => {
  const invite = await env.DB.prepare('SELECT * FROM invites WHERE id = ? AND invitee_user_id = ?')
    .bind(inviteId, caller.userId)
    .first<InviteRow>();
  if (!invite) return refuse('not_found', 'no such invite', 404);
  const org = await env.DB.prepare('SELECT * FROM orgs WHERE id = ?').bind(invite.org_id).first<OrgRow>();
  if (!org) return refuse('not_found', 'no such invite', 404);
  const shown = presentInvite(invite, org.name);
  if (shown.status !== 'pending') return refuse(`invite_${shown.status}`, `this invite has been ${shown.status}`, 409);

  const now = Date.now();
  if (!accept) {
    const declined = await env.DB.prepare(
      "UPDATE invites SET status = 'declined', updated_at = ? WHERE id = ? AND status = 'pending'",
    )
      .bind(now, invite.id)
      .run();
    if (!declined.meta.changes) return refuse('invite_taken', 'this invite was just answered', 409);
    await env.DB.prepare('INSERT INTO audit (org_id, at, actor, action, detail) VALUES (?, ?, ?, ?, ?)')
      .bind(org.id, now, caller.userId, 'invite_declined', JSON.stringify({ invite: invite.id }))
      .run();
    return json({ declined: true });
  }

  if (!org.crew_registry || !org.resolver) return refuse('not_ready', 'the organization is still being set up', 409);
  if (await roleIn(env, org.id, caller.userId)) {
    return refuse('already_member', `you are already a member of ${org.name}`, 409);
  }
  const mine = await env.DB.prepare('SELECT * FROM user_names WHERE user_id = ?').bind(caller.userId).first<UserNameRow>();
  if (!mine || mine.status !== 'ready') {
    return refuse('no_name', `claim your ${CREWAI_NAME} name before joining an organization`, 409);
  }
  const wallet = getAddress(mine.wallet_address);

  const claimed = await env.DB.prepare(
    "UPDATE invites SET status = 'accepted', updated_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ?",
  )
    .bind(now, invite.id, now)
    .run();
  if (!claimed.meta.changes) return refuse('invite_taken', 'this invite was just answered', 409);

  const name = shown.name;
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO members (org_id, user_id, address, role, subname, name_status, created_at) VALUES (?, ?, ?, ?, NULL, 'setting_up', ?)",
      ).bind(org.id, caller.userId, wallet, invite.role, now),
      env.DB.prepare('INSERT INTO audit (org_id, at, actor, action, detail) VALUES (?, ?, ?, ?, ?)').bind(
        org.id,
        now,
        caller.userId,
        'invite_accepted',
        JSON.stringify({ invite: invite.id, name, wallet }),
      ),
    ]);
  } catch {
    /* Became a member some other way in between; give the invite back. */
    await env.DB.prepare("UPDATE invites SET status = 'pending' WHERE id = ?").bind(invite.id).run();
    return refuse('already_member', `you are already a member of ${org.name}`, 409);
  }

  await env.MEMBER_SETUP.getByName(`${org.id}:${caller.userId}`).start({
    orgId: org.id,
    userId: caller.userId,
    label: invite.label,
    name,
    wallet,
    crewRegistry: org.crew_registry as `0x${string}`,
    resolver: org.resolver as `0x${string}`,
    expires: String(Math.floor((org.created_at + MEMBER_NAME_MS) / 1000)),
  });

  return json({ org: present(org), role: invite.role, name }, 202);
};

type UserNameRow = {
  user_id: string;
  label: string;
  name: string;
  wallet_address: string;
  signer_address: string;
  status: string;
  step: string;
  error: string | null;
  registry: string | null;
  resolver: string | null;
  created_at: number;
  updated_at: number;
};

const presentUserName = (row: UserNameRow) => ({
  label: row.label,
  name: row.name,
  wallet: row.wallet_address,
  signer: row.signer_address,
  status: row.status,
  step: row.step,
  error: row.error,
  contracts: row.registry && row.resolver ? { registry: row.registry, resolver: row.resolver } : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * Claims label.crewai.eth for the caller.
 *
 * The name is owned by a wallet the caller has linked to their Privy account,
 * checked against Privy rather than taken on the caller's word — otherwise
 * anyone could have a name issued to somebody else's address. Smart wallets are
 * not accepted: they are linked as a different account type, and the name's
 * owner has to be a key that can sign for it everywhere.
 *
 * The signer is taken as given. It only receives the right to issue agent names
 * under this user's own name, so naming a signer that is not theirs harms
 * nobody but them.
 */
const claimUserName = async (request: Request, env: Env, caller: Caller): Promise<Response> => {
  let body: { label?: unknown; wallet?: unknown; signer?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return refuse('bad_request', 'body must be JSON', 400);
  }
  const label = typeof body.label === 'string' ? body.label.trim().toLowerCase() : '';
  if (!isOrgLabel(label)) {
    return refuse('bad_label', 'a name is 3 to 32 lower-case letters, digits and single hyphens', 400);
  }
  if (typeof body.wallet !== 'string' || !isAddress(body.wallet)) return refuse('bad_wallet', 'wallet must be an address', 400);
  if (typeof body.signer !== 'string' || !isAddress(body.signer)) return refuse('bad_signer', 'signer must be an address', 400);
  const wallet = getAddress(body.wallet);
  const signer = getAddress(body.signer);

  const mine = await env.DB.prepare('SELECT * FROM user_names WHERE user_id = ?').bind(caller.userId).first<UserNameRow>();
  if (mine) return json({ error: { code: 'already_named', detail: `you already have ${mine.name}` }, name: presentUserName(mine) }, 409);

  const taken = await env.DB.prepare('SELECT user_id FROM user_names WHERE label = ?').bind(label).first();
  if (taken || !(await isUserNameFree(clientsFor(env), label))) {
    return refuse('name_taken', `${label}.${CREWAI_NAME} is taken`, 409);
  }

  const user = await privyFor(env).users()._get(caller.userId);
  const linked = user.linked_accounts.some(
    (account) =>
      account.type === 'wallet' &&
      'chain_type' in account &&
      account.chain_type === 'ethereum' &&
      account.address.toLowerCase() === wallet.toLowerCase(),
  );
  if (!linked) return refuse('wallet_not_linked', 'that wallet is not linked to your account', 403);

  const name = `${label}.${CREWAI_NAME}`;
  const now = Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO user_names (user_id, label, name, wallet_address, signer_address, status, step, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'setting_up', 'setup', ?, ?)`,
    )
      .bind(caller.userId, label, name, wallet, signer, now, now)
      .run();
  } catch {
    // Lost a race for the label, or a second claim from the same user.
    return refuse('name_taken', `${name} was just taken`, 409);
  }

  await env.NAME_SETUP.getByName(caller.userId).start({ userId: caller.userId, label, name, wallet, signer });

  const row = await env.DB.prepare('SELECT * FROM user_names WHERE user_id = ?').bind(caller.userId).first<UserNameRow>();
  return json({ name: presentUserName(row!) }, 202);
};

const getMe = async (env: Env, caller: Caller): Promise<Response> => {
  const row = await env.DB.prepare('SELECT * FROM user_names WHERE user_id = ?').bind(caller.userId).first<UserNameRow>();
  if (!row) return json({ name: null });
  const setup = await env.NAME_SETUP.getByName(caller.userId).status();
  return json({ name: presentUserName(row), setup });
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return preflight();
    const url = new URL(request.url);

    try {
      if (url.pathname === '/health') {
        // Presence, never values.
        return json({
          ok: true,
          privy: Boolean(env.PRIVY_APP_ID && env.PRIVY_APP_SECRET),
          manager: env.ENS_MANAGER_PRIVATE_KEY ? managerAddress(env) : null,
        });
      }

      const nameRoute = /^\/v1\/names\/([^/]+)$/.exec(url.pathname);
      if (nameRoute && request.method === 'GET') {
        const label = decodeURIComponent(nameRoute[1]!).toLowerCase();
        if (!isOrgLabel(label)) return refuse('bad_label', 'not a label an organization can take', 400);
        const quote = await quoteName(clientsFor(env), label);
        const ours = await env.DB.prepare('SELECT id FROM orgs WHERE label = ?').bind(label).first();
        return json({ ...quote, available: quote.available && !ours });
      }

      const userNameRoute = /^\/v1\/usernames\/([^/]+)$/.exec(url.pathname);
      if (userNameRoute && request.method === 'GET') {
        const label = decodeURIComponent(userNameRoute[1]!).toLowerCase();
        if (!isOrgLabel(label)) return refuse('bad_label', 'not a name a user can take', 400);
        const ours = await env.DB.prepare('SELECT user_id FROM user_names WHERE label = ?').bind(label).first();
        const free = !ours && (await isUserNameFree(clientsFor(env), label));
        return json({ label, name: `${label}.${CREWAI_NAME}`, available: free });
      }

      if (url.pathname === '/v1/me' || url.pathname === '/v1/me/name') {
        const caller = await authenticate(request, env);
        if (caller instanceof Response) return caller;
        if (url.pathname === '/v1/me' && request.method === 'GET') return getMe(env, caller);
        if (url.pathname === '/v1/me/name' && request.method === 'POST') return claimUserName(request, env, caller);
      }

      const answerRoute = /^\/v1\/me\/invites\/([0-9a-f-]{36})\/(accept|decline)$/.exec(url.pathname);
      if (url.pathname === '/v1/me/invites' || answerRoute) {
        const caller = await authenticate(request, env);
        if (caller instanceof Response) return caller;
        if (url.pathname === '/v1/me/invites' && request.method === 'GET') return myInvites(env, caller);
        if (answerRoute && request.method === 'POST') {
          return answerInvite(env, caller, answerRoute[1]!, answerRoute[2] === 'accept');
        }
      }

      if (url.pathname.startsWith('/v1/orgs')) {
        const caller = await authenticate(request, env);
        if (caller instanceof Response) return caller;

        if (url.pathname === '/v1/orgs' && request.method === 'POST') return createOrg(request, env, caller);
        if (url.pathname === '/v1/orgs' && request.method === 'GET') return listOrgs(env, caller);

        const orgRoute = /^\/v1\/orgs\/([0-9a-f-]{36})$/.exec(url.pathname);
        if (orgRoute && request.method === 'GET') return getOrg(env, caller, orgRoute[1]!);

        const invitesRoute = /^\/v1\/orgs\/([0-9a-f-]{36})\/invites$/.exec(url.pathname);
        if (invitesRoute && request.method === 'POST') return createInvite(request, env, caller, invitesRoute[1]!);
        if (invitesRoute && request.method === 'GET') return listInvites(env, caller, invitesRoute[1]!);

        const revokeRoute = /^\/v1\/orgs\/([0-9a-f-]{36})\/invites\/([0-9a-f-]{36})\/revoke$/.exec(url.pathname);
        if (revokeRoute && request.method === 'POST') return revokeInvite(env, caller, revokeRoute[1]!, revokeRoute[2]!);
      }

      return refuse('not_found', 'no such route', 404);
    } catch (error) {
      /*
        Logged in full, described to the caller not at all. This process holds
        Privy's app secret and a signing key, and an unexpected error's message
        is not the caller's business.
      */
      console.error('crew-backend: unexpected failure', error);
      return refuse('internal', 'something went wrong', 500);
    }
  },
} satisfies ExportedHandler<Env>;
