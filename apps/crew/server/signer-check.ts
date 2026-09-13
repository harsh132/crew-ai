/**
 * Checks the signature-derived signer with throwaway keys. No network, no files.
 *
 *   bun apps/crew/server/signer-check.ts
 *
 * What has to hold for "sign on any computer, get the same crew" to be true,
 * and for nobody else to be able to get it.
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { parseSignature, serializeSignature } from 'viem';
import { deriveSigner, UNLOCK } from './signer';

const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = '') => results.push([name, ok, detail]);

const signWith = (key: `0x${string}`, account: `0x${string}`) =>
  privateKeyToAccount(key).signTypedData({
    domain: UNLOCK.domain,
    types: UNLOCK.types,
    primaryType: UNLOCK.primaryType,
    message: { account, purpose: UNLOCK.purpose, warning: UNLOCK.warning },
  });

const refuse = async (name: string, run: () => Promise<unknown>) => {
  try {
    await run();
    check(name, false, 'accepted');
  } catch (error) {
    check(name, true, (error as Error).message.slice(0, 80));
  }
};

const keyA = generatePrivateKey();
const a = privateKeyToAccount(keyA).address;
const s1 = await signWith(keyA, a);
const s2 = await signWith(keyA, a);
check('an ordinary account signs identically twice', s1 === s2);

const first = await deriveSigner(a, [s1, s2]);
const again = await deriveSigner(a.toLowerCase(), [s2, s1]);
check('same wallet derives the same key', first.privateKey === again.privateKey, first.address);
check('derived key is not the wallet key', first.privateKey !== keyA && first.address !== a);
check('derivedFrom is the checksummed wallet', first.derivedFrom === a);

const keyB = generatePrivateKey();
const b = privateKeyToAccount(keyB).address;
const other = await deriveSigner(b, [await signWith(keyB, b), await signWith(keyB, b)]);
check('a different wallet derives a different key', other.address !== first.address);

await refuse('refuses another wallet signing for this address', async () =>
  deriveSigner(a, [await signWith(keyB, a), await signWith(keyB, a)]),
);
await refuse('refuses one real and one foreign signature', async () => deriveSigner(a, [s1, await signWith(keyB, a)]));
await refuse('refuses a single signature', () => deriveSigner(a, [s1]));
await refuse('refuses garbage', () => deriveSigner(a, ['0x1234', '0x5678']));
await refuse('refuses a non-address', () => deriveSigner('nope', [s1, s2]));

/* v written as 27/28 or as a parity bit is the same signature and must be the same key. */
const parsed = parseSignature(s1);
const legacyV = serializeSignature({ r: parsed.r, s: parsed.s, v: parsed.yParity === 0 ? 27n : 28n });
const parityForm = serializeSignature({ r: parsed.r, s: parsed.s, yParity: parsed.yParity! });
const forms = await deriveSigner(a, [legacyV, parityForm]);
check('v=27/28 and yParity=0/1 derive the same key', forms.privateKey === first.privateKey);

for (const [name, ok, detail] of results) console.log(ok ? 'PASS' : 'FAIL', name, detail ? `— ${detail}` : '');
const passed = results.every(([, ok]) => ok);
console.log(passed ? `\n${results.length} checks passed` : '\nsome checks failed');
if (!passed) process.exit(1);
