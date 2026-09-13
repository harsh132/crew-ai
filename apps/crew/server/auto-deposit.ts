/**
 * USDC that lands in the crew's wallet goes into Circle's Gateway by itself.
 *
 * On Arc, agents pay from a Gateway balance, not from the wallet's token
 * balance. Someone who sent USDC to the crew's address — from a faucet, an
 * exchange, a friend — used to see "Almost there" and a deposit button, and the
 * money sat unspendable until they came back to press it. The runtime holds the
 * key and already polls the balance, so it can make the deposit itself.
 *
 * ## What it keeps back
 *
 * Gas on Arc is paid in USDC, the same USDC. Depositing everything would leave
 * the wallet unable to pay for its next transaction — including the next
 * deposit, and any withdrawal. So a small reserve stays in the wallet, and
 * nothing below a minimum is deposited: a deposit of a few cents costs a
 * noticeable share of itself in gas, and topping up dust on every poll is
 * noise on a chain someone is watching.
 *
 * ## When it runs
 *
 * Before every funding refresh, so the read that follows sees the money as
 * spendable in the same tick. One deposit at a time; a failed one waits two
 * minutes before trying again rather than retrying — and paying for — the same
 * failure every poll. `CREW_AUTO_DEPOSIT=off` turns it off, and the page then
 * offers the manual deposit again.
 */
import { formatAmount } from '../../../packages/sdk/src/index';
import { depositToGateway, gatewayFunding, isGatewayNetwork } from '../../../packages/sdk/src/wallet/gateway';
import { readSharedWallet } from '../../../packages/sdk/src/wallet/store';
import { CREW_HOME } from './home';
import { emit } from './events';

const minorFromEnv = (name: string, fallback: bigint): bigint => {
  const value = process.env[name];
  return value && /^\d+$/.test(value) ? BigInt(value) : fallback;
};

const ENABLED = process.env.CREW_AUTO_DEPOSIT !== 'off';
/** 0.05 USDC left in the wallet for gas. */
const RESERVE_MINOR = minorFromEnv('CREW_DEPOSIT_RESERVE_MINOR', 50_000n);
/** 0.10 USDC: the smallest deposit worth its gas. */
const MIN_DEPOSIT_MINOR = minorFromEnv('CREW_DEPOSIT_MIN_MINOR', 100_000n);
const RETRY_AFTER_MS = 120_000;

let inFlight: Promise<bigint | null> | null = null;
let lastFailureAt = 0;

/** Whether a deposit is being sent right now. */
export const isDepositing = (): boolean => inFlight !== null;

/**
 * The wallet balance at which deposits start, or null when auto-deposit does
 * not apply — turned off, or a network that is not paid through Gateway.
 */
export const autoDepositThreshold = (network: string): bigint | null =>
  ENABLED && isGatewayNetwork(network) ? RESERVE_MINOR + MIN_DEPOSIT_MINOR : null;

/** Six-decimal minor units as the decimal string Circle's client takes. */
const decimal = (minor: bigint): string => `${minor / 1_000_000n}.${(minor % 1_000_000n).toString().padStart(6, '0')}`;

/**
 * Deposits what the wallet holds above the reserve, if it is worth depositing.
 *
 * Returns the amount deposited, or null when nothing was. Never throws: a
 * deposit that fails is logged and left for a later poll, because a flaky RPC
 * must not take the funding refresh down with it. `onChange` is called when a
 * deposit starts and when it ends, so the page can say so.
 */
export const autoDeposit = (network: string, onChange?: () => void): Promise<bigint | null> => {
  if (autoDepositThreshold(network) === null) return Promise.resolve(null);
  if (inFlight) return inFlight;
  if (Date.now() - lastFailureAt < RETRY_AFTER_MS) return Promise.resolve(null);

  const stored = readSharedWallet(CREW_HOME);
  if (!stored) return Promise.resolve(null);
  const privateKey = `0x${stored.privateKey}`;

  /*
    Announced only when a deposit actually starts. Most polls find nothing to
    deposit, and calling back for those would rewrite the crew file and push a
    fresh state to every open page every twenty seconds for no change.
  */
  let started = false;
  inFlight = (async (): Promise<bigint | null> => {
    const funding = await gatewayFunding({ privateKey, network, address: stored.address });
    const amount = funding.walletMinor - RESERVE_MINOR;
    if (amount < MIN_DEPOSIT_MINOR) return null;

    started = true;
    onChange?.();
    emit({ type: 'log', text: `depositing ${formatAmount(network, amount)} into Gateway …` });
    const result = await depositToGateway({ privateKey, network, amount: decimal(amount) });
    emit({
      type: 'log',
      text: `deposited ${formatAmount(network, result.amountMinor)} into Gateway (${result.hash.slice(0, 10)}…)`,
    });
    return result.amountMinor;
  })()
    .catch((error: unknown) => {
      lastFailureAt = Date.now();
      emit({ type: 'log', text: `auto-deposit failed, retrying in 2 minutes: ${(error as Error).message.split('\n')[0]}` });
      return null;
    })
    .finally(() => {
      inFlight = null;
      if (started) onChange?.();
    });

  return inFlight;
};
