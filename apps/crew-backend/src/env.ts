/**
 * The crew backend's configuration.
 *
 * Separate from the gate's on purpose, and the separation is about blast
 * radius. The gate holds the key to buy inference; this holds Privy's app
 * secret and a key that pays for and manages organizations' names. Neither
 * Worker has anything the other needs, so neither is given it.
 */
export type Env = {
  DB: D1Database;
  ORG_SETUP: DurableObjectNamespace<import('./setup').OrgSetup>;

  /** Public. Also shipped to browsers. */
  PRIVY_APP_ID: string;
  /**
   * Secret. Creates quorums and wallets and verifies logins — and, as checked
   * live in `privy-check.ts`, cannot change an organization's quorum, wallet
   * owner or signers on its own. That property is what makes holding it here
   * acceptable.
   */
  PRIVY_APP_SECRET: string;
  /**
   * Secret. A Sepolia key that pays for organizations' names and holds the
   * manager role in their member registries.
   *
   * Its own key, not the operator's wallet: what it can lose is testnet gas and
   * the ability to issue members' names — never an organization's name, which
   * belongs to that organization's quorum-owned wallet.
   */
  ENS_MANAGER_PRIVATE_KEY: string;
  SEPOLIA_RPC: string;
};
