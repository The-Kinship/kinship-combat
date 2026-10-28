ALTER TABLE `members` ADD COLUMN `gold` integer NOT NULL DEFAULT 0;
CREATE TABLE `gold_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`member_id` text NOT NULL,
	`delta` integer NOT NULL,
	`note` text NOT NULL,
	`created_at` text NOT NULL
);
CREATE INDEX `gold_log_member` ON `gold_log` (`member_id`, `id`);
