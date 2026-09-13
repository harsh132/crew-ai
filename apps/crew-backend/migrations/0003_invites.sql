-- Inviting members into an organization.
--
-- An invite is a link: an owner or manager chooses the member's name and role,
-- and whoever opens the link and logs in becomes that member. Only a hash of
-- the link's token is kept, so the table alone cannot be used to join.

CREATE TABLE invites (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs(id),
  -- sha256 of the token in the link, hex. The token itself is shown once.
  token_hash   TEXT NOT NULL UNIQUE,
  -- The member's label: alex, for alex.crew.org.eth.
  label        TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('manager', 'employee')),
  created_by   TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked')),
  accepted_by  TEXT,
  expires_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX invites_by_org ON invites (org_id, status);

-- Where a member's name under crew.org.eth has got to: null for members who
-- have none (the founder), then setting_up, ready or failed.
ALTER TABLE members ADD COLUMN name_status TEXT;
ALTER TABLE members ADD COLUMN name_error TEXT;
