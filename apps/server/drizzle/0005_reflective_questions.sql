CREATE TABLE `reflect_jobs` (
	`bullet_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`text_version` integer NOT NULL,
	`run_after` integer NOT NULL,
	`locked_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bullet_id`) REFERENCES `bullets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reflect_jobs_ready_idx` ON `reflect_jobs` (`status`,`run_after`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`source_bullet_id` text,
	`source_thought_id` text,
	`suggestion_id` text,
	`kind` text DEFAULT 'clarifying' NOT NULL,
	`origin` text DEFAULT 'capture' NOT NULL,
	`topic` text NOT NULL,
	`text` text NOT NULL,
	`options` text NOT NULL,
	`status` text NOT NULL,
	`answer_bullet_id` text,
	`answer_option` text,
	`resolved_at` integer,
	`snoozed_until` integer,
	`snooze_count` integer DEFAULT 0 NOT NULL,
	`template_id` text,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_bullet_id`) REFERENCES `bullets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_questions`("id", "owner_id", "created_at", "updated_at", "state", "source_bullet_id", "source_thought_id", "suggestion_id", "kind", "topic", "text", "options", "status", "answer_bullet_id", "answer_option", "resolved_at") SELECT "id", "owner_id", "created_at", "updated_at", "state", "source_bullet_id", "source_thought_id", "suggestion_id", "kind", "topic", "text", "options", "status", "answer_bullet_id", "answer_option", "resolved_at" FROM `questions`;--> statement-breakpoint
DROP TABLE `questions`;--> statement-breakpoint
ALTER TABLE `__new_questions` RENAME TO `questions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `questions_bullet_idx` ON `questions` (`source_bullet_id`);--> statement-breakpoint
CREATE INDEX `questions_kind_idx` ON `questions` (`owner_id`,`kind`,`status`);--> statement-breakpoint
ALTER TABLE `thoughts` ADD `sensitive` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `thoughts` ADD `never_ask` integer DEFAULT false NOT NULL;