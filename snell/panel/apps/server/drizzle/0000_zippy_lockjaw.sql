CREATE TABLE `install_tokens` (
	`token` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`purpose` text DEFAULT 'install' NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`node_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `install_tokens_node_idx` ON `install_tokens` (`node_id`);--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`node_id` text NOT NULL,
	`node_name` text NOT NULL,
	`version` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`ip` text,
	`port` integer,
	`psk` text,
	`country_code` text,
	`isp` text,
	`asn` integer,
	`tfo` integer DEFAULT true NOT NULL,
	`ip_prefilled` integer DEFAULT false NOT NULL,
	`port_prefilled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`registered_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nodes_node_id_unique` ON `nodes` (`node_id`);--> statement-breakpoint
CREATE INDEX `nodes_status_idx` ON `nodes` (`status`);