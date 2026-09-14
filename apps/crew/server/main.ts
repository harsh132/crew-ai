/**
 * The local runtime, and the only thing that holds a key.
 *
 * The browser gets a UI that can ask this process to act; it never sees the
 * wallet, the capabilities, or the ENS signer. That split is not ceremony — a
 * page can be read by anything running on it, and this key signs payments and
 * registry writes. So the key stays in a process the user started, and the
 * page's whole power is the four routes below.
 *
 *   GET  /api/state            what exists right now
 *   GET  /api/events           the same, as it changes
 *   POST /api/agents           hire one
 *   POST /api/agents/:id/task  give it something to do
 *   POST /api/agents/:id/stop  interrupt it
 *   POST /api/agents/:id/fire  revoke it, on chain
 *   POST /api/signer/unlock    derive the key from a wallet signature
 *
 * Until a key exists the runtime is locked: it serves the page and the unlock
 * route and nothing else, because every other route is about money or names
 * that hang off the key.
 *
 * Bound to loopback, for the obvious reason.
 */
import { ARC_TESTNET, formatAmount } from '../../../packages/sdk/src/index';
import {
  addProject,
  agentById,
  boot,
  fire,
  hire,
  refreshFunding,
  deleteAgent,
  removeProject,
  NAME_GAS_ASK_WEI,
  NAME_GAS_LOW_WEI,
  setIdentity,
  update,
  type Runtime,
} from './crew';
import { runTask, stop, isRunning } from './run';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './http';
import { adoptEarlierCrew, CREW_HOME } from './home';
import { emit, subscribe } from './events';
import { autoDepositThreshold, isDepositing } from './auto-deposit';
import { deriveSigner, saveSigner, storedSigner, UNLOCK } from './signer';
import { MODELS } from './model';
import { DEFAULT_PERMISSIONS, PERMISSIONS } from './permissions';
import { FILE_PATH } from './store';
import { pending, settle } from './requests';
import { fundingRouteFor, privyAppId } from './funding';

/*
  Plain Node, not Bun. The runtime ships as the `crew-ai` npm package, and the
  people installing it should not need Bun: serving goes through `node:http`
  (see http.ts) and files through `node:fs`. Bun implements both, so
  `bun server/main.ts` still works for development.
*/
const HERE = dirname(fileURLToPath(import.meta.url));

/*
  The built page. Next to this file's parent in the repo (`apps/crew/dist`), and
  in the npm package too, where the bundled server sits in `server/` beside
  `dist/`.
*/
const UI_DIR = process.env.CREW_UI_DIR ?? join(HERE, '..', 'dist');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

const isFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

const PORT = Number(process.env.CREW_PORT ?? 8800);
const GATE = process.env.CREW_GATE ?? 'https://edgerouter-gate.prakashharsh32.workers.dev';
/*
  Arc by default, which decides more than which chain settles.

  Every amount in the app is USDC; the network decides where it settles and
  how "can this pay" is asked. Arc pays from a Circle Gateway balance
  rather than a token balance, which is why an address here can hold USDC and
  still be unable to buy anything until it is deposited.
*/
const NETWORK = process.env.CREW_NETWORK ?? ARC_TESTNET;
/*
  The deployed crew backend, where names under crewai.eth and organizations
  live. `CREW_BACKEND=http://127.0.0.1:8788` points a runtime at a local
  `wrangler dev` instead.
*/
const CREW_BACKEND = process.env.CREW_BACKEND ?? 'https://crew-backend.prakashharsh32.workers.dev';

