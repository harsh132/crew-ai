#!/usr/bin/env node
/**
 * Releases Crew AI everywhere it is installed from, in one command.
 *
 *   bun run release patch        0.1.1 → 0.1.2, then publish
 *   bun run release minor        0.1.1 → 0.2.0
 *   bun run release 0.3.0        an exact version
 *   bun run release              no bump: finish releasing the current version
 *   bun run release patch --dry-run   check and build, publish nothing
 *
 * In order:
 *   1. checks   on main, clean, up to date with origin; logged in to npm
 *   2. version  written to packages/crew-ai/package.json
 *   3. build    page + Node bundle, once
 *   4. npm      npm publish @harsh132/crew-ai
 *   5. docker   harsh132/crew-ai:<version> and :latest, amd64 + arm64
 *   6. git      commit the version, tag crew-ai-v<version>, push both
 *
 * Every publish step first asks whether that version is already out and skips
 * itself if so. A release that stops halfway — an npm one-time password
 * mistyped, Docker not logged in — is finished by running `bun run release`
 * again with no version, rather than by working out by hand which half shipped.
 *
 * npm asks for its one-time password itself, in this terminal. Log in first:
 * `npm login` and `docker login`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const manifestPath = join(here, 'package.json');

const IMAGE = 'harsh132/crew-ai';
const BUILDER = 'crew-multiarch';
const PLATFORMS = 'linux/amd64,linux/arm64';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const bump = args.find((arg) => !arg.startsWith('--'));

/* ------------------------------------------------------------------ helpers */

/*
  Through a shell on Windows, where `npm` is `npm.cmd` and cannot be spawned
  directly. A shell joins arguments with spaces, so any argument holding one —
  a commit message — is quoted first or it arrives as several.
*/
const shell = process.platform === 'win32';
const quote = (arg) => (shell && /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);

