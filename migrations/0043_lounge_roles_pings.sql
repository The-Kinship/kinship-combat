CREATE TABLE lounge_roles (member_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (member_id, role));
CREATE TABLE lounge_pings (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, from_id TEXT NOT NULL, from_name TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, responder TEXT);
CREATE TABLE lounge_ping_targets (ping_id TEXT NOT NULL, member_id TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (ping_id, member_id));
