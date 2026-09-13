/**
 * Setting up one organization's names, step by step, surviving restarts.
 *
 *   contracts  →  fund  →  commit  →  (wait)  →  register  →  crew  →  records  →  ready
 *
 * A Durable Object per organization, driven by alarms. Registration is commit,
 * wait at least `MIN_COMMITMENT_AGE`, then reveal — longer than a request should
 * hold a connection open, and exactly what an alarm is for. Every step is
 * written down before the next one starts, so an object evicted mid-setup
 * resumes where it was rather than paying twice.
 *
 * Each step is idempotent on its own terms: contracts recover their salted
 * addresses, funding checks balances before minting, and `crew` checks whether
 * it is already attached. A step that throws is retried with backoff and, past
 * a limit, the organization is marked failed with the reason — a stuck setup
 * that says why beats one that silently never finishes.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Address, Hash } from 'viem';
import type { RegistrationPlan } from '../../../packages/ens/src/register';
import {
  clientsFor,
  commitOrgName,
  deployOrgContracts,
  fundOrgName,
  managerAddress,
  planOrgName,
  registerCrew,
  registerOrgName,
  writeOrgRecords,
  type OrgContracts,
} from './ens';
import type { Env } from './env';

export type SetupStep = 'contracts' | 'fund' | 'commit' | 'register' | 'crew' | 'records' | 'ready' | 'failed';

type StoredPlan = Omit<RegistrationPlan, 'durationSeconds' | 'priceMinor'> & {
  durationSeconds: string;
  priceMinor: string;
};

type SetupState = {
  orgId: string;
  label: string;
  name: string;
  orgWallet: Address;
  step: SetupStep;
  attempts: number;
  contracts?: OrgContracts;
  plan?: StoredPlan;
  /** Unix ms before which `register` would revert as too early. */
  revealAfter?: number;
  hashes: Record<string, Hash | Hash[] | null>;
  error?: string;
};

const MAX_ATTEMPTS = 6;
const KEY = 'setup';

const storePlan = (plan: RegistrationPlan): StoredPlan => ({
  ...plan,
  durationSeconds: plan.durationSeconds.toString(),
  priceMinor: plan.priceMinor.toString(),
});

const loadPlan = (stored: StoredPlan): RegistrationPlan => ({
  ...stored,
  durationSeconds: BigInt(stored.durationSeconds),
  priceMinor: BigInt(stored.priceMinor),
});

export class OrgSetup extends DurableObject<Env> {
  /** Begins setup. A second call for the same organization changes nothing. */
  async start(input: { orgId: string; label: string; orgWallet: Address }): Promise<SetupStep> {
    const existing = await this.ctx.storage.get<SetupState>(KEY);
    if (existing) return existing.step;

    const state: SetupState = {
      orgId: input.orgId,
      label: input.label,
      name: `${input.label}.eth`,
      orgWallet: input.orgWallet,
      step: 'contracts',
      attempts: 0,
      hashes: {},
    };
    await this.ctx.storage.put(KEY, state);
    await this.ctx.storage.setAlarm(Date.now());
    return state.step;
  }

  async status(): Promise<{
    step: SetupStep;
    error: string | null;
    contracts: OrgContracts | null;
    hashes: SetupState['hashes'];
  } | null> {
    const state = await this.ctx.storage.get<SetupState>(KEY);
    return state
      ? { step: state.step, error: state.error ?? null, contracts: state.contracts ?? null, hashes: state.hashes }
      : null;
  }

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<SetupState>(KEY);
    if (!state || state.step === 'ready' || state.step === 'failed') return;

    try {
      const next = await this.run(state);
      state.step = next.step;
      state.attempts = 0;
      delete state.error;
      await this.ctx.storage.put(KEY, state);
      await this.record(state);
      if (next.step !== 'ready') await this.ctx.storage.setAlarm(next.at ?? Date.now());
    } catch (error) {
      state.attempts += 1;
      state.error = (error as Error).message.split('\n')[0]?.slice(0, 300) ?? 'setup step failed';
      if (state.attempts >= MAX_ATTEMPTS) state.step = 'failed';
      await this.ctx.storage.put(KEY, state);
      await this.record(state);
      if (state.step !== 'failed') {
        await this.ctx.storage.setAlarm(Date.now() + 15_000 * 2 ** (state.attempts - 1));
      }
    }
  }

  /** Runs the current step, returning the next and when to run it. */
  private async run(state: SetupState): Promise<{ step: SetupStep; at?: number }> {
    const clients = clientsFor(this.env);

    switch (state.step) {
      case 'contracts': {
        state.contracts = await deployOrgContracts(clients, {
          name: state.name,
          orgWallet: state.orgWallet,
          manager: managerAddress(this.env),
        });
        return { step: 'fund' };
      }

      case 'fund': {
        const plan = await planOrgName(clients, {
          label: state.label,
          orgWallet: state.orgWallet,
          contracts: state.contracts!,
        });
        const funded = await fundOrgName(clients, plan);
        state.hashes.minted = funded.minted;
        state.hashes.approved = funded.approved;
        // Planned again at commit: the plan carries a fresh secret, and it is the
        // committed one that has to survive until the reveal.
        return { step: 'commit' };
      }

      case 'commit': {
        const plan = await planOrgName(clients, {
          label: state.label,
          orgWallet: state.orgWallet,
          contracts: state.contracts!,
        });
        const committed = await commitOrgName(clients, plan);
        state.plan = storePlan(plan);
        state.hashes.commit = committed.hash;
        /*
          Measured from now rather than from the block, with a margin for the
          difference. Revealing one block too early reverts and burns a retry;
          waiting a little longer costs nothing.
        */
        state.revealAfter = Date.now() + (committed.minAgeSeconds + 20) * 1000;
        return { step: 'register', at: state.revealAfter };
      }

      case 'register': {
        state.hashes.register = await registerOrgName(clients, loadPlan(state.plan!));
        return { step: 'crew' };
      }

      case 'crew': {
        const plan = loadPlan(state.plan!);
        const expiresAt = BigInt(Math.floor(Date.now() / 1000)) + plan.durationSeconds;
        state.hashes.crew = await registerCrew(clients, {
          orgWallet: state.orgWallet,
          contracts: state.contracts!,
          expiresAt,
        });
        return { step: 'records' };
      }

      case 'records': {
        state.hashes.records = await writeOrgRecords(clients, {
          name: state.name,
          orgWallet: state.orgWallet,
          contracts: state.contracts!,
        });
        return { step: 'ready' };
      }

      default:
        return { step: state.step };
    }
  }

  /** Mirrors progress into D1, where the API reads it, and into the audit log. */
  private async record(state: SetupState): Promise<void> {
    const now = Date.now();
    const status = state.step === 'ready' ? 'ready' : state.step === 'failed' ? 'failed' : 'setting_up';
    await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE orgs SET status = ?, step = ?, error = ?, resolver = ?, registry = ?, crew_registry = ?, updated_at = ?
         WHERE id = ?`,
      ).bind(
        status,
        state.step,
        state.error ?? null,
        state.contracts?.resolver ?? null,
        state.contracts?.registry ?? null,
        state.contracts?.crewRegistry ?? null,
        now,
        state.orgId,
      ),
      this.env.DB.prepare('INSERT INTO audit (org_id, at, actor, action, detail) VALUES (?, ?, ?, ?, ?)').bind(
        state.orgId,
        now,
        'backend',
        state.error ? 'setup_retry' : `setup_${state.step}`,
        state.error ?? null,
      ),
    ]);
  }
}
