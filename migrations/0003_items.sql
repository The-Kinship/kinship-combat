CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL UNIQUE,
	`token_hash` text NOT NULL UNIQUE,
	`recovery_hash` text NOT NULL,
	`created_at` text NOT NULL
);
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`creator_id` text NOT NULL,
	`name` text NOT NULL,
	`icon` text NOT NULL,
	`description` text NOT NULL,
	`flavor` text NOT NULL,
	`use_label` text NOT NULL,
	`use_text` text NOT NULL,
	`consumable` integer NOT NULL,
	`created_at` text NOT NULL
);
CREATE INDEX `items_owner` ON `items` (`owner_id`);
