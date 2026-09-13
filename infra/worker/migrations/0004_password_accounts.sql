-- Accounts move from Google OAuth to a username and password held by this app.
-- Google rows carried no password, so they cannot become sign-in records and are dropped together
-- with everything that hung off them. Development identities keep their rows with an unusable hash.
PRAGMA defer_foreign_keys = true;

CREATE TABLE users_password (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name TEXT,
  created_at INTEGER NOT NULL
);

INSERT INTO users_password (id, username, password_hash, name, created_at)
SELECT id, email, '', name, created_at FROM users WHERE provider = 'development';

DELETE FROM idempotent_mutations WHERE user_id NOT IN (SELECT id FROM users_password);
DELETE FROM photos WHERE user_id NOT IN (SELECT id FROM users_password);
DELETE FROM properties WHERE user_id NOT IN (SELECT id FROM users_password);
DELETE FROM sessions WHERE user_id NOT IN (SELECT id FROM users_password);

DROP TABLE users;
ALTER TABLE users_password RENAME TO users;

CREATE UNIQUE INDEX users_username_idx ON users(username);

DROP TABLE IF EXISTS oauth_transactions;
