-- Invites go to a person, found by their Crew name, instead of to a link.
--
-- An employee claims alex.crewai.eth and gives that name to their employer.
-- The employer invites the name; the employee sees the invite in Crew and
-- accepts or declines it. Nobody passes a secret around, so there is no token
-- to store — the invite is addressed to a Privy user.
--
-- Rebuilt rather than altered: SQLite cannot change a CHECK constraint, and
-- `declined` is a new status. Invites from the link version are dropped; there
-- was never a deployed database with any.

DROP TABLE invites;

CREATE TABLE invites (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES orgs(id),
  -- The Privy user the invite is for, found through their crewai.eth name.
  invitee_user_id  TEXT NOT NULL,
  -- The name they were invited by: alex.crewai.eth.
  invitee_name     TEXT NOT NULL,
  -- Their label inside the organization: alex, for alex.crew.org.eth.
  label            TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('manager', 'employee')),
  created_by       TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked', 'declined')),
  expires_at       INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX invites_by_org ON invites (org_id, status);
CREATE INDEX invites_by_invitee ON invites (invitee_user_id, status);
