/**
 * The crew's key, made from a signature by the person's own wallet.
 *
 * A generated key lives in one file on one machine, and losing the machine
 * loses the crew: the agents' names, their budgets, the tab and whatever the
 * address holds. A key derived from a signature can be made again anywhere the
 * same wallet can sign, so `wallet.json` stops being the only copy and becomes a
 * cache.
 *
 * ## What makes it work
 *
 * An ordinary account signs with RFC 6979, which makes a signature a function
 * of the key and the message and nothing else. Same wallet, same fixed message,
 * same signature, same derived key. Privy's embedded wallet, MetaMask and
 * hardware wallets all behave this way.
 *
 * Smart-contract wallets do not. A passkey signature differs every time, so it
 * would derive a different crew on every unlock. Two checks keep those out:
 * every signature must recover to the claimed address (a contract wallet's
 * signature does not), and two signatures of the same message must match (a
 * wallet that signs non-deterministically fails here rather than on the next
 * computer, where the crew would silently be empty).
 *
 * ## What it costs
 *
 * The signature is the key, so a site that talks someone into signing this
 * exact message can spend what the crew holds. The message says so in the words
 * a wallet shows, it names Crew, and it looks nothing like a login. It stays a
 * hot wallet: working money, not savings.
 *
 * The signature itself is never stored — only the key derived from it, in the
 * same file and with the same protection the generated key always had.
 */
import {
  concat,
  getAddress,
  hexToBigInt,
  isAddress,
  keccak256,
  numberToHex,
  parseSignature,
  recoverTypedDataAddress,
  toHex,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readSharedWallet, writeSharedWallet } from '../../../packages/sdk/src/wallet/store';

/**
 * Mixed into the derivation, and versioned.
 *
 * Changing the message or this tag makes a different key, which would strand
 * every crew made with the old one — so a change here is a new version beside
 * this one, never an edit to it.
 */
const DERIVATION = 'crew signer v1';

/**
 * What the wallet is asked to sign. Sent to the page from here, so the text a
 * person reads and the text this file verifies cannot drift apart.
 *
 * No chain id in the domain: the key is the same on every chain, and a message
 * tied to one would derive a different crew after a network switch.
 */
export const UNLOCK = {
  domain: { name: 'Crew', version: '1' },
  types: {
    CrewSigner: [
      { name: 'account', type: 'address' },
      { name: 'purpose', type: 'string' },
      { name: 'warning', type: 'string' },
    ],
  },
  primaryType: 'CrewSigner',
  purpose: 'Unlock the Crew signer that pays for your agents.',
  warning: 'Only sign this in Crew on your own computer. Anyone holding this signature can spend what your crew holds.',
} as const;

/** secp256k1's group order, for putting `s` in its low form. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export type DerivedSigner = { privateKey: Hex; address: string; derivedFrom: string };

export const deriveSigner = async (account: string, signatures: string[]): Promise<DerivedSigner> => {
  if (!isAddress(account)) throw new Error('that is not a wallet address');
  if (signatures.length !== 2) {
    throw new Error('two signatures are needed — the second proves your wallet signs the same way every time');
  }

  const expected = getAddress(account);
  const message = { account: expected, purpose: UNLOCK.purpose, warning: UNLOCK.warning };

  const parts: { r: bigint; s: bigint }[] = [];
  for (const signature of signatures) {
    let recovered: string;
    let r: bigint;
    let s: bigint;
    try {
      recovered = await recoverTypedDataAddress({
        domain: UNLOCK.domain,
        types: UNLOCK.types,
        primaryType: UNLOCK.primaryType,
        message,
        signature: signature as Hex,
      });
      const parsed = parseSignature(signature as Hex);
      r = hexToBigInt(parsed.r);
      /*
        Low-s, so a wallet that happens to return the other valid form of the
        same signature still derives the same key.
      */
      const high = hexToBigInt(parsed.s);
      s = high > N / 2n ? N - high : high;
    } catch {
      recovered = '';
      r = 0n;
      s = 0n;
    }
    if (recovered !== expected) {
      throw new Error(
        'that signature does not come from the wallet itself — smart wallets and passkey wallets cannot unlock Crew, because they sign differently every time. Use an email login or a browser wallet.',
      );
    }
    parts.push({ r, s });
  }

  const [first, second] = parts as [{ r: bigint; s: bigint }, { r: bigint; s: bigint }];
  if (first.r !== second.r || first.s !== second.s) {
    throw new Error(
      'your wallet signed the same message two different ways, so it would make a different crew on every computer. Use an email login or a browser wallet.',
    );
  }

  const privateKey = keccak256(
    concat([toHex(DERIVATION), numberToHex(first.r, { size: 32 }), numberToHex(first.s, { size: 32 })]),
  );
  return { privateKey, address: privateKeyToAccount(privateKey).address, derivedFrom: expected };
};

/** The stored signer, if there is one. Never generates. */
export const storedSigner = () => readSharedWallet();

/**
 * Keeps the derived key as the runtime's wallet.
 *
 * Refuses to replace a different key. A runtime is only locked when there is no
 * key at all, so a mismatch here means two unlocks raced or a file appeared
 * underneath — and overwriting would put somebody's funded key out of reach.
 */
export const saveSigner = (signer: DerivedSigner): void => {
  const existing = readSharedWallet();
  if (existing) {
    if (getAddress(existing.address) === getAddress(signer.address)) return;
    throw new Error(`a different signer is already stored (${existing.address}); move it aside before unlocking`);
  }
  writeSharedWallet({
    privateKey: signer.privateKey.slice(2),
    address: signer.address,
    derivedFrom: signer.derivedFrom,
  });
};
