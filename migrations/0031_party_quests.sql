CREATE TABLE IF NOT EXISTS party_links (
  scene_code TEXT NOT NULL,
  member_id TEXT NOT NULL,
  scene_member_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scene_code, member_id)
);
CREATE INDEX IF NOT EXISTS party_links_member ON party_links (member_id);
CREATE TABLE IF NOT EXISTS quest_shared (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id TEXT NOT NULL,
  quest_id TEXT NOT NULL,
  title TEXT NOT NULL,
  by_name TEXT NOT NULL,
  text TEXT NOT NULL,
  gained TEXT NOT NULL DEFAULT '[]',
  status_gained TEXT NOT NULL DEFAULT '',
  finished INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS quest_shared_member ON quest_shared (member_id);
