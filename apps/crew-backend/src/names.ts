/**
 * Personal names under crewai.eth, as the backend issues them.
 *
 *   crewai.eth                    owned by the Crew AI operator (register-crewai.ts)
 *   └─ alex.crewai.eth            owned by alex's Privy wallet
 *      └─ researcher.alex…        issued by alex's Crew signer, one per agent
 *
 * Each user's name gets its own registry and resolver, both owned by their
 * wallet. Two other accounts are granted narrow roles on them at deploy time,
 * so neither ever needs the wallet to sign:
 *
 *   the Crew signer   issues and revokes agent names beneath the name, and
 *                     writes their records — what `mintAgentName` and
 *                     `revokeAgentName` call, and nothing else
 *   the manager       writes the name's own address record
 *
 * Neither holds an admin bit, so neither can pass a role on, and the wallet can
 * take both away. The backend pays for everything here and owns none of it.
 *
 * Self-contained on purpose: `session.ts` would bring `registryOf` along with
 * the agent-minting code, which a Worker has no use for.
 */
import { encodeFunctionData, type Address, type Hash } from 'viem';
import { BATCH_7702, ENS } from '../../../packages/ens/src/deployment';
import { registryAbi } from '../../../packages/ens/src/abi';
import { sendCalls, type Call } from '../../../packages/ens/src/batch';
import { ALL_ROLES, planRegistry, planResolver } from '../../../packages/ens/src/deploy';
import { dnsEncode, permissionedResolverAbi } from '../../../packages/ens/src/records';
import { MANAGER_RESOLVER_ROLES, REGISTRY_ROLES, RESOLVER_ROLES } from '../../../packages/ens/src/roles';
import type { Clients } from './ens';

export const CREWAI_LABEL = 'crewai';
export const CREWAI_NAME = 'crewai.eth';

/** The operator's address, which owns crewai.eth. Overridable for a fork. */
export const CREWAI_OWNER_DEFAULT = '0x3f870ECEEE0EcE3a54254C1D364230ABd14aa2d3';

/*
  Resolver proxies are salted by owner and version, not by name. A wallet that
  already owns an organization's resolver (version 0) would otherwise collide
  with its personal one and silently get the organization's contract back — with
  the organization's grants.
*/
export const ROOT_RESOLVER_VERSION = 3n;
export const USER_RESOLVER_VERSION = 2n;

/** What a Crew signer may do in its user's registry: agents come and go, nothing more. */
export const SIGNER_REGISTRY_ROLES =
  REGISTRY_ROLES.REGISTRAR | REGISTRY_ROLES.UNREGISTER | REGISTRY_ROLES.RENEW | REGISTRY_ROLES.SET_RESOLVER;

/** What a Crew signer may write on its user's resolver: agents' addresses and text records. */
export const SIGNER_RESOLVER_ROLES = RESOLVER_ROLES.SET_ADDR | RESOLVER_ROLES.SET_TEXT;

/*
  Just under a year. A child name cannot sensibly outlive its parent, and
  crewai.eth was registered for a year from a moment slightly before this one.
*/
const USER_NAME_SECONDS = 360n * 24n * 60n * 60n;

const ZERO = '0x0000000000000000000000000000000000000000';

export type UserContracts = { registry: Address; resolver: Address };

/** crewai.eth's own registry and resolver, read from the chain. */
export const crewaiContracts = async (clients: Clients): Promise<{ registry: Address; resolver: Address }> => {
  const [registry, resolver] = await Promise.all([
    clients.public.readContract({
      address: ENS.ethRegistry,
      abi: registryAbi,
      functionName: 'getSubregistry',
      args: [CREWAI_LABEL],
    }),
    clients.public.readContract({
      address: ENS.ethRegistry,
      abi: registryAbi,
      functionName: 'getResolver',
      args: [CREWAI_LABEL],
    }),
  ]);
  if (registry === ZERO || resolver === ZERO) {
    throw new Error(`${CREWAI_NAME} is not set up yet — run register-crewai.ts`);
  }
  return { registry, resolver };
};

/**
 * Whether label.crewai.eth is free on chain.
 *
 * Every name this backend issues is registered with a registry and a resolver,
 * so a label with neither has never been issued here.
 */
export const isUserNameFree = async (clients: Clients, label: string): Promise<boolean> => {
  const root = await crewaiContracts(clients);
  const [registry, resolver] = await Promise.all([
    clients.public.readContract({ address: root.registry, abi: registryAbi, functionName: 'getSubregistry', args: [label] }),
    clients.public.readContract({ address: root.registry, abi: registryAbi, functionName: 'getResolver', args: [label] }),
  ]);
  return registry === ZERO && resolver === ZERO;
};

/** ENS's coin type for Ethereum addresses. */
const ETH_COIN_TYPE = 60n;

/** Sepolia ETH the manager keeps back to pay for the setup batch itself. */
const MANAGER_GAS_RESERVE_WEI = 2_000_000_000_000_000n;

