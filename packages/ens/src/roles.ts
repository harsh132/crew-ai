/**
 * ENSv2 roles, by name.
 *
 * Values are taken from `RegistryRolesLib` and `PermissionedResolverLib` in
 * ensdomains/contracts-v2. Every role sits in its own nybble — the reason
 * `ALL_ROLES` in `deploy.ts` is `0x1111…` rather than all ones — and each has an
 * admin counterpart 128 bits higher, which is what lets its holder grant it on.
 *
 * Named here so a grant reads as what it permits. A bitmap of `0x1000011` in a
 * deployment call is a fact nobody will check; `REGISTRAR | RENEW | SET_RESOLVER`
 * is a decision somebody can disagree with.
 */
import type { Address } from 'viem';

export const REGISTRY_ROLES = {
  /** Register new names in the registry. Root-level only. */
  REGISTRAR: 0x1n,
  REGISTER_RESERVED: 0x10n,
  SET_PARENT: 0x100n,
  UNREGISTER: 0x1000n,
  RENEW: 0x10000n,
  SET_SUBREGISTRY: 0x100000n,
  SET_RESOLVER: 0x1000000n,
  SET_URI: 0x1000000000n,
} as const;

export const RESOLVER_ROLES = {
  SET_ADDR: 0x1n,
  SET_TEXT: 0x10n,
  SET_CONTENTHASH: 0x100n,
  SET_PUBKEY: 0x1000n,
  SET_ABI: 0x10000n,
  SET_INTERFACE: 0x100000n,
  SET_NAME: 0x1000000n,
  CLEAR: 0x100000000n,
  SET_DATA: 0x1000000000n,
} as const;

/**
 * What a manager may do in an organization's member registry.
 *
 * Issue a member's name, keep it current, and point it at a resolver. Not
 * unregister, not move subregistries, and no admin bits — a manager cannot hand
 * these roles to anyone else, and cannot take a name away. Removing someone is
 * a record change and a budget change, not a deletion; deleting names is the
 * owners' call.
 */
export const MANAGER_REGISTRY_ROLES =
  REGISTRY_ROLES.REGISTRAR | REGISTRY_ROLES.RENEW | REGISTRY_ROLES.SET_RESOLVER;

/**
 * What a manager may write on an organization's resolver.
 *
 * Addresses and text records — which is where a member's address, role and
 * permissions live. Not contenthash, not reverse names, and not `CLEAR`, which
 * would let one call wipe a member's whole record.
 */
export const MANAGER_RESOLVER_ROLES = RESOLVER_ROLES.SET_ADDR | RESOLVER_ROLES.SET_TEXT;

/** One account and the roles it holds, as a registry or resolver initialiser takes it. */
export type Grant = { account: Address; roleBitmap: bigint };
