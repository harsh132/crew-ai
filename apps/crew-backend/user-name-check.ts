/**
 * A user's name under crewai.eth, set up for real on ENSv2 Sepolia.
 *
 *   bun --env-file=.dev.vars user-name-check.ts        (from apps/crew-backend)
 *
 * Runs `setupUserName` — what the `NameSetup` Durable Object runs — for a
 * throwaway wallet and Crew signer, so the chain half of claiming a name can be
 * proved without a logged-in Privy user. Needs crewai.eth set up first
 * (register-crewai.ts).
 *
 * Checks the speed claim as well as the result:
 *
 *   - setup lands as one EIP-7702 batch, and the manager key is delegated to
 *     the batcher afterwards
 *   - the signer's gas top-up rode inside that batch
 *   - running setup again sends only the address record
 *   - the name resolves to the user's wallet, which owns it
 *   - the Crew signer can issue an agent name beneath it and write its records
 *   - the signer cannot take the user's name or move its registry, and the
 *     manager cannot issue agent names under it
 *
 * Spends Sepolia gas from the manager key, plus a token top-up for the signer.
 */
import type { Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BATCH_7702, ENS } from '../../packages/ens/src/deployment';
import { registryAbi } from '../../packages/ens/src/abi';
import { canonicalIdOf } from '../../packages/ens/src/agent';
import { delegateOf } from '../../packages/ens/src/batch';
import { ALL_ROLES } from '../../packages/ens/src/deploy';
import { dnsEncode, permissionedResolverAbi } from '../../packages/ens/src/records';
import { registryOf } from '../../packages/ens/src/session';
import { clientsFor, managerAddress } from './src/ens';
import { CREWAI_NAME, crewaiContracts, isUserNameFree, setupUserName } from './src/names';
import type { Env } from './src/env';

if (!process.env.ENS_MANAGER_PRIVATE_KEY) {
  console.error('\n  ENS_MANAGER_PRIVATE_KEY is not set — run with --env-file=.dev.vars\n');
  process.exit(1);
}

const env = {
  ENS_MANAGER_PRIVATE_KEY: process.env.ENS_MANAGER_PRIVATE_KEY,
  SEPOLIA_RPC: process.env.SEPOLIA_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com',
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
/* Canonical: ENSv2 ids carry a version in their low bits, and reads keyed by id clear it. */
const idOf = canonicalIdOf;

const clients = clientsFor(env);
const manager = managerAddress(env);
const wallet = privateKeyToAccount(generatePrivateKey()).address;
const signer = privateKeyToAccount(generatePrivateKey()).address;
const label = `check${[...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
const name = `${label}.${CREWAI_NAME}`;
/* A token top-up — enough to prove value moves inside the batch, not enough to cost much. */
const gasWei = 10_000_000_000_000n;

console.log(`\n  name      ${name}`);
console.log(`  wallet    ${wallet}`);
console.log(`  signer    ${signer}`);
console.log(`  manager   ${manager} (delegated to ${(await delegateOf(clients.public, manager)) ?? 'nothing'})\n`);

const root = await crewaiContracts(clients);
check(true, `${CREWAI_NAME} is set up (registry ${root.registry})`);
check(await isUserNameFree(clients, label), `${name} is free`);

const fallbacks: string[] = [];
const onFallback = (reason: string) => fallbacks.push(reason);

step('setting up the name');
const started = Date.now();
const first = await setupUserName(clients, { label, name, wallet, signer, manager, gasWei, onFallback });
const seconds = Math.round((Date.now() - started) / 1000);
console.log(`        ${first.hashes.join(', ')}  (${seconds}s)`);
console.log(`        registry ${first.contracts.registry}`);
console.log(`        resolver ${first.contracts.resolver}`);

check(first.batched && first.hashes.length === 1, `setup landed as one batched transaction${fallbacks[0] ? ` — fell back: ${fallbacks[0]}` : ''}`);
check(
  (await delegateOf(clients.public, manager))?.toLowerCase() === BATCH_7702.toLowerCase(),
  'the manager key is delegated to the batcher',
);
check((await clients.public.getBalance({ address: signer })) >= gasWei, 'the signer received its gas inside the batch');

step('running setup again');
const again = await setupUserName(clients, { label, name, wallet, signer, manager, gasWei, onFallback });
check(
  again.calls === 1 && again.hashes.length === 1 && !again.batched,
  `a second run sends only the address record (${again.calls} call${again.calls === 1 ? '' : 's'})`,
);
check(
  again.contracts.registry === first.contracts.registry && again.contracts.resolver === first.contracts.resolver,
  'a second run finds the same contracts',
);
console.log('');

/* ------------------------------------------------------ what it built */

const resolved = await clients.public
  .getEnsAddress({ name, universalResolverAddress: ENS.universalResolver })
  .catch(() => null);
check(resolved?.toLowerCase() === wallet.toLowerCase(), `${name} resolves to the user's wallet`);
check(
  (await registryOf(clients.public, name))?.toLowerCase() === first.contracts.registry.toLowerCase(),
  `${CREWAI_NAME} points ${label} at the user's registry`,
);
const owner = await clients.public
  .readContract({ address: root.registry, abi: registryAbi, functionName: 'ownerOf', args: [idOf(label)] })
  .catch(() => null);
check(owner?.toLowerCase() === wallet.toLowerCase(), `the user's wallet owns ${name}`);
check(!(await isUserNameFree(clients, label)), `${name} now reads as taken`);

/* ------------------------------------------ what the signer may and may not */

const contracts = first.contracts;
const zero = '0x0000000000000000000000000000000000000000' as Address;
const expires = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60);