/**
 * Sets up label.crewai.eth in one transaction.
 *
 *   deploy resolver  →  deploy registry  →  register  →  address record  →  signer gas
 *
 * Five writes that used to be five transactions — five Sepolia blocks, a minute
 * of a person watching a spinner — sent as one EIP-7702 batch from the manager
 * key (see `packages/ens/src/batch.ts`). They are also atomic now, so a name can
 * no longer end up registered and resolving to nothing because the process died
 * between two of them.
 *
 * The batch needs the new contracts' addresses before they exist, which the
 * factory allows: each deploy is simulated first, and the simulation returns
 * the proxy address. Under 7702 the batch's inner calls come from the manager
 * key itself, so the deployer — and therefore the address — is the one that was
 * simulated.
 *
 * Idempotent, like the steps it replaces: a contract already deployed is found
 * rather than redeployed, a name already registered is not registered again,
 * and the signer is topped up only to the target. When batching is refused,
 * `sendCalls` sends the same calls one at a time, in order.
 */
export const setupUserName = async (
  clients: Clients,
  params: {
    label: string;
    name: string;
    wallet: Address;
    signer: Address;
    manager: Address;
    gasWei: bigint;
    onFallback?: (why: string) => void;
  },
): Promise<{
  contracts: UserContracts;
  hashes: Hash[];
  calls: number;
  batched: boolean;
  /** Gas sent to the signer, and how far short of `gasWei` the manager fell. */
  gasSentWei: bigint;
  gasShortWei: bigint;
}> => {
  const root = await crewaiContracts(clients);

  const [resolver, registry] = await Promise.all([
    planResolver(clients, {
      owner: params.wallet,
      version: USER_RESOLVER_VERSION,
      grants: [
        { account: params.signer, roleBitmap: SIGNER_RESOLVER_ROLES },
        { account: params.manager, roleBitmap: MANAGER_RESOLVER_ROLES },
      ],
    }),
    planRegistry(clients, {
      name: params.name,
      owner: params.wallet,
      version: 1n,
      grants: [{ account: params.signer, roleBitmap: SIGNER_REGISTRY_ROLES }],
    }),
  ]);
  const contracts: UserContracts = { registry: registry.address, resolver: resolver.address };

  const calls: Call[] = [];
  if (resolver.call) calls.push(resolver.call);
  if (registry.call) calls.push(registry.call);

  const attached = await clients.public.readContract({
    address: root.registry,
    abi: registryAbi,
    functionName: 'getSubregistry',
    args: [params.label],
  });
  if (attached.toLowerCase() !== contracts.registry.toLowerCase()) {
    calls.push({
      to: root.registry,
      data: encodeFunctionData({
        abi: registryAbi,
        functionName: 'register',
        args: [
          params.label,
          params.wallet,
          contracts.registry,
          contracts.resolver,
          ALL_ROLES,
          BigInt(Math.floor(Date.now() / 1000)) + USER_NAME_SECONDS,
        ],
      }),
    });
  }

  /* Written every time: it is the step whose absence makes a name look broken. */
  calls.push({
    to: contracts.resolver,
    data: encodeFunctionData({
      abi: permissionedResolverAbi,
      functionName: 'setAddress',
      args: [dnsEncode(params.name), ETH_COIN_TYPE, params.wallet.toLowerCase() as `0x${string}`],
    }),
  });

  /*
    The signer's gas, capped at what the manager can spare. The batch is atomic,
    so a top-up the manager cannot afford would take the name down with it —
    and a name without gas is still worth having, since the page asks the
    person for the rest. The manager keeps a reserve to pay for this very batch.
  */
  let gasSentWei = 0n;
  let gasShortWei = 0n;
  if (params.gasWei > 0n) {
    const [signerBalance, managerBalance] = await Promise.all([
      clients.public.getBalance({ address: params.signer }),
      clients.public.getBalance({ address: params.manager }),
    ]);
    const wanted = params.gasWei > signerBalance ? params.gasWei - signerBalance : 0n;
    const affordable = managerBalance > MANAGER_GAS_RESERVE_WEI ? managerBalance - MANAGER_GAS_RESERVE_WEI : 0n;
    gasSentWei = wanted < affordable ? wanted : affordable;
    gasShortWei = wanted - gasSentWei;
    if (gasSentWei > 0n) calls.push({ to: params.signer, data: '0x', value: gasSentWei });
  }

  let fellBack = false;
  const hashes = await sendCalls(clients, calls, {
    batcher: BATCH_7702,
    onFallback: (why) => {
      fellBack = true;
      params.onFallback?.(why);
    },
  });
  /*
    Batched means several calls in one transaction. A single call is sent as a
    plain transaction by `sendCalls`, so one hash alone says nothing either way.
  */
  return { contracts, hashes, calls: calls.length, batched: calls.length > 1 && !fellBack, gasSentWei, gasShortWei };
};