/** Wei as ETH, to six decimals — enough to tell 0.00045 from 0.0006. */
const formatEth = (wei: bigint): string => {
  const whole = wei / 10n ** 18n;
  const fraction = (wei % 10n ** 18n).toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} ETH`;
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const stateOf = (runtime: Runtime) => ({
  locked: false as const,
  /*
    Where the key came from. A derived key can be re-made on another computer
    by signing again; a generated one exists only in this file — and the page
    says which, because that is the difference between "nothing to back up"
    and "back this up".
  */
  signer: { derivedFrom },
  gate: runtime.gate,
  network: runtime.wallet.network,
  account: runtime.wallet.account,
  spendableMinor: runtime.wallet.spendableMinor.toString(),
  spendable: formatAmount(runtime.wallet.network, runtime.wallet.spendableMinor),
  /*
    Everything the crew holds, wherever it sits: spendable (Gateway balance and
    tab) plus what is still in the wallet itself. One number for a person
    checking their balance, who does not care which contract it is in.
  */
  total: formatAmount(runtime.wallet.network, runtime.wallet.spendableMinor + (runtime.wallet.heldMinor ?? 0n)),
  ...(runtime.wallet.heldMinor === undefined
    ? {}
    : { held: formatAmount(runtime.wallet.network, runtime.wallet.heldMinor) }),
  /*
    Prepaid at the gate, and already inside `spendable`. Shown separately so a
    top-up reads as money moving rather than money leaving.
  */
  ...(runtime.wallet.tabMinor === undefined
    ? {}
    : { tab: formatAmount(runtime.wallet.network, runtime.wallet.tabMinor) }),
  /*
    What the user has to do before anything can be bought, if anything. The
    page needs the distinction: money missing and money undeposited are one
    transaction apart and share no instructions.
  */
  funded: runtime.wallet.shortfall === undefined,
  /*
    Whether USDC in the wallet is deposited into Gateway without anyone asking,
    and from what balance. Null means the page offers the manual deposit.
  */
  autoDepositFrom: (() => {
    const threshold = autoDepositThreshold(runtime.wallet.network);
    return threshold === null ? null : formatAmount(runtime.wallet.network, threshold);
  })(),
  depositing: isDepositing(),
  /*
    Sepolia ETH for agent names. The page asks for a top-up when it is low,
    because a hire that cannot pay for its name still succeeds — just without
    the name — and nobody would otherwise know why.
  */
  nameGas:
    runtime.naming && runtime.nameGasWei !== null
      ? {
          address: runtime.wallet.account,
          balance: formatEth(runtime.nameGasWei),
          lowBelow: formatEth(NAME_GAS_LOW_WEI),
          ask: formatEth(NAME_GAS_ASK_WEI),
          low: runtime.nameGasWei < NAME_GAS_LOW_WEI,
        }
      : null,
  ...(runtime.wallet.shortfall ? { shortfall: runtime.wallet.shortfall } : {}),
  /*
    How a person funds this from their own wallet, when the chain has a way.
    Null is a real answer — see `fundingRouteFor`.
  */
  funding: fundingRouteFor(runtime.wallet.network, runtime.wallet.account),
  privyAppId: privyAppId(),
  /*
    Where organizations live. A separate service from this runtime and from the
    gate — see apps/crew-backend — so the page talks to it directly, with the
    user's own login, rather than through a process that has no business
    holding their session.
  */
  crewBackend: CREW_BACKEND,
  naming: runtime.naming,
  root: runtime.root,
  identity: runtime.crew.identity ?? null,
  models: MODELS,
  /*
    Sent rather than hard-coded in the page, so the checkboxes are the
    permissions this runtime actually enforces. A UI offering one the server has
    never heard of would grant nothing and say it had.
  */
  permissions: Object.entries(PERMISSIONS).map(([name, about]) => ({
    name,
    ...about,
    default: (DEFAULT_PERMISSIONS as string[]).includes(name),
  })),
  file: FILE_PATH,
  /*
    Live, and never from disk. A pending request belongs to a paused tool call
    inside a running task; there is nothing to restore after a restart, because
    the thing that was waiting is gone.
  */
  requests: pending(),
  /*
    Real paths, and only to the page on loopback. They never reach a capability,
    a log, or the chain — an agent's token carries the opaque id, and the chain
    carries only that it may reach some directory at all.
  */
  projects: runtime.crew.projects ?? [],
  /*
    Crew pays in USDC on EVM chains only. Agents hired on Hedera before that
    stay in the crew file untouched, but they are not shown: nothing here can
    pay for them, and their amounts are in a unit the app no longer renders.
  */
  agents: runtime.crew.agents.filter((agent) => agent.network.startsWith('eip155:')).map((agent) => ({
    ...agent,
    running: isRunning(agent.id),
    /*
      Hired on a different chain than the one this runtime opened. Shown rather
      than hidden — the name was minted, the money was spent, and deleting the
      record would be tidier and less true — but it cannot be given work, since
      nothing here can pay for it.
    */
    offNetwork: agent.network !== runtime.wallet.network,
    grants: agent.grants ?? [],
    /*
      Always populated, even for an agent stored before permissions existed.
      The page would otherwise have to know what the default is to render it,
      and a second definition of the default is how the two come to disagree.
    */
    permissions: agent.permissions ?? DEFAULT_PERMISSIONS,
    budget: formatAmount(agent.network, BigInt(agent.budgetMinor)),
    spent: formatAmount(agent.network, BigInt(agent.spentMinor)),
  })),
});

console.log('\n  crew ai\n');
console.log(`  gate     ${GATE}`);
console.log(`  network  ${NETWORK}`);

/*
  Null while locked. The runtime used to open (or generate) a key before it
  served anything; now a missing key means waiting for the page to supply a
  signature, because a key generated here could never be made again anywhere
  else.
*/
let runtime: Runtime | null = null;
let derivedFrom: string | null = null;

const start = async (): Promise<void> => {
  const started = await boot({ gate: GATE, network: NETWORK });
  derivedFrom = storedSigner()?.derivedFrom ?? null;
  runtime = started;

  console.log(`  wallet   ${started.wallet.account}${derivedFrom ? `  (from ${derivedFrom})` : ''}`);
  console.log(
    started.wallet.shortfall === undefined
      ? `  can spend ${formatAmount(started.wallet.network, started.wallet.spendableMinor)}`
      : started.wallet.shortfall === 'undeposited'
        ? `  holds ${formatAmount(started.wallet.network, started.wallet.heldMinor ?? 0n)}, none of it deposited yet`
        : '  not funded yet — the app will say what to do',
  );
  console.log(
    `  names    ${
      started.root
        ? started.naming
          ? `under ${started.root}`
          : `off — ${started.root} owns no registry`
        : 'none yet — choose a name in the page'
    }`,
  );
};

/*
  Before anything reads the key: a crew kept in its earlier location is copied
  into this one the first time the runtime starts.
*/
const carried = adoptEarlierCrew();
console.log(`  home     ${CREW_HOME}`);
if (carried.length > 0) console.log(`  data     carried over ${carried.join(', ')} from the earlier location`);

if (storedSigner()) {
  try {
    await start();
  } catch (error) {
    console.error(`\n  cannot start: ${(error as Error).message}\n`);
    process.exit(1);
  }
} else {
  console.log('  wallet   locked — sign with your wallet in the page to unlock');
}
console.log(`\n  open http://127.0.0.1:${PORT}\n`);

