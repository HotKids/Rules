ALTER TABLE `nodes` ADD `install_started_at` integer;--> statement-breakpoint
ALTER TABLE `nodes` ADD `install_finished_at` integer;--> statement-breakpoint
ALTER TABLE `nodes` ADD `last_error` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `last_seen_at` integer;--> statement-breakpoint
ALTER TABLE `nodes` ADD `last_check_at` integer;--> statement-breakpoint
ALTER TABLE `nodes` ADD `vendor` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `region` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `tags` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `nodes` ADD `expire_at` integer;--> statement-breakpoint
ALTER TABLE `nodes` ADD `remark` text;--> statement-breakpoint
CREATE INDEX `nodes_vendor_idx` ON `nodes` (`vendor`);--> statement-breakpoint
CREATE INDEX `nodes_region_idx` ON `nodes` (`region`);--> statement-breakpoint
CREATE INDEX `nodes_expire_idx` ON `nodes` (`expire_at`);
