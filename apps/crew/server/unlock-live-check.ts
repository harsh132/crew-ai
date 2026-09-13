/**
 * Unlocks a running, locked Crew runtime with a throwaway wallet.
 *
 *   CREW_PORT=8811 CREW_HOME=<empty dir> bun apps/crew/server/main.ts
 *   bun apps/crew/server/unlock-live-check.ts http://127.0.0.1:8811 <that dir>
 *
 * Never point it at a real crew: a successful unlock makes the throwaway
 * wallet's derived key the runtime's key. It refuses a runtime that is not
 * locked, and the runtime refuses to replace a key that exists.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { deriveSigner } from './signer';

const base = process.argv[2];
const home = process.argv[3];
if (!base || !home) throw new Error('usage: unlock-live-check.ts <runtime url> <its CREW_HOME>');
const origin = new URL(base).origin;

const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = '') => results.push([name, ok, detail]);

type Template = {
  locked: boolean;
  account?: string;
  signer?: { derivedFrom: string | null };
  unlock?: {
    domain: { name: string; version: string };
    types: { CrewSigner: { name: string; type: string }[] };
    primaryType: 'CrewSigner';
    purpose: string;
    warning: string;
  };
};

const before = (await (await fetch(`${base}/api/state`)).json()) as Template;
if (!before.locked || !before.unlock) throw new Error('that runtime is not locked; refusing to touch it');
check('runtime starts locked', before.locked);

const key = generatePrivateKey();
const wallet = privateKeyToAccount(key);
/* Signed from the template the runtime served, the way the page does. */
const sign = () =>
  wallet.signTypedData({
    domain: before.unlock!.domain,
    types: before.unlock!.types,
    primaryType: before.unlock!.primaryType,
    message: { account: wallet.address, purpose: before.unlock!.purpose, warning: before.unlock!.warning },
  });
const signatures = [await sign(), await sign()];
const expected = await deriveSigner(wallet.address, signatures);

const unlock = await fetch(`${base}/api/signer/unlock`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin },
  body: JSON.stringify({ account: wallet.address, signatures }),
});
const unlocked = (await unlock.json()) as { address?: string; error?: string };
check('unlock accepted', unlock.status === 200, unlocked.error ?? unlocked.address ?? '');
check('runtime reports the derived address', unlocked.address === expected.address, expected.address);

const after = (await (await fetch(`${base}/api/state`)).json()) as Template;
check('state is unlocked', after.locked === false);
check('state account is the derived signer', after.account === expected.address, after.account ?? '');
check('state names the wallet it came from', after.signer?.derivedFrom === wallet.address);

const stored = JSON.parse(readFileSync(join(home, 'wallet.json'), 'utf8')) as {
  privateKey: string;
  address: string;
  derivedFrom?: string;
};
check('wallet.json holds the derived key', `0x${stored.privateKey}` === expected.privateKey);
check('wallet.json records derivedFrom', stored.derivedFrom === wallet.address);
check('no signature was written to disk', !JSON.stringify(stored).includes(signatures[0]!.slice(2, 40)));

const second = await fetch(`${base}/api/signer/unlock`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin },
  body: JSON.stringify({ account: wallet.address, signatures }),
});
check('a second unlock is refused', second.status === 409);

for (const [name, ok, detail] of results) console.log(ok ? 'PASS' : 'FAIL', name, detail ? `— ${detail}` : '');
console.log(`\nderived ${expected.address} from ${wallet.address}`);
const passed = results.every(([, ok]) => ok);
console.log(passed ? `${results.length} checks passed` : 'some checks failed');
if (!passed) process.exit(1);
