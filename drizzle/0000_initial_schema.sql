CREATE TABLE `configuration` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `page_audits` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`url` text NOT NULL,
	`context_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_page_audits_site_url` ON `page_audits` (`site_id`,`url`);--> statement-breakpoint
CREATE INDEX `idx_page_audits_site` ON `page_audits` (`site_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `site_metric_history` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`refresh_id` text,
	`captured_at` integer NOT NULL,
	`metric` text NOT NULL,
	`value` real,
	`grade` text,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`refresh_id`) REFERENCES `site_refreshes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_site_metric_history_series` ON `site_metric_history` (`site_id`,`metric`,`captured_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_site_metric_history_refresh_metric` ON `site_metric_history` (`refresh_id`,`metric`);--> statement-breakpoint
CREATE TABLE `site_metric_monthly` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`month` text NOT NULL,
	`readings` integer NOT NULL,
	`metrics` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_site_metric_monthly_series` ON `site_metric_monthly` (`site_id`,`month`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_site_metric_monthly_site_month` ON `site_metric_monthly` (`site_id`,`month`);--> statement-breakpoint
CREATE TABLE `site_refreshes` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`context_json` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_site_refreshes_site` ON `site_refreshes` (`site_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `sites` (
	`id` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL,
	`registrable_domain` text NOT NULL,
	`gsc_site_url` text,
	`ga4_property_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sites_domain` ON `sites` (`domain`);--> statement-breakpoint
CREATE INDEX `idx_sites_registrable` ON `sites` (`registrable_domain`);--> statement-breakpoint
CREATE TABLE `tool_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`tool_name` text NOT NULL,
	`cache_key` text NOT NULL,
	`result_json` text NOT NULL,
	`domain` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_tool_cache_key` ON `tool_cache` (`cache_key`);--> statement-breakpoint
CREATE INDEX `idx_tool_cache_expires` ON `tool_cache` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_tool_cache_domain` ON `tool_cache` (`domain`);