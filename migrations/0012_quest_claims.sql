CREATE TABLE `quest_claims` (
	`quest_id` text NOT NULL,
	`step` integer NOT NULL,
	`member_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY (`quest_id`, `step`)
);
