/**
 * Setting up one user's name, surviving restarts.
 *
 *   setup  →  ready
 *
 * One step, because it is one transaction: `setupUserName` sends the deploys,
 * the registration, the address record and the signer's gas as a single
 * EIP-7702 batch. Still a Durable Object — a Sepolia block is longer than a
 * request should hold open, and a batch that fails is retried with backoff
 * rather than left for nobody to finish. Retrying is safe: every call in the
 * batch is skipped or harmless when it has already happened.
 *
 * Objects started under the old four-step flow resume here too; their stored
 * step names all run the same idempotent setup.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Address, Hash } from 'viem';
import { clientsFor, managerAddress } from './ens';
import { setupUserName, type UserContracts } from './names';
import type { Env } from './env';

export type NameStep = 'setup' | 'ready' | 'failed';

type NameState = {
  userId: string;
  label: string;
  name: string;
  wallet: Address;
  signer: Address;
  /** `contracts | register | records | gas` from objects started before batching. */
  step: NameStep | 'contracts' | 'register' | 'records' | 'gas';
  attempts: number;
  contracts?: UserContracts;
  hashes: Record<string, Hash | Hash[] | null>;
  batched?: boolean;
  error?: string;
};

const MAX_ATTEMPTS = 6;
const KEY = 'setup';
/** 0.01 ETH: well over a dozen agent names, so onboarding need not ask for more. */
const DEFAULT_GAS_WEI = 10_000_000_000_000_000n;

export class NameSetup extends DurableObject<Env> {
  /** Begins setup. A second call for the same user changes nothing. */
  async start(input: { userId: string; label: string; name: string; wallet: Address; signer: Address }): Promise<string> {
    const existing = await this.ctx.storage.get<NameState>(KEY);
    if (existing) return existing.step;

    await this.ctx.storage.put(KEY, { ...input, step: 'setup', attempts: 0, hashes: {} } satisfies NameState);
    await this.ctx.storage.setAlarm(Date.now());
    return 'setup';
  }

  async status(): Promise<{
    step: string;
    error: string | null;
    contracts: UserContracts | null;
    hashes: NameState['hashes'];
    batched: boolean | null;
  } | null> {
    const state = await this.ctx.storage.get<NameState>(KEY);
    return state
      ? {
          step: state.step,
          error: state.error ?? null,
          contracts: state.contracts ?? null,
          hashes: state.hashes,
          batched: state.batched ?? null,
        }
      : null;
  }

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<NameState>(KEY);
    if (!state || state.step === 'ready' || state.step === 'failed') return;

    try {
      const configured = this.env.USER_GAS_WEI;
      const result = await setupUserName(clientsFor(this.env), {
        label: state.label,
        name: state.name,
        wallet: state.wallet,
        signer: state.signer,
        manager: managerAddress(this.env),
        gasWei: configured && /^\d+$/.test(configured) ? BigInt(configured) : DEFAULT_GAS_WEI,
        onFallback: (why) => console.warn(`crew-backend: ${state.name} sent unbatched: ${why}`),
      });
      if (result.gasShortWei > 0n) {
        console.warn(
          `crew-backend: ${state.name}'s signer got ${result.gasSentWei} wei of gas, ${result.gasShortWei} short — top up the manager key`,
        );
      }
      state.contracts = result.contracts;
      state.hashes.setup = result.hashes;
      state.batched = result.batched;
      state.step = 'ready';
      state.attempts = 0;
      delete state.error;
      await this.ctx.storage.put(KEY, state);
      await this.record(state);
    } catch (error) {
      state.attempts += 1;
      state.error = (error as Error).message.split('\n')[0]?.slice(0, 300) ?? 'setup failed';
      if (state.attempts >= MAX_ATTEMPTS) state.step = 'failed';
      await this.ctx.storage.put(KEY, state);
      await this.record(state);
      if (state.step !== 'failed') await this.ctx.storage.setAlarm(Date.now() + 15_000 * 2 ** (state.attempts - 1));
    }
  }

  /** Mirrors progress into D1, where the API reads it. */
  private async record(state: NameState): Promise<void> {
    const status = state.step === 'ready' ? 'ready' : state.step === 'failed' ? 'failed' : 'setting_up';
    await this.env.DB.prepare(
      `UPDATE user_names SET status = ?, step = ?, error = ?, registry = ?, resolver = ?, updated_at = ?
       WHERE user_id = ?`,
    )
      .bind(
        status,
        state.step,
        state.error ?? null,
        state.contracts?.registry ?? null,
        state.contracts?.resolver ?? null,
        Date.now(),
        state.userId,
      )
      .run();
  }
}
