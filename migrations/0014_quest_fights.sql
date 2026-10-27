CREATE TABLE `quest_fights` (
	`member_id` text NOT NULL,
	`quest_id` text NOT NULL,
	`step` integer NOT NULL,
	`player_hp` integer NOT NULL,
	`npc_hp` integer NOT NULL,
	`log` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY (`member_id`, `quest_id`)
);
