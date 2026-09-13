/**
 * An organization's names, set up for real on ENSv2 Sepolia.
 *
 *   bun --env-file=.dev.vars org-setup-check.ts        (from apps/crew-backend)
 *
 * Runs the same steps the `OrgSetup` Durable Object runs, in order, without the
 * Worker around them — so the chain half of creating an organization can be
 * proved without a logged-in Privy user. The HTTP route adds authentication and
 * a database row on top of exactly this.
 *
 * Then checks what matters about the result, not just that transactions landed:
 *
 *   - the names resolve to the organization's wallet
 *   - the registries are wired the way resolution walks them
 *   - the manager can issue a member's name
 *   - the manager cannot take the organization's name, move its registries, or
 *     delete names — the owners' powers stay the owners'
 *
 * Spends Sepolia gas from the manager key and mock USDC it mints for itself.
 * Registers a throwaway `crewcheck…` label, owned by a Privy wallet whose
 * authorization key exists only in this process.
 */
import { PrivyClient, generateP256KeyPair } from '@privy-io/node';
import { keccak256, stringToHex, type Address } from 'viem';
import { ENS } from '../../packages/ens/src/deployment';
import { registryAbi } from '../../packages/ens/src/abi';
import { ALL_ROLES } from '../../packages/ens/src/deploy';
import {
  clientsFor,
  commitOrgName,
  deployOrgContracts,
  fundOrgName,
  isOrgLabel,
  managerAddress,
  planOrgName,
  quoteName,
  registerCrew,
  registerOrgName,
  writeOrgRecords,
} from './src/ens';
import type { Env } from './src/env';

for (const variable of ['PRIVY_APP_ID', 'PRIVY_APP_SECRET', 'ENS_MANAGER_PRIVATE_KEY'] as const) {
  if (!process.env[variable]) {
    console.error(`\n  ${variable} is not set — run with --env-file=.dev.vars\n`);
    process.exit(1);
  }
}

const env = {
  PRIVY_APP_ID: process.env.PRIVY_APP_ID!,
  PRIVY_APP_SECRET: process.env.PRIVY_APP_SECRET!,
  ENS_MANAGER_PRIVATE_KEY: process.env.ENS_MANAGER_PRIVATE_KEY!,
  SEPOLIA_RPC: 'https://ethereum-sepolia-rpc.publicnode.com',
} as Env;

let failures = 0;
const check = (condition: boolean, message: string) => {
  if (condition) console.log(`  ok    ${message}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${message}`);
  }
};
const step = (message: string) => console.log(`  ..    ${message}`);
const why = (error: unknown) => ((error as Error).message ?? String(error)).split('\n')[0]!.slice(0, 160);

