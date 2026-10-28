CREATE TABLE `statuses` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`icon` text NOT NULL,
	`description` text NOT NULL,
	`is_debuff` integer NOT NULL,
	`expires_at` text,
	`source_id` text NOT NULL,
	`created_at` text NOT NULL
);
CREATE INDEX `statuses_member` ON `statuses` (`member_id`);
ALTER TABLE `items` ADD COLUMN `st_name` text NOT NULL DEFAULT '';
ALTER TABLE `items` ADD COLUMN `st_desc` text NOT NULL DEFAULT '';
ALTER TABLE `items` ADD COLUMN `st_icon` text NOT NULL DEFAULT '';
ALTER TABLE `items` ADD COLUMN `st_debuff` integer NOT NULL DEFAULT 0;
ALTER TABLE `items` ADD COLUMN `st_minutes` integer NOT NULL DEFAULT 0;
ALTER TABLE `items` ADD COLUMN `cures` text NOT NULL DEFAULT '';
