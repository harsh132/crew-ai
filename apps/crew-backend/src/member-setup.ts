/**
 * Issuing one member's name under an organization, surviving restarts.
 *
 *   alex.crew.acme.eth   owned by alex's own wallet, resolving to it
 *
 * One transaction: `register` in the organization's crew registry and the
 * address record on its resolver, sent as an EIP-7702 batch from the manager
 * key, which holds `REGISTRAR` on the crew registry and `SET_ADDR` on the
 * resolver since the organization was set up. The member signs nothing and
 * pays nothing; the name is theirs from the moment it exists.
 *
 * A Durable Object for the same reason as the others: a Sepolia block is longer
 * than a request should hold open, and a failed batch is retried with backoff.
 * Retrying is safe — a name already registered to this wallet is not
 * registered again.
 */
import { DurableObject } from 'cloudflare:workers';
import { encodeFunctionData, keccak256, stringToHex, type Address, type Hash } from 'viem';
import { BATCH_7702 } from '../../../packages/ens/src/deployment';
import { registryAbi } from '../../../packages/ens/src/abi';
import { sendCalls, type Call } from '../../../packages/ens/src/batch';
import { ALL_ROLES } from '../../../packages/ens/src/deploy';
import { dnsEncode, permissionedResolverAbi } from '../../../packages/ens/src/records';
import { clientsFor } from './ens';
import type { Env } from './env';

type MemberState = {
  orgId: string;
  userId: string;
  label: string;
  name: string;
  wallet: Address;
  crewRegistry: Address;
  resolver: Address;
  /** Unix seconds. Kept inside the organization's own crew name's lifetime. */
  expires: string;
  step: 'setup' | 'ready' | 'failed';
  attempts: number;
  hashes: Hash[];
  error?: string;
};

const KEY = 'member';
const MAX_ATTEMPTS = 6;
const ETH_COIN_TYPE = 60n;
const ZERO = '0x0000000000000000000000000000000000000000';

/*
  The id a registry stores a label under. ENSv2 ids carry a version in their low
  32 bits and reads clear it, so the labelhash has to be canonicalised the same
  way before asking who owns it.
*/
const canonicalIdOf = (label: string): bigint => BigInt(keccak256(stringToHex(label))) & ~((1n << 32n) - 1n);

export class MemberNameSetup extends DurableObject<Env> {
  async start(input: Omit<MemberState, 'step' | 'attempts' | 'hashes'>): Promise<string> {
    const existing = await this.ctx.storage.get<MemberState>(KEY);
    if (existing) return existing.step;
    await this.ctx.storage.put(KEY, { ...input, step: 'setup', attempts: 0, hashes: [] } satisfies MemberState);
    await this.ctx.storage.setAlarm(Date.now());
    return 'setup';
  }

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<MemberState>(KEY);
    if (!state || state.step !== 'setup') return;

    try {
      state.hashes = await this.issue(state);
      state.step = 'ready';
      delete state.error;
    } catch (error) {
      state.attempts += 1;
      state.error = (error as Error).message.split('\n')[0]?.slice(0, 300) ?? 'issuing the name failed';
      if (state.attempts >= MAX_ATTEMPTS) state.step = 'failed';
    }

    await this.ctx.storage.put(KEY, state);
    await this.env.DB.prepare('UPDATE members SET subname = ?, name_status = ?, name_error = ? WHERE org_id = ? AND user_id = ?')
      .bind(
        state.step === 'ready' ? state.name : null,
        state.step === 'setup' ? 'setting_up' : state.step,
        state.error ?? null,
        state.orgId,
        state.userId,
      )
      .run();
    if (state.step === 'setup') await this.ctx.storage.setAlarm(Date.now() + 15_000 * 2 ** (state.attempts - 1));
  }

  private async issue(state: MemberState): Promise<Hash[]> {
    const clients = clientsFor(this.env);
    const calls: Call[] = [];

    const owner = await clients.public
      .readContract({ address: state.crewRegistry, abi: registryAbi, functionName: 'ownerOf', args: [canonicalIdOf(state.label)] })
      .catch(() => ZERO);
    if (owner.toLowerCase() !== state.wallet.toLowerCase()) {
      if (owner !== ZERO) throw new Error(`${state.name} is already registered to ${owner}`);
      calls.push({
        to: state.crewRegistry,
        data: encodeFunctionData({
          abi: registryAbi,
          functionName: 'register',
          args: [state.label, state.wallet, ZERO, state.resolver, ALL_ROLES, BigInt(state.expires)],
        }),
      });
    }

    calls.push({
      to: state.resolver,
      data: encodeFunctionData({
        abi: permissionedResolverAbi,
        functionName: 'setAddress',
        args: [dnsEncode(state.name), ETH_COIN_TYPE, state.wallet.toLowerCase() as `0x${string}`],
      }),
    });

    return sendCalls(clients, calls, {
      batcher: BATCH_7702,
      onFallback: (why) => console.warn(`crew-backend: ${state.name} sent unbatched: ${why}`),
    });
  }
}
