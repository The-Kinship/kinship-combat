ALTER TABLE `items` ADD COLUMN `requires` text NOT NULL DEFAULT '';
ALTER TABLE `items` ADD COLUMN `requires_consume` integer NOT NULL DEFAULT 0;
