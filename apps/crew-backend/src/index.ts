/**
 * The crew backend: organizations for Crew AI.
 *
 *   GET  /health
 *   GET  /v1/names/:label     is label.eth free, and what it costs
 *   POST /v1/orgs             create an organization { label }
 *   GET  /v1/orgs             the organizations you belong to
 *   GET  /v1/orgs/:id         one of them, with its members and setup progress
 *
 * Every route but the first two needs a Privy access token as a bearer token.
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
import { clientsFor, isOrgLabel, managerAddress, quoteName } from './ens';
import type { Env } from './env';

export { OrgSetup } from './setup';

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
    'SELECT user_id, address, role, subname, created_at FROM members WHERE org_id = ? ORDER BY created_at',
  )
    .bind(id)
    .all();

  const setup = await env.ORG_SETUP.getByName(id).status();
  return json({ org: present(org), role: membership.role, members, setup });
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

      if (url.pathname.startsWith('/v1/orgs')) {
        const caller = await authenticate(request, env);
        if (caller instanceof Response) return caller;

        if (url.pathname === '/v1/orgs' && request.method === 'POST') return createOrg(request, env, caller);
        if (url.pathname === '/v1/orgs' && request.method === 'GET') return listOrgs(env, caller);

        const orgRoute = /^\/v1\/orgs\/([0-9a-f-]{36})$/.exec(url.pathname);
        if (orgRoute && request.method === 'GET') return getOrg(env, caller, orgRoute[1]!);
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