const clients = clientsFor(env);
const manager = managerAddress(env);
const label = `crewcheck${[...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
const name = `${label}.eth`;
const idOf = (text: string) => BigInt(keccak256(stringToHex(text)));

console.log(`\n  name      ${name}`);
console.log(`  manager   ${manager}\n`);

check(isOrgLabel(label), 'the label passes the organization label rule');
check(!isOrgLabel('Acme'), 'upper-case labels are refused');
check(!isOrgLabel('ab'), 'labels under three characters are refused');
check(!isOrgLabel('-acme'), 'labels starting with a hyphen are refused');
check(!isOrgLabel('ac--me'), 'double hyphens are refused');

const quote = await quoteName(clients, label);
check(quote.available, `${name} is available (${quote.priceMinor} minor units of USDC)`);

/* ----------------------------------------------------- the org wallet */

const privy = new PrivyClient({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET });
const ownerKey = await generateP256KeyPair();
const quorum = await privy.keyQuorums().create({
  public_keys: [ownerKey.publicKey],
  authorization_threshold: 1,
  display_name: `${name} owners`,
});
const wallet = await privy.wallets().create({ chain_type: 'ethereum', owner_id: quorum.id });
const orgWallet = wallet.address as Address;
console.log(`\n  org wallet ${orgWallet} (quorum ${quorum.id})\n`);

/* ------------------------------------------------------------ setup */

const started = Date.now();
const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;

step('deploying resolver, org registry and crew registry');
const contracts = await deployOrgContracts(clients, { name, orgWallet, manager });
console.log(`        resolver      ${contracts.resolver}`);
console.log(`        registry      ${contracts.registry}`);
console.log(`        crew registry ${contracts.crewRegistry}  (${elapsed()})`);

step('funding the registration');
const funded = await fundOrgName(clients, await planOrgName(clients, { label, orgWallet, contracts }));
console.log(`        minted ${funded.minted ?? 'no'}, approved ${funded.approved ?? 'no'}  (${elapsed()})`);

step('committing');
const plan = await planOrgName(clients, { label, orgWallet, contracts });
const committed = await commitOrgName(clients, plan);
console.log(`        commit ${committed.hash}; waiting ${committed.minAgeSeconds + 20}s  (${elapsed()})`);
await new Promise((resolve) => setTimeout(resolve, (committed.minAgeSeconds + 20) * 1000));

step('registering');
const registered = await registerOrgName(clients, plan);
console.log(`        register ${registered}  (${elapsed()})`);

step('registering crew');
const crew = await registerCrew(clients, {
  orgWallet,
  contracts,
  expiresAt: BigInt(Math.floor(Date.now() / 1000)) + plan.durationSeconds,
});
console.log(`        crew ${crew}  (${elapsed()})`);

step('writing address records');
const records = await writeOrgRecords(clients, { name, orgWallet, contracts });
console.log(`        records ${records.join(', ')}  (${elapsed()})\n`);

/* ------------------------------------------------------ what it built */

const resolveAddress = (target: string) =>
  clients.public.getEnsAddress({ name: target, universalResolverAddress: ENS.universalResolver }).catch(() => null);

check((await resolveAddress(name))?.toLowerCase() === orgWallet.toLowerCase(), `${name} resolves to the org wallet`);
check(
  (await resolveAddress(`crew.${name}`))?.toLowerCase() === orgWallet.toLowerCase(),
  `crew.${name} resolves to the org wallet`,
);

const subregistryOf = (registry: Address, child: string) =>
  clients.public.readContract({ address: registry, abi: registryAbi, functionName: 'getSubregistry', args: [child] });

check(
  (await subregistryOf(ENS.ethRegistry, label)).toLowerCase() === contracts.registry.toLowerCase(),
  `.eth points ${name} at its own registry`,
);
check(
  (await subregistryOf(contracts.registry, 'crew')).toLowerCase() === contracts.crewRegistry.toLowerCase(),
  `${name} points crew at the crew registry`,
);

/* ------------------------------------------------ the manager's limits */

const account = clients.wallet.account!;
const simulate = (address: Address, functionName: 'register' | 'unregister' | 'setSubregistry' | 'setResolver', args: readonly unknown[]) =>
  clients.public.simulateContract({ address, abi: registryAbi, functionName, args: args as never, account });

const expires = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60);
const someone = '0x000000000000000000000000000000000000bEEF' as Address;

try {
  await simulate(contracts.crewRegistry, 'register', ['alex', someone, '0x0000000000000000000000000000000000000000', contracts.resolver, ALL_ROLES, expires]);
  check(true, `the manager can issue alex.crew.${name}`);
} catch (error) {
  check(false, `the manager can issue alex.crew.${name} — ${why(error)}`);
}

const refused = async (label: string, work: () => Promise<unknown>) => {
  try {
    await work();
    check(false, `${label} — it was ALLOWED`);
  } catch {
    check(true, label);
  }
};

await refused(`the manager cannot repoint ${name} at another resolver`, () =>
  simulate(ENS.ethRegistry, 'setResolver', [idOf(label), someone]),
);
await refused(`the manager cannot move ${name}'s registry`, () =>
  simulate(ENS.ethRegistry, 'setSubregistry', [idOf(label), someone]),
);
await refused('the manager cannot move the crew registry', () =>
  simulate(contracts.registry, 'setSubregistry', [idOf('crew'), someone]),
);
await refused('the manager cannot delete crew', () => simulate(contracts.registry, 'unregister', [idOf('crew')]));

console.log(`\n  took ${elapsed()}`);
console.log(failures === 0 ? '\n  All checks pass.\n' : `\n  ${failures} FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
