CREATE TABLE lounge_patrons (name_key TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, arrived_at TEXT NOT NULL, last_seen TEXT NOT NULL, manual INTEGER NOT NULL DEFAULT 0, helper_id TEXT, helper_name TEXT, helped_at TEXT, helped_by TEXT);
CREATE TABLE lounge_schedule (id TEXT PRIMARY KEY NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, note TEXT NOT NULL DEFAULT '');
CREATE INDEX lounge_schedule_start ON lounge_schedule (starts_at);
CREATE TABLE lounge_roster (night_id TEXT NOT NULL, member_id TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY (night_id, member_id));
