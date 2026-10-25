CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`hits` integer NOT NULL,
	`expires` integer NOT NULL
);

CREATE TABLE `rooms` (
	`code` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`state` text NOT NULL,
	`updated_at` text NOT NULL
);
