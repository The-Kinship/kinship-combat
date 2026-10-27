ALTER TABLE `quests` ADD COLUMN `start_place` text NOT NULL DEFAULT '';
ALTER TABLE `quests` ADD COLUMN `start_text` text NOT NULL DEFAULT '';
ALTER TABLE `items` ADD COLUMN `starts_quest` text NOT NULL DEFAULT '';
