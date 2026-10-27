-- Houses and apartments share one map per house type, so a stash or sign is also tied to the exact house (world, ward, plot, room).
-- Empty means "not in a house". Run this BEFORE uploading the new server files.
ALTER TABLE `stashes` ADD COLUMN `room` TEXT NOT NULL DEFAULT '';
ALTER TABLE `signs` ADD COLUMN `room` TEXT NOT NULL DEFAULT '';
