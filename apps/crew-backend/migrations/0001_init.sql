-- Organizations, the people in them, and what happened.
--
-- The chain holds what must be public and verifiable: the name, who owns it,
-- which addresses resolve. This holds what must not be: emails, the org chart,
-- pending invitations, and a record of who did what.

CREATE TABLE orgs (
  id               TEXT PRIMARY KEY,
  -- The .eth label, lower-case and normalised. Unique across the backend.
  label            TEXT NOT NULL UNIQUE,
  -- label.eth
  name             TEXT NOT NULL,
  founder_user_id  TEXT NOT NULL,
  -- Privy key quorum that owns the org wallet. Its members are the owners.
  owner_quorum_id  TEXT NOT NULL,
  wallet_id        TEXT NOT NULL,
  wallet_address   TEXT NOT NULL,
  -- setting_up | ready | failed
  status           TEXT NOT NULL CHECK (status IN ('setting_up', 'ready', 'failed')),
  -- The setup step last reached, for showing progress and diagnosing a stall.
  step             TEXT NOT NULL,
  error            TEXT,
  resolver         TEXT,
  registry         TEXT,
  crew_registry    TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE members (
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  user_id     TEXT NOT NULL,
  -- The member's own wallet. Null until they have one.
  address     TEXT,
  role        TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'employee')),
  -- label.crew.org.eth once issued.
  subname     TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX members_by_user ON members (user_id);

CREATE TABLE audit (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id   TEXT NOT NULL REFERENCES orgs(id),
  at       INTEGER NOT NULL,
  -- A Privy user id, or 'backend' for what the setup did on its own.
  actor    TEXT NOT NULL,
  action   TEXT NOT NULL,
  detail   TEXT
);

CREATE INDEX audit_by_org ON audit (org_id, at);
