CREATE TABLE `players` (
	`id` text PRIMARY KEY NOT NULL,
	`recovery_hash` text NOT NULL UNIQUE,
	`created_at` text NOT NULL
);
ALTER TABLE `members` ADD COLUMN `player_id` text NOT NULL DEFAULT '';
INSERT INTO `players` (`id`, `recovery_hash`, `created_at`) SELECT `id`, `recovery_hash`, `created_at` FROM `members`;
UPDATE `members` SET `player_id` = `id`;
CREATE INDEX `members_player` ON `members` (`player_id`);
