CREATE TABLE `stashes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`zone` text NOT NULL,
	`territory` integer NOT NULL,
	`map_id` integer NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`z` real NOT NULL,
	`map_x` real NOT NULL,
	`map_y` real NOT NULL,
	`is_private` integer NOT NULL,
	`created_at` text NOT NULL
);
CREATE INDEX `stashes_owner` ON `stashes` (`owner_id`);
