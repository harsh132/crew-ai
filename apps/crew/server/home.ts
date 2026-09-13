/**
 * Where a crew lives on this machine: its key, its crew file, and its agents'
 * workspaces.
 *
 *   ~/.crew-ai          the default
 *   CREW_HOME=<dir>     anywhere else — a second crew, a test, a scratch run
 *
 * Passed explicitly to every shared wallet and name helper rather than left to
 * their defaults. Those helpers come from packages this repository shares with
 * another product, and a Crew runtime quietly reading someone else's key from a
 * default location is the mix-up a separate product must not have.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CREW_HOME = process.env.CREW_HOME ?? join(homedir(), '.crew-ai');

/*
  Where Crew kept its data before it had a directory of its own, when it shared
  one with the gateway tools in this repository. Read once, to carry a crew
  across; never written.
*/
const EARLIER_HOME = join(homedir(), '.edgerouter');
const CARRIED = ['wallet.json', 'crew.json', 'workspaces'] as const;

/**
 * Copies a crew from its earlier location, once.
 *
 * Only when CREW_HOME was not chosen explicitly and does not exist yet, and only
 * when the earlier location holds a crew file. A key there without a crew file
 * may belong to the other tools, and adopting it would make Crew spend from a
 * wallet nobody set up for it.
 *
 * Copied, not moved: the key may still be used where it is, and a copy that
 * stops halfway loses nothing. Returns what was carried over, for the startup
 * log.
 */
export const adoptEarlierCrew = (): string[] => {
  if (process.env.CREW_HOME || existsSync(CREW_HOME)) return [];
  if (!existsSync(join(EARLIER_HOME, 'crew.json'))) return [];

  mkdirSync(CREW_HOME, { recursive: true, mode: 0o700 });
  const carried: string[] = [];
  for (const entry of CARRIED) {
    const from = join(EARLIER_HOME, entry);
    if (!existsSync(from)) continue;
    cpSync(from, join(CREW_HOME, entry), { recursive: true, force: false, errorOnExist: false });
    carried.push(entry);
  }
  return carried;
};
