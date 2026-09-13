/**
 * An organization's names, as the backend sets them up.
 *
 *   label.eth              owned by the org wallet, paid for by the backend
 *   └─ crew.label.eth      owned by the org wallet; members are issued here
 *      └─ alex.crew.label.eth
 *
 * The backend sends every transaction and owns none of the names. Ownership is
 * given at registration — the registrar takes the owner, the subregistry and the
 * resolver as arguments — so the org wallet never has to sign a follow-up to
 * receive what was made for it.
 *
 * The backend's lasting power is the manager role: `REGISTRAR` in the crew
 * registry, so it can issue members' names, and `SET_ADDR | SET_TEXT` on the
 * resolver, so it can write their records. It holds no admin bit and cannot
 * pass either on.
 *
 * Imported file by file rather than through the package index, which also
 * brings in the local wallet store — a filesystem reader with no business in a
 * Worker.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { ENS } from '../../../packages/ens/src/deployment';
import { ethRegistrarAbi, registryAbi } from '../../../packages/ens/src/abi';
import { setAddress } from '../../../packages/ens/src/records';
import { ALL_ROLES, deployRegistry, deployResolver } from '../../../packages/ens/src/deploy';
import {
  commit,
  ensureFunds,
  planRegistration,
  register,
  YEAR_SECONDS,
  type RegistrationPlan,
} from '../../../packages/ens/src/register';
import { ensName } from '../../../packages/ens/src/client';
import { MANAGER_REGISTRY_ROLES, MANAGER_RESOLVER_ROLES } from '../../../packages/ens/src/roles';
import type { Env } from './env';

export type Clients = { public: PublicClient; wallet: WalletClient };

export const clientsFor = (env: Env): Clients => {
  const account = privateKeyToAccount(env.ENS_MANAGER_PRIVATE_KEY as `0x${string}`);
  const transport = http(env.SEPOLIA_RPC);
  return {
    public: createPublicClient({ chain: sepolia, transport }) as PublicClient,
    wallet: createWalletClient({ account, chain: sepolia, transport }),
  };
};

export const managerAddress = (env: Env): Address =>
  privateKeyToAccount(env.ENS_MANAGER_PRIVATE_KEY as `0x${string}`).address;

/**
 * Labels an organization may take.
 *
 * Stricter than ENS: lower-case letters, digits and single hyphens, three to
 * thirty-two characters. The name becomes part of every member's address and
 * every agent's, so the rule is written for people reading it rather than for
 * what the normaliser would accept.
 */
export const isOrgLabel = (label: string): boolean =>
  /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,31}$/.test(label) && ensName(label) === label;

export type NameQuote = {
  label: string;
  name: string;
  available: boolean;
  /** Registration for a year, in the payment token's smallest unit. Null when unavailable. */
  priceMinor: string | null;
};

export const quoteName = async (clients: Clients, label: string): Promise<NameQuote> => {
  const available = await clients.public.readContract({
    address: ENS.ethRegistrar,
    abi: ethRegistrarAbi,
    functionName: 'isAvailable',
    args: [label],
  });
  if (!available) return { label, name: `${label}.eth`, available, priceMinor: null };

  const [base, premium] = await clients.public.readContract({
    address: ENS.ethRegistrar,
    abi: ethRegistrarAbi,
    functionName: 'getRegisterPrice',
    args: [label, YEAR_SECONDS, ENS.usdc],
  });
  return { label, name: `${label}.eth`, available, priceMinor: (base + premium).toString() };
};

export type OrgContracts = { resolver: Address; registry: Address; crewRegistry: Address };

/**
 * Deploys the resolver and both registries, with the org wallet as owner.
 *
 * Idempotent: every proxy is salted by what it is for, and a deploy that finds
 * its salt taken recovers the existing address. A setup that is retried after a
 * crash picks up the same contracts rather than stranding a second set.
 */
