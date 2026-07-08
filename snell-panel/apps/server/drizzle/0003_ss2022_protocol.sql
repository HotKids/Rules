ALTER TABLE `nodes` ADD `protocol` text DEFAULT 'snell' NOT NULL;--> statement-breakpoint
ALTER TABLE `nodes` ADD `method` text;--> statement-breakpoint
CREATE INDEX `nodes_protocol_idx` ON `nodes` (`protocol`);
