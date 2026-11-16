CREATE TABLE lounge_kv (k TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL);
CREATE TABLE lounge_menu (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, price INTEGER NOT NULL, description TEXT NOT NULL DEFAULT '', gift TEXT NOT NULL DEFAULT '');
CREATE TABLE lounge_shifts (id TEXT PRIMARY KEY NOT NULL, member_id TEXT NOT NULL, start_at TEXT NOT NULL, end_at TEXT, minutes INTEGER NOT NULL DEFAULT 0, rate INTEGER NOT NULL DEFAULT 0, paid INTEGER NOT NULL DEFAULT 0, ended_by TEXT NOT NULL DEFAULT '');
CREATE UNIQUE INDEX lounge_open ON lounge_shifts (member_id) WHERE end_at IS NULL;
CREATE INDEX lounge_shifts_member ON lounge_shifts (member_id, paid);
CREATE TABLE lounge_sales (id TEXT PRIMARY KEY NOT NULL, member_id TEXT NOT NULL, menu_id TEXT NOT NULL, name TEXT NOT NULL, price INTEGER NOT NULL, qty INTEGER NOT NULL, at TEXT NOT NULL);
CREATE INDEX lounge_sales_at ON lounge_sales (at);
