CREATE TABLE `quests` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`intro` text NOT NULL,
	`steps` text NOT NULL,
	`created_at` text NOT NULL
);
CREATE TABLE `quest_progress` (
	`member_id` text NOT NULL,
	`quest_id` text NOT NULL,
	`step` integer NOT NULL,
	`done` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY (`member_id`, `quest_id`)
);
CREATE INDEX `quest_progress_member` ON `quest_progress` (`member_id`);