/** Runs a command where the person can see it, and stops the release if it fails. */
const run = (command, commandArgs, cwd = root) => {
  console.log(`\n> ${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs.map(quote), { cwd, stdio: 'inherit', shell });
  if (result.status !== 0) fail(`${command} ${commandArgs[0]} failed`);
};

/** Runs a command quietly, for its answer. */
const ask = (command, commandArgs, cwd = root) => {
  const result = spawnSync(command, commandArgs.map(quote), { cwd, encoding: 'utf8', shell });
  /* trimEnd only: `git status --porcelain` lines start with a meaningful space. */
  return { ok: result.status === 0, out: (result.stdout ?? '').trimEnd(), err: (result.stderr ?? '').trimEnd() };
};

const step = (name) => console.log(`\n── ${name}`);

const fail = (message) => {
  console.error(`\nrelease stopped: ${message}`);
  if (!dryRun) {
    console.error('Fix that, then run `bun run release` with no version to finish this one.');
  }
  process.exit(1);
};

const readManifest = () => JSON.parse(readFileSync(manifestPath, 'utf8'));

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

const nextVersion = (current, how) => {
  const match = SEMVER.exec(current);
  if (!match) fail(`package.json has version ${current}, which is not x.y.z`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (how === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (how === 'minor') return `${major}.${minor + 1}.0`;
  if (how === 'major') return `${major + 1}.0.0`;
  if (SEMVER.test(how)) return how;
  fail(`"${how}" is not patch, minor, major or a version like 1.2.3`);
};

/* ------------------------------------------------------------------- checks */

step('checks');

const manifest = readManifest();
const current = manifest.version;
const version = bump ? nextVersion(current, bump) : current;
const tag = `crew-ai-v${version}`;
console.log(`${manifest.name} ${bump ? `${current} → ${version}` : version}${dryRun ? '  (dry run)' : ''}`);

/*
  A dry run reports these instead of stopping on them: it exists to check a
  release before committing to one, which is usually while changes are still
  uncommitted.
*/
const require_ = (ok, message) => {
  if (ok) return console.log(`ok    ${message}`);
  if (dryRun) return console.log(`WARN  ${message}`);
  fail(message);
};

const branch = ask('git', ['branch', '--show-current']).out;
require_(branch === 'main', `on main (on ${branch || 'a detached HEAD'})`);

const dirty = ask('git', ['status', '--porcelain']).out;
/* Resuming may leave the version bump itself uncommitted; that one file is expected. */
const dirtyFiles = dirty
  .split('\n')
  .filter(Boolean)
  .map((line) => line.slice(3));
const onlyManifest = dirtyFiles.length === 1 && dirtyFiles[0] === 'packages/crew-ai/package.json';
require_(dirtyFiles.length === 0 || (!bump && onlyManifest), 'working tree is clean');

ask('git', ['fetch', 'origin', 'main', '--quiet']);
const behind = ask('git', ['rev-list', '--count', 'HEAD..origin/main']).out;
require_(behind === '0', `up to date with origin/main (${behind || '?'} commits behind)`);

const npmUser = ask('npm', ['whoami']);
require_(npmUser.ok, npmUser.ok ? `logged in to npm as ${npmUser.out}` : 'logged in to npm (run `npm login`)');

const dockerUp = ask('docker', ['info', '--format', '{{.ServerVersion}}']);
require_(dockerUp.ok, 'Docker is running');

const npmHas = ask('npm', ['view', `${manifest.name}@${version}`, 'version']).out === version;
const dockerHas = ask('docker', ['buildx', 'imagetools', 'inspect', `${IMAGE}:${version}`]).ok;
const tagHas = ask('git', ['ls-remote', '--tags', 'origin', tag]).out.length > 0;

if (bump && (npmHas || dockerHas || tagHas)) {
  fail(`${version} is already released somewhere (npm: ${npmHas}, docker: ${dockerHas}, tag: ${tagHas}); pick a newer version`);
}
if (!bump && npmHas && dockerHas && tagHas) {
  console.log(`\n${version} is already on npm, Docker Hub and GitHub. Nothing to do.`);
  process.exit(0);
}

/* ------------------------------------------------------------------ version */

step('version');
if (dryRun) {
  console.log(`would set package.json to ${version}`);
} else if (current !== version) {
  manifest.version = version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`package.json is now ${version}`);
} else {
  console.log(`package.json already ${version}`);
}

/* -------------------------------------------------------------------- build */

step('build');
run('node', [join(here, 'build.mjs')]);

if (dryRun) {
  console.log(`\nDry run done. \`bun run release ${bump ?? ''}\` would publish ${version} to npm and ${IMAGE}.`);
  process.exit(0);
}

/* ---------------------------------------------------------------------- npm */

step('npm');
if (npmHas) {
  console.log(`${manifest.name}@${version} is already on npm; skipping`);
} else {
  /* Built a moment ago; prepack would only build it all again. */
  run('npm', ['publish', '--ignore-scripts'], here);
}

/* ------------------------------------------------------------------- docker */

step('docker');
if (dockerHas) {
  console.log(`${IMAGE}:${version} is already on Docker Hub; skipping`);
} else {
  if (!ask('docker', ['buildx', 'inspect', BUILDER]).ok) {
    run('docker', ['buildx', 'create', '--name', BUILDER, '--driver', 'docker-container', '--bootstrap']);
  }
  run(
    'docker',
    ['buildx', 'build', '--builder', BUILDER, '--platform', PLATFORMS, '-t', `${IMAGE}:${version}`, '-t', `${IMAGE}:latest`, '--push', '.'],
    here,
  );
}

/* ---------------------------------------------------------------------- git */

step('git');
if (ask('git', ['status', '--porcelain', '--', 'packages/crew-ai/package.json']).out) {
  run('git', ['add', 'packages/crew-ai/package.json']);
  run('git', ['commit', '-m', `release: crew-ai ${version}`]);
}
if (!ask('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]).ok) {
  run('git', ['tag', '-a', tag, '-m', `crew-ai ${version}`]);
}
run('git', ['push', 'origin', 'main']);
if (!tagHas) run('git', ['push', 'origin', tag]);

console.log(`
Released ${version}
  npm     npm install -g ${manifest.name}@${version}
  docker  docker run -d --name crew -p 127.0.0.1:8800:8800 -v crew-data:/data ${IMAGE}:${version}
  git     ${tag}`);
