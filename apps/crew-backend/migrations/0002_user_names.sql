-- Personal names under crewai.eth: alex.crewai.eth, one per Crew user.
--
-- The chain holds the name, its owner (the user's Privy wallet) and what it
-- resolves to. This holds which Privy user asked for it, and how far setting it
-- up has got — so a user who closes the tab mid-setup finds it where it was.

CREATE TABLE user_names (
  -- One name per Privy user.
  user_id         TEXT PRIMARY KEY,
  -- The label under crewai.eth, lower-case and normalised. Unique across users.
  label           TEXT NOT NULL UNIQUE,
  -- label.crewai.eth
  name            TEXT NOT NULL,
  -- The user's own wallet, linked to their Privy account. Owns the name.
  wallet_address  TEXT NOT NULL,
  -- The Crew signer that may issue agent names beneath it.
  signer_address  TEXT NOT NULL,
  -- setting_up | ready | failed
  status          TEXT NOT NULL CHECK (status IN ('setting_up', 'ready', 'failed')),
  step            TEXT NOT NULL,
  error           TEXT,
  registry        TEXT,
  resolver        TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
