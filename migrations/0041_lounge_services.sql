CREATE TABLE lounge_services (id TEXT PRIMARY KEY NOT NULL, member_id TEXT NOT NULL, name TEXT NOT NULL, price INTEGER NOT NULL);
CREATE INDEX lounge_services_member ON lounge_services (member_id);
CREATE TABLE lounge_sessions (id TEXT PRIMARY KEY NOT NULL, member_id TEXT NOT NULL, name TEXT NOT NULL, customer TEXT NOT NULL DEFAULT '', rate INTEGER NOT NULL, minutes INTEGER NOT NULL, started_at TEXT NOT NULL, ends_at TEXT NOT NULL, closed_at TEXT, total INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX lounge_session_open ON lounge_sessions (member_id) WHERE closed_at IS NULL;
CREATE INDEX lounge_sessions_closed ON lounge_sessions (closed_at);