/** What a locked runtime tells the page: enough to log in and sign, nothing else. */
const lockedState = () => ({
  locked: true as const,
  network: NETWORK,
  privyAppId: privyAppId(),
  crewBackend: CREW_BACKEND,
  /*
    For Privy's chain configuration only. There is no crew address to deposit
    to yet, and the unlock screen offers no deposit.
  */
  funding: fundingRouteFor(NETWORK, '0x0000000000000000000000000000000000000000'),
  unlock: UNLOCK,
});

const currentState = () => (runtime ? stateOf(runtime) : lockedState());

/*
  The pages allowed to unlock: this runtime's own, and Vite's in development.
  Loopback is not a boundary against the other tabs in the same browser, and
  unlocking is the one route where a forged request would matter — another page
  could install a key derived from its own wallet, and the person would then
  fund an address somebody else controls.
*/
const PAGE_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  'http://127.0.0.1:5180',
  'http://localhost:5180',
  /*
    Where the page is actually reached when that differs from PORT — a
    container published on another host port. Comma-separated, exact origins.
  */
  ...(process.env.CREW_PAGE_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
]);
let unlocking = false;

/** Whether anything would be cut off by rebuilding the delegation tree. */
const busy = (): boolean => runtime?.crew.agents.some((agent) => isRunning(agent.id)) ?? false;

