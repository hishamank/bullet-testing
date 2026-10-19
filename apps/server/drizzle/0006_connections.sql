CREATE TABLE `embedding_baselines` (
	`model` text PRIMARY KEY NOT NULL,
	`dim` integer NOT NULL,
	`sum` blob NOT NULL,
	`count` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `link_jobs` (
	`bullet_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`text_version` integer NOT NULL,
	`run_after` integer NOT NULL,
	`locked_at` integer,
	`last_error` text,
	`pending_question` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bullet_id`) REFERENCES `bullets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `link_jobs_ready_idx` ON `link_jobs` (`status`,`run_after`);--> statement-breakpoint
CREATE TABLE `link_vetoes` (
	`owner_id` text NOT NULL,
	`lo_thought_id` text NOT NULL,
	`hi_thought_id` text NOT NULL,
	`scope` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `lo_thought_id`, `hi_thought_id`, `scope`),
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `nightly_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`slot_at` integer NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`stats` text,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `noticed_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`theme_id` text NOT NULL,
	`headline` text NOT NULL,
	`quotes` text NOT NULL,
	`count` integer NOT NULL,
	`days` integer NOT NULL,
	`status` text NOT NULL,
	`opened_at` integer,
	`resolved_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`theme_id`) REFERENCES `themes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `noticed_cards_owner_idx` ON `noticed_cards` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `theme_aliases` (
	`alias_theme_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`survivor_theme_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`alias_theme_id`) REFERENCES `themes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`survivor_theme_id`) REFERENCES `themes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `theme_thoughts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`theme_id` text NOT NULL,
	`thought_id` text NOT NULL,
	`bullet_id` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`theme_id`) REFERENCES `themes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`thought_id`) REFERENCES `thoughts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `theme_thoughts_pair_idx` ON `theme_thoughts` (`theme_id`,`thought_id`);--> statement-breakpoint
CREATE INDEX `theme_thoughts_thought_idx` ON `theme_thoughts` (`thought_id`);--> statement-breakpoint
CREATE TABLE `themes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`model_name` text,
	`user_name` text,
	`status` text NOT NULL,
	`retired_by` text,
	`merged_into_theme_id` text,
	`vetoed_thought_ids` text DEFAULT '[]' NOT NULL,
	`thought_count` integer DEFAULT 0 NOT NULL,
	`day_count` integer DEFAULT 0 NOT NULL,
	`first_seen_at` integer,
	`last_seen_at` integer,
	`sensitive_share` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `themes_owner_idx` ON `themes` (`owner_id`,`status`);--> statement-breakpoint
CREATE TABLE `thought_embeddings` (
	`thought_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`model` text NOT NULL,
	`text_hash` text NOT NULL,
	`dim` integer NOT NULL,
	`vector` blob NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thought_id`) REFERENCES `thoughts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `thought_embeddings_owner_idx` ON `thought_embeddings` (`owner_id`,`model`);--> statement-breakpoint
CREATE TABLE `thought_links` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`a_thought_id` text NOT NULL,
	`a_bullet_id` text NOT NULL,
	`b_thought_id` text NOT NULL,
	`b_bullet_id` text NOT NULL,
	`type` text NOT NULL,
	`score` real NOT NULL,
	`origin` text NOT NULL,
	`reviewed_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`a_thought_id`) REFERENCES `thoughts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`b_thought_id`) REFERENCES `thoughts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thought_links_pair_idx` ON `thought_links` (`owner_id`,`a_thought_id`,`b_thought_id`);--> statement-breakpoint
CREATE INDEX `thought_links_b_idx` ON `thought_links` (`b_thought_id`);--> statement-breakpoint
ALTER TABLE `questions` ADD `related_thought_id` text;--> statement-breakpoint
ALTER TABLE `thoughts` ADD `entities` text DEFAULT '[]' NOT NULL;