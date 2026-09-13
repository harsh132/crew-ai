#!/usr/bin/env node
/**
 * `crew` — starts the Crew AI runtime and prints where to open it.
 *
 * The runtime is the part that holds the crew's key and pays for every call;
 * the page it serves is only a view of it. Everything is bundled into this
 * package, so there is nothing else to install.
 */
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  console.log(pkg.version);
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`crew ${pkg.version} (${pkg.name})

Starts Crew AI on this machine and serves it at http://127.0.0.1:8800.

Usage
  crew              start the runtime
  crew --version    print the version
  crew --help       show this help

Environment
  CREW_PORT            port to serve on (default 8800)
  CREW_NETWORK         payment network (default Arc testnet, eip155:5042002)
  CREW_GATE            inference gate URL
  CREW_BACKEND         crew backend URL, for names and organizations
  CREW_AUTO_DEPOSIT    set to "off" to stop depositing wallet USDC into Gateway
  CREW_HOME            where the crew's key and data live (default ~/.crew-ai)

Your crew's key is derived from your wallet's signature and cached in
CREW_HOME. Sign in with the same wallet on any computer to get the same crew
back.`);
  process.exit(0);
}

const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  console.error(`crew needs Node.js 20 or newer; this is ${process.versions.node}.`);
  process.exit(1);
}

await import('../server/main.mjs');
