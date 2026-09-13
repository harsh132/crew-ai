/**
 * Builds the publishable `crew-ai` package from the Crew app.
 *
 *   node build.mjs        (also runs automatically before `npm pack` / `npm publish`)
 *
 *   dist/           the page, built by Vite from apps/crew
 *   server/main.mjs the runtime, bundled for Node from apps/crew/server/main.ts
 *
 * Needs Bun on the machine that builds it — Bun does the bundling — but not on
 * the machines that install it: the result is plain Node.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const app = join(root, 'apps', 'crew');

const run = (command, args, cwd) => {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    console.error(`\n${command} failed`);
    process.exit(result.status ?? 1);
  }
};

rmSync(join(here, 'dist'), { recursive: true, force: true });
rmSync(join(here, 'server'), { recursive: true, force: true });

run('bun', ['run', 'build'], app);
run(
  'bun',
  ['build', join(app, 'server', 'main.ts'), '--target=node', '--format=esm', '--outfile', join(here, 'server', 'main.mjs')],
  root,
);
cpSync(join(app, 'dist'), join(here, 'dist'), { recursive: true });

for (const required of ['dist/index.html', 'server/main.mjs']) {
  if (!existsSync(join(here, required))) {
    console.error(`\nbuild output is missing ${required}`);
    process.exit(1);
  }
}
console.log('\ncrew-ai built: dist/ and server/main.mjs');
