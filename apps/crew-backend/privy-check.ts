/**
 * What the crew backend needs from Privy, checked against the real API.
 *
 *   bun --env-file=.dev.vars privy-check.ts        (from apps/crew-backend)
 *
 * Four questions, each of which the design depends on and the documentation
 * does not settle:
 *
 *   1. Can Privy's app secret alone change an org's owner quorum? It must not —
 *      otherwise whoever holds the backend's secret owns every org.
 *   2. Can a 1-of-1 founder grow the quorum to 2-of-2, and is the new threshold
 *      then enforced?
 *   3. Can a quorum-owned wallet transact on Sepolia and on Arc testnet — and on
 *      Arc, if Privy will not broadcast, can it at least sign for us to send?
 *   4. Can a policy-bound signer act without the owners, and is the policy what
 *      stops it?
 *
 * It spends testnet funds only: a little Sepolia ETH and Arc USDC, sent from the
 * local wallet to the Privy wallet so it can pay gas. The authorization keys are
 * generated for this run, held in memory, and never written or printed — so the
 * quorum, wallet and dust it creates are left behind in the Privy dev app,
 * unusable by anyone once this process exits.
 *
 * The app secret is read from the environment and never printed.
 */
import { PrivyClient, generateP256KeyPair } from '@privy-io/node';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  http,
  parseEther,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { loadOrCreateEvmWallet } from '../../packages/sdk/src/wallet/store';

const APP_ID = process.env.PRIVY_APP_ID;
const APP_SECRET = process.env.PRIVY_APP_SECRET;
if (!APP_ID || !APP_SECRET || APP_SECRET.startsWith('replace-with')) {
  console.error('\n  PRIVY_APP_ID and PRIVY_APP_SECRET must be set — run with --env-file=.dev.vars\n');
  process.exit(1);
}

const arc = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } },
});

const CHAINS = {
  sepolia: { chain: sepolia, caip2: 'eip155:11155111', rpc: 'https://ethereum-sepolia-rpc.publicnode.com' },
  arc: { chain: arc, caip2: 'eip155:5042002', rpc: 'https://rpc.testnet.arc.network' },
} as const;

/* ------------------------------------------------------------------ report */

type Outcome = 'ok' | 'FAIL' | 'info';
const results: { outcome: Outcome; line: string }[] = [];
const note = (outcome: Outcome, line: string) => {
  results.push({ outcome, line });
  console.log(`  ${outcome.padEnd(4)}  ${line}`);
};

/** A Privy error, described without anything that could carry a credential. */
const why = (error: unknown): string => {
  const e = error as { status?: number; message?: string; name?: string };
  const message = (e.message ?? String(error)).replace(/\s+/g, ' ').slice(0, 220);
  return `${e.status ?? e.name ?? 'error'}: ${message}`;
};

/** Runs something expected to be refused. Refusal is the pass. */
const expectRefused = async (label: string, work: () => Promise<unknown>) => {
  try {
    await work();
    note('FAIL', `${label} — it was ALLOWED`);
    return false;
  } catch (error) {
    note('ok', `${label} — refused (${why(error)})`);
    return true;
  }
};

const expectAllowed = async <T>(label: string, work: () => Promise<T>): Promise<T | null> => {
  try {
    const value = await work();
    note('ok', label);
    return value;
  } catch (error) {
    note('FAIL', `${label} — ${why(error)}`);
    return null;
  }
};

/* ------------------------------------------------------------------- setup */

const privy = new PrivyClient({ appId: APP_ID, appSecret: APP_SECRET });

const local = loadOrCreateEvmWallet({ network: 'eip155:5042002' });
const funder = privateKeyToAccount(local.wallet.exportPrivateKey() as Hex);

console.log(`\n  privy app   ${APP_ID}`);
console.log(`  funder      ${funder.address}\n`);

const ownerA = await generateP256KeyPair();
const ownerB = await generateP256KeyPair();
const signerKey = await generateP256KeyPair();

/* ---------------------------------------------------- 1 + 2: owner quorum */

console.log('Owner quorum\n');

const quorum = await expectAllowed('a 1-of-1 owner quorum is created for the founder', () =>
  privy.keyQuorums().create({
    public_keys: [ownerA.publicKey],
    authorization_threshold: 1,
    display_name: 'crew-check owners',
  }),
);
if (!quorum) process.exit(1);
console.log(`        quorum ${quorum.id}`);

