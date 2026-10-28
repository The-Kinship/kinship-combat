CREATE TABLE `signs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`zone` text NOT NULL,
	`territory` integer NOT NULL,
	`map_id` integer NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`z` real NOT NULL,
	`map_x` real NOT NULL,
	`map_y` real NOT NULL,
	`created_at` text NOT NULL
);
CREATE INDEX `signs_owner` ON `signs` (`owner_id`);
