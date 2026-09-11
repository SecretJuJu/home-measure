CREATE TABLE IF NOT EXISTS oauth_transactions (
  state_hash TEXT PRIMARY KEY,
  pkce_verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_transactions_expires_at_idx ON oauth_transactions(expires_at);