/*
  Built assets when they exist, so a demo is one command; in development Vite
  serves the page and proxies the API routes.
*/
const serveUi = async (path: string): Promise<Response> => {
  /*
    Resolved inside UI_DIR and refused if it escapes it — `/../../wallet.json`
    must never be a way to read the crew's key off loopback. Anything not found
    is the page itself, so client-side routes load.
  */
  let relative: string;
  try {
    relative = normalize(decodeURIComponent(path)).replace(/^[\\/]+/, '');
  } catch {
    return new Response('bad path', { status: 400 });
  }
  const requested = join(UI_DIR, relative || 'index.html');
  if (requested !== UI_DIR && !requested.startsWith(UI_DIR + sep)) return new Response('not found', { status: 404 });

  const target = (await isFile(requested)) ? requested : join(UI_DIR, 'index.html');
  if (!(await isFile(target))) {
    return new Response('the UI is not built — run `bun run build` in apps/crew', { status: 404 });
  }
  const body = await readFile(target);
  return new Response(body as unknown as BodyInit, {
    headers: { 'content-type': CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream' },
  });
};

/*
  Polled, because a deposit happens in someone else's wallet and nothing tells
  us about it. Slow on purpose: it is a network call per tick, the answer
  changes rarely, and the case where somebody is actually waiting has its own
  endpoint that does not wait for the timer.
*/
setInterval(() => {
  if (runtime) void refreshFunding(runtime, busy).catch(() => undefined);
}, 20_000);

/* Once now, so USDC already in the wallet is deposited without waiting for the first poll. */
if (runtime) void refreshFunding(runtime, busy).catch(() => undefined);

serve({
  port: PORT,
  /*
    Loopback unless told otherwise. Only a container sets this, and it should
    publish the port on the host's loopback (`-p 127.0.0.1:…`) so the key's
    runtime is still unreachable from the network.
  */
  hostname: process.env.CREW_HOST ?? '127.0.0.1',
  async fetch(request: Request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/state') return json(currentState());

    /*
      One stream, opened once, carrying every change. The roster is pushed on
      connect so a browser that arrives mid-task sees the current state rather
      than an empty page waiting for the next event.
    */
    if (path === '/api/events') {
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          const send = (event: unknown) =>
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          send({ type: 'state', state: currentState() });
          const unsubscribe = subscribe((event) => {
            send(
              event.type === 'crew' || event.type === 'requests'
                ? { type: 'state', state: currentState() }
                : event,
            );
          });
          request.signal.addEventListener('abort', () => {
            unsubscribe();
            try {
              controller.close();
            } catch {
              // Already closed by the client going away.
            }
          });
        },
      });
      return new Response(body, {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
      });
    }

    /*
      Unlocking: two signatures in, a key derived, the runtime started. The
      signatures are used and dropped — only the derived key is kept, in the
      same file a generated key always lived in.
    */
    if (request.method === 'POST' && path === '/api/signer/unlock') {
      const origin = request.headers.get('origin');
      if (!origin || !PAGE_ORIGINS.has(origin)) {
        return json({ error: 'unlocking is only accepted from the Crew page' }, 403);
      }
      if (runtime) return json({ error: 'this crew is already unlocked' }, 409);
      if (unlocking) return json({ error: 'already unlocking' }, 409);

      unlocking = true;
      try {
        const body = (await request.json().catch(() => ({}))) as { account?: unknown; signatures?: unknown };
        const signer = await deriveSigner(
          typeof body.account === 'string' ? body.account : '',
          Array.isArray(body.signatures)
            ? body.signatures.filter((signature): signature is string => typeof signature === 'string')
            : [],
        );
        saveSigner(signer);
        await start();
        emit({ type: 'crew', agents: [] });
        if (runtime) void refreshFunding(runtime, busy).catch(() => undefined);
        return json({ address: signer.address });
      } catch (error) {
        return json({ error: (error as Error).message }, 400);
      } finally {
        unlocking = false;
      }
    }

    if (!runtime) {
      return path.startsWith('/api/')
        ? json({ error: 'this crew is locked — sign with your wallet in the page to unlock it' }, 423)
        : serveUi(path);
    }

    if (request.method === 'POST' && path === '/api/agents') {
      const body = (await request.json()) as {
        label: string;
        title?: string;
        brief: string;
        budgetMinor: string;
        model: string;
        avatar?: string;
        header?: string;
        permissions?: string[];
        grants?: { projectId: string; mode: 'read' | 'write' }[];
      };
      try {
        const agent = await hire(runtime, {
          label: body.label,
          brief: body.brief,
          ...(body.title ? { title: body.title } : {}),
          ...(body.permissions ? { permissions: body.permissions } : {}),
          ...(body.grants ? { grants: body.grants } : {}),
          budgetMinor: BigInt(body.budgetMinor),
          model: body.model,
          ...(body.avatar ? { avatar: body.avatar } : {}),
          ...(body.header ? { header: body.header } : {}),
        });
        return json({ agent: agent.id });
      } catch (error) {
        return json({ error: (error as Error).message }, 400);
      }
    }

    /*
      Answering an agent's request for more budget. Approval carries an amount
      rather than a yes, because a person who reads "needs 2 USDC to finish" and
      thinks "a tenth of that" should be able to say so — and because a granted
      amount somebody typed is a limit they set rather than one they waved
      through.
    */
    /*
      Granting a directory. Separate from granting it to an agent, because
      revoking the first has to take every hold on it with it, and that is only
      simple while the path lives in one place.
    */
    /*
      Look at the chain now rather than at the next poll. Somebody who has just
      confirmed a deposit in their wallet is watching this page waiting for it
      to notice, and twenty seconds of nothing reads as a failure.
    */
    if (request.method === 'POST' && path === '/api/funding/refresh') {
      const changed = await refreshFunding(runtime, busy);
      return json({ changed, funded: runtime.wallet.shortfall === undefined });
    }

    /*
      Adopting the person's name under crewai.eth as the parent of agent names.
      The page learns the name from the crew backend; the runtime believes it
      only after checking the chain (see `setIdentity`).
    */
    if (request.method === 'POST' && path === '/api/identity') {
      const body = (await request.json().catch(() => ({}))) as { name?: unknown };
      const name = typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
      if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.crewai\.eth$/.test(name)) {
        return json({ error: 'that is not a name under crewai.eth' }, 400);
      }
      try {
        await setIdentity(runtime, name, derivedFrom);
        return json({ identity: runtime.crew.identity });
      } catch (error) {
        return json({ error: (error as Error).message }, 400);
      }
    }

    if (request.method === 'POST' && path === '/api/projects') {
      const body = (await request.json()) as { name?: string; path?: string; mode?: 'read' | 'write' };
      if (!body.path?.trim()) return json({ error: 'which directory?' }, 400);
      try {
        const project = addProject(runtime, {
          name: body.name ?? '',
          path: body.path,
          mode: body.mode === 'write' ? 'write' : 'read',
        });
        return json({ project });
      } catch (error) {
        return json({ error: (error as Error).message }, 400);
      }
    }

    const removing = /^\/api\/projects\/([^/]+)$/.exec(path);
    if (request.method === 'DELETE' && removing) {
      await removeProject(runtime, removing[1]!);
      return json({ removed: true });
    }

    const answering = /^\/api\/requests\/([^/]+)\/(approve|decline)$/.exec(path);
    if (request.method === 'POST' && answering) {
      const [, id, verdict] = answering as unknown as [string, string, string];

      if (verdict === 'decline') {
        return json({ answered: settle(id, { approved: false, why: 'the request was declined' }) });
      }

      const body = (await request.json().catch(() => ({}))) as { grantedMinor?: string };
      let grantedMinor: bigint;
      try {
        grantedMinor = BigInt(body.grantedMinor ?? '0');
      } catch {
        return json({ error: 'that is not an amount' }, 400);
      }
      if (grantedMinor <= 0n) return json({ error: 'grant more than nothing, or decline' }, 400);

      return json({ answered: settle(id, { approved: true, grantedMinor }) });
    }

    const match = /^\/api\/agents\/([^/]+)\/(task|stop|fire|edit|remove)$/.exec(path);
    if (request.method === 'POST' && match) {
      const [, id, action] = match as unknown as [string, string, string];
      try {
        const agent = agentById(runtime, id);

        if (action === 'stop') return json({ stopped: stop(id) });
        if (action === 'edit') {
          const changes = (await request.json()) as {
            title?: string;
            brief?: string;
            model?: string;
            budgetMinor?: string;
            avatar?: string;
            header?: string;
            permissions?: string[];
            grants?: { projectId: string; mode: 'read' | 'write' }[];
          };
          await update(runtime, id, {
            ...(changes.title === undefined ? {} : { title: changes.title }),
            ...(changes.brief === undefined ? {} : { brief: changes.brief }),
            ...(changes.model === undefined ? {} : { model: changes.model }),
            ...(changes.budgetMinor === undefined ? {} : { budgetMinor: BigInt(changes.budgetMinor) }),
            ...(changes.avatar === undefined ? {} : { avatar: changes.avatar }),
            ...(changes.header === undefined ? {} : { header: changes.header }),
            ...(changes.permissions === undefined ? {} : { permissions: changes.permissions }),
            ...(changes.grants === undefined ? {} : { grants: changes.grants }),
          });
          return json({ updated: true });
        }
        if (action === 'fire') {
          await fire(runtime, id);
          return json({ fired: true });
        }
        if (action === 'remove') {
          await deleteAgent(runtime, agent.id, isRunning);
          return json({ removed: true });
        }

        const { prompt } = (await request.json()) as { prompt: string };
        if (!prompt?.trim()) return json({ error: 'a task needs a prompt' }, 400);
        /*
          Not awaited. A task runs for as long as its budget lasts, and the
          browser wants the roster back immediately — everything it needs to
          watch arrives on the event stream.
        */
        void runTask(runtime, agent, prompt).catch(() => {
          // runTask records its own failures on the task; nothing to add here.
        });
        return json({ started: true });
      } catch (error) {
        return json({ error: (error as Error).message }, 400);
      }
    }

    /* Everything else is the UI. */
    return serveUi(path);
  },
}).catch((error: Error) => {
  console.error(`\n  cannot serve on 127.0.0.1:${PORT}: ${error.message}`);
  console.error('  set CREW_PORT to use another port\n');
  process.exit(1);
});
