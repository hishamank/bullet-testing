CREATE TABLE `activities` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`source_bullet_id` text,
	`name` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`tracker_id` text,
	`notes` text,
	`quantity` real,
	`unit` text,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_bullet_id`) REFERENCES `bullets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tracker_id`) REFERENCES `trackers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `bullets` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`text` text NOT NULL,
	`captured_at` integer NOT NULL,
	`timezone` text NOT NULL,
	`source` text NOT NULL,
	`text_updated_at` integer NOT NULL,
	`text_version` integer DEFAULT 1 NOT NULL,
	`proc_status` text NOT NULL,
	`proc_attempts` integer DEFAULT 0 NOT NULL,
	`proc_error_code` text,
	`proc_error_message` text,
	`proc_next_retry_at` integer,
	`proc_updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `bullets_owner_idx` ON `bullets` (`owner_id`,`captured_at`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token_hash_unique` ON `devices` (`token_hash`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`source_bullet_id` text,
	`title` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer,
	`all_day` integer NOT NULL,
	`location` text,
	`notes` text,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_bullet_id`) REFERENCES `bullets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_owner_idx` ON `events` (`owner_id`,`starts_at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`bullet_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`text_version` integer NOT NULL,
	`run_after` integer NOT NULL,
	`locked_at` integer,
	`last_error_code` text,
	`last_error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bullet_id`) REFERENCES `bullets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `jobs_ready_idx` ON `jobs` (`status`,`run_after`);--> statement-breakpoint
CREATE TABLE `suggestions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
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
	`auto_applied` integer DEFAULT false NOT NULL,
	`applied_before` text,
	`applied_after` text,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_bullet_id`) REFERENCES `bullets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `suggestions_bullet_idx` ON `suggestions` (`source_bullet_id`);--> statement-breakpoint
CREATE TABLE `sync_changes` (
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`seq` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `kind`, `entity_id`)
);
--> statement-breakpoint
CREATE INDEX `sync_changes_seq_idx` ON `sync_changes` (`owner_id`,`seq`);--> statement-breakpoint
CREATE TABLE `sync_counter` (
	`id` integer PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_ops` (
	`owner_id` text NOT NULL,
	`op_id` text NOT NULL,
	`type` text NOT NULL,
	`result` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `op_id`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`source_bullet_id` text,
	`status` text NOT NULL,
	`title` text NOT NULL,
	`notes` text,
	`due_at` integer,
	`priority` text,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_bullet_id`) REFERENCES `bullets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tasks_owner_idx` ON `tasks` (`owner_id`,`status`);--> statement-breakpoint
CREATE TABLE `tracker_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`source_bullet_id` text,
	`tracker_id` text NOT NULL,
	`value` text NOT NULL,
	`logged_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_bullet_id`) REFERENCES `bullets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tracker_id`) REFERENCES `trackers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `trackers` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`source_bullet_id` text,
	`name` text NOT NULL,
	`input_type` text NOT NULL,
	`config` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_bullet_id`) REFERENCES `bullets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
