/**
 * Registers crewai.eth on ENSv2 Sepolia — once.
 *
 *   bun --env-file=.dev.vars register-crewai.ts        (from apps/crew-backend)
 *
 *   crewai.eth                owned by CREWAI_OWNER; the backend may issue names
 *   └─ alex.crewai.eth        issued per user by the backend, owned by their wallet
 *
 * The owner holds every role, admin bits included, so they can revoke the
 * backend at any time. The backend's manager key gets exactly what issuing
 * users' names needs: `REGISTRAR | RENEW | SET_RESOLVER` on the crewai.eth
 * registry, and `SET_ADDR | SET_TEXT` on its resolver. It pays for everything
 * and owns none of it.
 *
 * Safe to re-run: contract deploys recover their salted addresses, and the
 * registration is skipped when crewai.eth already points at this registry.
 */
import { type Address } from 'viem';
import { ENS } from '../../packages/ens/src/deployment';
import { registryAbi } from '../../packages/ens/src/abi';
import { deployRegistry, deployResolver } from '../../packages/ens/src/deploy';
import { setAddress } from '../../packages/ens/src/records';
import { MANAGER_REGISTRY_ROLES, MANAGER_RESOLVER_ROLES } from '../../packages/ens/src/roles';
import { registryOf } from '../../packages/ens/src/session';
import { clientsFor, commitOrgName, fundOrgName, managerAddress, planOrgName, registerOrgName } from './src/ens';
import { CREWAI_LABEL, CREWAI_NAME, CREWAI_OWNER_DEFAULT, ROOT_RESOLVER_VERSION } from './src/names';
import type { Env } from './src/env';

if (!process.env.ENS_MANAGER_PRIVATE_KEY) {
  console.error('\n  ENS_MANAGER_PRIVATE_KEY is not set — run with --env-file=.dev.vars\n');
  process.exit(1);
}

const env = {
  ENS_MANAGER_PRIVATE_KEY: process.env.ENS_MANAGER_PRIVATE_KEY,
  SEPOLIA_RPC: process.env.SEPOLIA_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com',
} as Env;
const owner = (process.env.CREWAI_OWNER ?? CREWAI_OWNER_DEFAULT) as Address;

const clients = clientsFor(env);
const manager = managerAddress(env);
const started = Date.now();
const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;
const step = (message: string) => console.log(`  ..    ${message}`);

let failures = 0;
const check = (condition: boolean, message: string) => {
  if (condition) console.log(`  ok    ${message}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${message}`);
  }
};

console.log(`\n  name      ${CREWAI_NAME}`);
console.log(`  owner     ${owner}`);
console.log(`  manager   ${manager}`);
console.log(`  gas       ${(await clients.public.getBalance({ address: manager })).toString()} wei\n`);

step('deploying the crewai.eth resolver');
const resolver = await deployResolver(clients, {
  owner,
  version: ROOT_RESOLVER_VERSION,
  grants: [{ account: manager, roleBitmap: MANAGER_RESOLVER_ROLES }],
});
console.log(`        ${resolver.address}${resolver.hash ? '' : ' (existing)'}  (${elapsed()})`);

step('deploying the crewai.eth registry');
const registry = await deployRegistry(clients, {
  name: CREWAI_NAME,
  owner,
  version: 1n,
  grants: [{ account: manager, roleBitmap: MANAGER_REGISTRY_ROLES }],
});
console.log(`        ${registry.address}${registry.hash ? '' : ' (existing)'}  (${elapsed()})`);

const contracts = { resolver: resolver.address, registry: registry.address, crewRegistry: registry.address };
const current = await registryOf(clients.public, CREWAI_NAME);

if (current?.toLowerCase() === registry.address.toLowerCase()) {
  step(`${CREWAI_NAME} is already registered and wired to this registry — skipping registration`);
} else {
  step('funding the registration');
  const funded = await fundOrgName(clients, await planOrgName(clients, { label: CREWAI_LABEL, orgWallet: owner, contracts }));
  console.log(`        minted ${funded.minted ?? 'no'}, approved ${funded.approved ?? 'no'}  (${elapsed()})`);

  step('committing');
  const plan = await planOrgName(clients, { label: CREWAI_LABEL, orgWallet: owner, contracts });
  const committed = await commitOrgName(clients, plan);
  console.log(`        commit ${committed.hash}; waiting ${committed.minAgeSeconds + 20}s  (${elapsed()})`);
  await new Promise((resolve) => setTimeout(resolve, (committed.minAgeSeconds + 20) * 1000));

  step('registering');
  console.log(`        register ${await registerOrgName(clients, plan)}  (${elapsed()})`);
}

step(`pointing ${CREWAI_NAME} at its owner`);
console.log(`        ${await setAddress(clients, { resolver: resolver.address, name: CREWAI_NAME, address: owner })}  (${elapsed()})\n`);

/* ------------------------------------------------------------ checks */

const resolved = await clients.public
  .getEnsAddress({ name: CREWAI_NAME, universalResolverAddress: ENS.universalResolver })
  .catch(() => null);
check(resolved?.toLowerCase() === owner.toLowerCase(), `${CREWAI_NAME} resolves to ${owner}`);
check(
  (await registryOf(clients.public, CREWAI_NAME))?.toLowerCase() === registry.address.toLowerCase(),
  `.eth points ${CREWAI_NAME} at its registry`,
);

const someone = '0x000000000000000000000000000000000000bEEF' as Address;
const expires = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60);
try {
  await clients.public.simulateContract({
    address: registry.address,
    abi: registryAbi,
    functionName: 'register',
    args: ['probe', someone, '0x0000000000000000000000000000000000000000', resolver.address, 0n, expires],
    account: clients.wallet.account!,
  });
  check(true, `the manager can issue probe.${CREWAI_NAME}`);
} catch (error) {
  check(false, `the manager can issue probe.${CREWAI_NAME} — ${(error as Error).message.split('\n')[0]}`);
}

console.log(`\n  resolver  ${resolver.address}`);
console.log(`  registry  ${registry.address}`);
console.log(`  took ${elapsed()}`);
console.log(failures === 0 ? '\n  All checks pass.\n' : `\n  ${failures} FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