const allowed = async (message: string, work: () => Promise<unknown>) => {
  try {
    await work();
    check(true, message);
  } catch (error) {
    check(false, `${message} — ${why(error)}`);
  }
};
const refused = async (message: string, work: () => Promise<unknown>) => {
  try {
    await work();
    check(false, `${message} — it was ALLOWED`);
  } catch {
    check(true, message);
  }
};

await allowed(`the signer can issue researcher.${name}`, () =>
  clients.public.simulateContract({
    address: contracts.registry,
    abi: registryAbi,
    functionName: 'register',
    args: ['researcher', signer, zero, contracts.resolver, ALL_ROLES, expires],
    account: signer,
  }),
);
await allowed(`the signer can write researcher.${name}'s address`, () =>
  clients.public.simulateContract({
    address: contracts.resolver,
    abi: permissionedResolverAbi,
    functionName: 'setAddress',
    args: [dnsEncode(`researcher.${name}`), 60n, signer.toLowerCase() as `0x${string}`],
    account: signer,
  }),
);
await allowed(`the signer can write researcher.${name}'s text records`, () =>
  clients.public.simulateContract({
    address: contracts.resolver,
    abi: permissionedResolverAbi,
    functionName: 'setText',
    args: [dnsEncode(`researcher.${name}`), 'description', 'check'],
    account: signer,
  }),
);
await refused(`the signer cannot repoint ${name}`, () =>
  clients.public.simulateContract({
    address: root.registry,
    abi: registryAbi,
    functionName: 'setResolver',
    args: [idOf(label), signer],
    account: signer,
  }),
);
await refused(`the signer cannot move ${name}'s registry`, () =>
  clients.public.simulateContract({
    address: root.registry,
    abi: registryAbi,
    functionName: 'setSubregistry',
    args: [idOf(label), signer],
    account: signer,
  }),
);
await refused(`the manager cannot issue agent names under ${name}`, () =>
  clients.public.simulateContract({
    address: contracts.registry,
    abi: registryAbi,
    functionName: 'register',
    args: ['intruder', manager, zero, contracts.resolver, ALL_ROLES, expires],
    account: manager,
  }),
);

console.log(`\n  setup took ${seconds}s`);
console.log(failures === 0 ? '\n  All checks pass.\n' : `\n  ${failures} FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
