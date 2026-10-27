CREATE TABLE mails (id TEXT PRIMARY KEY NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, anonymous INTEGER NOT NULL DEFAULT 0, gold INTEGER NOT NULL DEFAULT 0, returned INTEGER NOT NULL DEFAULT 0, sent_at TEXT NOT NULL, expires_at TEXT NOT NULL, read_at TEXT);
CREATE INDEX mails_to ON mails (to_id);
CREATE INDEX mails_from ON mails (from_id);
CREATE INDEX mails_expires ON mails (expires_at);