export const deployOrgContracts = async (
  clients: Clients,
  params: { name: string; orgWallet: Address; manager: Address },
): Promise<OrgContracts> => {
  const resolver = await deployResolver(clients, {
    owner: params.orgWallet,
    grants: [{ account: params.manager, roleBitmap: MANAGER_RESOLVER_ROLES }],
  });

  /*
    The organization's own registry. The manager is granted REGISTRAR here only
    long enough to matter once — to register `crew` during setup. Revoking it
    afterwards needs the admin bit, which only the org wallet holds, so it is an
    owners' action; until then the backend could issue names directly under the
    org, which is recorded as a follow-up rather than hidden.
  */
  const registry = await deployRegistry(clients, {
    name: params.name,
    owner: params.orgWallet,
    version: 1n,
    grants: [{ account: params.manager, roleBitmap: MANAGER_REGISTRY_ROLES }],
  });

  const crewRegistry = await deployRegistry(clients, {
    name: `crew.${params.name}`,
    owner: params.orgWallet,
    version: 1n,
    grants: [{ account: params.manager, roleBitmap: MANAGER_REGISTRY_ROLES }],
  });

  return { resolver: resolver.address, registry: registry.address, crewRegistry: crewRegistry.address };
};

export const planOrgName = (
  clients: Clients,
  params: { label: string; orgWallet: Address; contracts: OrgContracts },
): Promise<RegistrationPlan> =>
  planRegistration(clients.public, {
    label: params.label,
    owner: params.orgWallet,
    resolver: params.contracts.resolver,
    subregistry: params.contracts.registry,
  });

export const fundOrgName = (clients: Clients, plan: RegistrationPlan) => ensureFunds(clients, plan);

export const commitOrgName = async (clients: Clients, plan: RegistrationPlan) => {
  const committed = await commit(clients, plan);
  await clients.public.waitForTransactionReceipt({ hash: committed.hash });
  return committed;
};

export const registerOrgName = async (clients: Clients, plan: RegistrationPlan): Promise<Hash> => {
  const { hash } = await register(clients, plan);
  const receipt = await clients.public.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`register reverted (${hash})`);
  return hash;
};

/**
 * Registers `crew` inside the organization's registry.
 *
 * Owned by the org wallet with every role, pointed at the crew registry where
 * members are issued, and resolved through the organization's resolver. It
 * lives as long as the organization's own name.
 */
export const registerCrew = async (
  clients: Clients,
  params: { orgWallet: Address; contracts: OrgContracts; expiresAt: bigint },
): Promise<Hash | null> => {
  const account = clients.wallet.account!;
  const existing = await clients.public.readContract({
    address: params.contracts.registry,
    abi: registryAbi,
    functionName: 'getSubregistry',
    args: ['crew'],
  });
  if (existing.toLowerCase() === params.contracts.crewRegistry.toLowerCase()) return null;

  const hash = await clients.wallet.writeContract({
    address: params.contracts.registry,
    abi: registryAbi,
    functionName: 'register',
    args: ['crew', params.orgWallet, params.contracts.crewRegistry, params.contracts.resolver, ALL_ROLES, params.expiresAt],
    account,
    chain: clients.wallet.chain!,
  });
  const receipt = await clients.public.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`registering crew reverted (${hash})`);
  return hash;
};

/**
 * Points the organization's names at its wallet.
 *
 * Written by the manager, which holds `SET_ADDR` on the resolver. Until this
 * lands the names exist and resolve to nothing, which reads as a broken setup
 * to anyone who looks them up.
 */
export const writeOrgRecords = async (
  clients: Clients,
  params: { name: string; orgWallet: Address; contracts: OrgContracts },
): Promise<Hash[]> => {
  const hashes: Hash[] = [];
  /*
    Through `setAddress`, which takes the name DNS-encoded. The permissioned
    resolver on this deployment has no `setAddr(bytes32,address)` — a call to it
    reverts for every account, owner included, with no reason given, which reads
    exactly like a missing role. Confirmed against the deployed resolver: the
    manager held `SET_ADDR` at root and the node-hash call still reverted.
  */
  for (const name of [params.name, `crew.${params.name}`]) {
    hashes.push(
      await setAddress(clients, { resolver: params.contracts.resolver, name, address: params.orgWallet }),
    );
  }
  return hashes;
};