const wallet = await expectAllowed('a wallet owned by that quorum is created', () =>
  privy.wallets().create({ chain_type: 'ethereum', owner_id: quorum.id }),
);
if (!wallet) process.exit(1);
console.log(`        wallet ${wallet.id} at ${wallet.address}`);

await expectRefused("the app secret alone cannot change the quorum's members", () =>
  privy.keyQuorums().update(quorum.id, {
    public_keys: [ownerA.publicKey, ownerB.publicKey],
    authorization_threshold: 2,
  }),
);

await expectRefused('the app secret alone cannot change the wallet owner', () =>
  privy.wallets().update(wallet.id, { owner: { public_key: ownerB.publicKey } }),
);

await expectRefused("a key that is not a member cannot change the quorum", () =>
  privy.keyQuorums().update(quorum.id, {
    public_keys: [ownerB.publicKey],
    authorization_threshold: 1,
    authorization_context: { authorization_private_keys: [ownerB.privateKey] },
  }),
);

const grown = await expectAllowed('the founder alone grows the quorum to 2-of-2', () =>
  privy.keyQuorums().update(quorum.id, {
    public_keys: [ownerA.publicKey, ownerB.publicKey],
    authorization_threshold: 2,
    authorization_context: { authorization_private_keys: [ownerA.privateKey] },
  }),
);
if (grown) console.log(`        threshold ${grown.authorization_threshold}`);

await expectRefused('once 2-of-2, one owner alone is not enough', () =>
  privy.keyQuorums().update(quorum.id, {
    display_name: 'crew-check owners (one signature)',
    authorization_context: { authorization_private_keys: [ownerA.privateKey] },
  }),
);

await expectAllowed('and both owners together are', () =>
  privy.keyQuorums().update(quorum.id, {
    display_name: 'crew-check owners (2 of 2)',
    authorization_context: { authorization_private_keys: [ownerA.privateKey, ownerB.privateKey] },
  }),
);

const owners = { authorization_private_keys: [ownerA.privateKey, ownerB.privateKey] };

/* ------------------------------------------------------ 3: Sepolia and Arc */

console.log('\nChains\n');

const privyAddress = wallet.address as Hex;

const fund = async (key: keyof typeof CHAINS, amount: bigint) => {
  const { chain, rpc } = CHAINS[key];
  const client = createWalletClient({ account: funder, chain, transport: http(rpc) });
  const reader = createPublicClient({ chain, transport: http(rpc) });
  const hash = await client.sendTransaction({ to: privyAddress, value: amount });
  await reader.waitForTransactionReceipt({ hash });
  return { hash, reader };
};

const sendFromPrivy = async (
  key: keyof typeof CHAINS,
  authorization_context: { authorization_private_keys: string[] },
  to: Hex,
) =>
  privy.wallets().ethereum().sendTransaction(wallet.id, {
    caip2: CHAINS[key].caip2,
    params: { transaction: { to, value: '0x1', chain_id: CHAINS[key].chain.id } },
    authorization_context,
  });

// Sepolia: gas is ETH, and priced live so the funding covers a few sends.
const sepoliaReader = createPublicClient({ chain: sepolia, transport: http(CHAINS.sepolia.rpc) });
const sepoliaFees = await sepoliaReader.estimateFeesPerGas();
const sepoliaFunding = (sepoliaFees.maxFeePerGas ?? parseEther('0.00000002')) * 21_000n * 8n;
const sepoliaBudget = sepoliaFunding > parseEther('0.004') ? parseEther('0.004') : sepoliaFunding;

const fundedSepolia = await expectAllowed(`the wallet is funded with ${formatEther(sepoliaBudget)} Sepolia ETH`, () =>
  fund('sepolia', sepoliaBudget),
);

if (fundedSepolia) {
  await expectRefused('a Sepolia send signed by one owner is refused', () =>
    sendFromPrivy('sepolia', { authorization_private_keys: [ownerA.privateKey] }, funder.address),
  );
  const sent = await expectAllowed('a Sepolia send signed by both owners goes through', () =>
    sendFromPrivy('sepolia', owners, funder.address),
  );
  if (sent) console.log(`        sepolia tx ${(sent as { hash?: string }).hash ?? JSON.stringify(sent).slice(0, 120)}`);
}

const fundedArc = await expectAllowed('the wallet is funded with 0.05 USDC on Arc', () =>
  fund('arc', parseEther('0.05')),
);

