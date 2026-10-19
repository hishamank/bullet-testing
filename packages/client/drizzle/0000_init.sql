CREATE TABLE `activities` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`source_bullet_id` text,
	`name` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`tracker_id` text,
	`notes` text,
	`quantity` real,
	`unit` text
);
--> statement-breakpoint
CREATE TABLE `bullets` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`text` text NOT NULL,
	`captured_at` integer NOT NULL,
	`timezone` text NOT NULL,
	`source` text NOT NULL,
	`server_status` text,
	`server_attempts` integer DEFAULT 0 NOT NULL,
	`server_error_code` text,
	`server_error_message` text,
	`server_next_retry_at` integer,
	`sync_rejection` text
);
--> statement-breakpoint
CREATE INDEX `bullets_captured_idx` ON `bullets` (`captured_at`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`source_bullet_id` text,
	`title` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer,
	`all_day` integer NOT NULL,
	`location` text,
	`notes` text
);
--> statement-breakpoint
CREATE TABLE `outbox` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`op_id` text NOT NULL,
	`type` text NOT NULL,
	`bullet_id` text,
	`suggestion_id` text,
	`op` text NOT NULL,
	`created_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_op_id_unique` ON `outbox` (`op_id`);--> statement-breakpoint
CREATE INDEX `outbox_bullet_idx` ON `outbox` (`bullet_id`);--> statement-breakpoint
CREATE INDEX `outbox_suggestion_idx` ON `outbox` (`suggestion_id`);--> statement-breakpoint
CREATE TABLE `suggestions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`source_bullet_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`operation` text NOT NULL,
	`target_id` text,
	`payload` text NOT NULL,
	`confidence` real NOT NULL,
	`tier` text NOT NULL,
	`status` text NOT NULL,
	`resolved_at` integer,
	`applied_entity_id` text,
	`applied_at` integer,
	`auto_applied` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `suggestions_bullet_idx` ON `suggestions` (`source_bullet_id`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`source_bullet_id` text,
	`status` text NOT NULL,
	`title` text NOT NULL,
	`notes` text,
	`due_at` integer,
	`priority` text
);
--> statement-breakpoint
CREATE TABLE `tracker_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`source_bullet_id` text,
	`tracker_id` text NOT NULL,
	`value` text NOT NULL,
	`logged_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trackers` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`source_bullet_id` text,
	`name` text NOT NULL,
	`input_type` text NOT NULL,
	`config` text NOT NULL
);
