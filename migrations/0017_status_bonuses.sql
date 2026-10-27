ALTER TABLE `statuses` ADD COLUMN `atk_bonus` integer NOT NULL DEFAULT 0;
ALTER TABLE `statuses` ADD COLUMN `heal_bonus` integer NOT NULL DEFAULT 0;
ALTER TABLE `items` ADD COLUMN `st_atk` integer NOT NULL DEFAULT 0;
ALTER TABLE `items` ADD COLUMN `st_heal` integer NOT NULL DEFAULT 0;