if (fundedArc) {
  let broadcast = false;
  try {
    const sent = await sendFromPrivy('arc', owners, funder.address);
    note('ok', 'Privy signs and broadcasts on Arc testnet');
    console.log(`        arc tx ${(sent as { hash?: string }).hash ?? JSON.stringify(sent).slice(0, 120)}`);
    broadcast = true;
  } catch (error) {
    note('info', `Privy did not broadcast on Arc (${why(error)}) — trying sign-only`);
  }

  if (!broadcast) {
    try {
      const reader = fundedArc.reader;
      const [nonce, fees, gas] = await Promise.all([
        reader.getTransactionCount({ address: privyAddress }),
        reader.estimateFeesPerGas(),
        reader.estimateGas({ account: privyAddress, to: funder.address, value: 1n }),
      ]);
      const signed = await privy.wallets().ethereum().signTransaction(wallet.id, {
        params: {
          transaction: {
            type: 2,
            chain_id: arc.id,
            to: funder.address,
            value: '0x1',
            nonce,
            gas_limit: `0x${gas.toString(16)}`,
            max_fee_per_gas: `0x${(fees.maxFeePerGas ?? 0n).toString(16)}`,
            max_priority_fee_per_gas: `0x${(fees.maxPriorityFeePerGas ?? 0n).toString(16)}`,
          },
        },
        authorization_context: owners,
      });
      const raw = signed.signed_transaction as Hex | undefined;
      if (!raw?.startsWith('0x')) throw new Error(`no signed transaction in ${JSON.stringify(signed).slice(0, 160)}`);
      const hash = await reader.sendRawTransaction({ serializedTransaction: raw });
      await reader.waitForTransactionReceipt({ hash });
      note('ok', `Privy signs for Arc and we broadcast it ourselves (${hash})`);
    } catch (error) {
      note('FAIL', `Arc sign-only did not work either — ${why(error)}`);
    }
  }
}

/* ------------------------------------------- 4: a signer bound by policy */

console.log('\nPolicy-bound signer\n');

const signerQuorum = await expectAllowed('a 1-of-1 key quorum for the backend signer is created', () =>
  privy.keyQuorums().create({
    public_keys: [signerKey.publicKey],
    authorization_threshold: 1,
    display_name: 'crew-check backend signer',
  }),
);

/*
  The policy is owned by the owner quorum, so loosening it later needs the
  owners — the backend signer can use it but never widen it.
*/
const policy = await expectAllowed('a policy allowing only sends to the funder, under a tiny value, is created', () =>
  privy.policies().create({
    version: '1.0',
    name: 'crew-check top-ups only',
    chain_type: 'ethereum',
    owner_id: quorum.id,
    rules: [
      {
        name: 'only the top-up address, only dust',
        method: 'eth_sendTransaction',
        action: 'ALLOW',
        conditions: [
          { field_source: 'ethereum_transaction', field: 'to', operator: 'eq', value: funder.address },
          { field_source: 'ethereum_transaction', field: 'value', operator: 'lte', value: '0x10' },
        ],
      },
    ],
  }),
);

if (signerQuorum && policy) {
  await expectRefused('the app secret alone cannot add a signer to the wallet', () =>
    privy.wallets().update(wallet.id, {
      additional_signers: [{ signer_id: signerQuorum.id, override_policy_ids: [policy.id] }],
    }),
  );

  const attached = await expectAllowed('both owners attach the signer, bound to the policy', () =>
    privy.wallets().update(wallet.id, {
      additional_signers: [{ signer_id: signerQuorum.id, override_policy_ids: [policy.id] }],
      authorization_context: owners,
    }),
  );

  if (attached && fundedSepolia) {
    const signer = { authorization_private_keys: [signerKey.privateKey] };
    await expectAllowed('the signer alone sends a top-up the policy allows — no owners asked', () =>
      sendFromPrivy('sepolia', signer, funder.address),
    );
    await expectRefused('the signer alone cannot send anywhere else', () =>
      sendFromPrivy('sepolia', signer, '0x000000000000000000000000000000000000dEaD'),
    );
    await expectRefused('the signer cannot change the policy that binds it', () =>
      privy.policies().update(policy.id, {
        rules: [],
        authorization_context: signer,
      } as never),
    );
  }
}

/* ----------------------------------------------------------------- summary */

const failed = results.filter((result) => result.outcome === 'FAIL');
console.log(failed.length === 0 ? '\n  All checks pass.\n' : `\n  ${failed.length} FAILED:\n${failed.map((f) => `    - ${f.line}`).join('\n')}\n`);
process.exit(failed.length === 0 ? 0 : 1);
