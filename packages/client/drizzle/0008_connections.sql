CREATE TABLE `noticed_cards` (
	`id` text PRIMARY KEY NOT NULL,
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
	`resolved_at` integer
);
--> statement-breakpoint
CREATE TABLE `theme_thoughts` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`theme_id` text NOT NULL,
	`thought_id` text NOT NULL,
	`bullet_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `theme_thoughts_thought_idx` ON `theme_thoughts` (`thought_id`);--> statement-breakpoint
CREATE TABLE `themes` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`name` text,
	`named_by_user` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`merged_into_theme_id` text,
	`thought_count` integer DEFAULT 0 NOT NULL,
	`day_count` integer DEFAULT 0 NOT NULL,
	`first_seen_at` integer,
	`last_seen_at` integer
);
--> statement-breakpoint
CREATE TABLE `thought_links` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`a_thought_id` text NOT NULL,
	`a_bullet_id` text NOT NULL,
	`b_thought_id` text NOT NULL,
	`b_bullet_id` text NOT NULL,
	`type` text NOT NULL,
	`visible_from` text DEFAULT 'both' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `thought_links_a_bullet_idx` ON `thought_links` (`a_bullet_id`);--> statement-breakpoint
CREATE INDEX `thought_links_b_bullet_idx` ON `thought_links` (`b_bullet_id`);--> statement-breakpoint
ALTER TABLE `questions` ADD `related_thought_id` text;