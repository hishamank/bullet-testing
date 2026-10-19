CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`source_bullet_id` text NOT NULL,
	`source_thought_id` text,
	`suggestion_id` text,
	`kind` text NOT NULL,
	`topic` text NOT NULL,
	`text` text NOT NULL,
	`options` text NOT NULL,
	`status` text NOT NULL,
	`answer_bullet_id` text,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX `questions_bullet_idx` ON `questions` (`source_bullet_id`);--> statement-breakpoint
CREATE TABLE `thoughts` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`source_bullet_id` text NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	`span_start` integer,
	`span_end` integer,
	`kind` text NOT NULL,
	`kind_source` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `thoughts_bullet_idx` ON `thoughts` (`source_bullet_id`);--> statement-breakpoint
ALTER TABLE `activities` ADD `source_thought_id` text;--> statement-breakpoint
ALTER TABLE `bullets` ADD `answers_question_id` text;--> statement-breakpoint
ALTER TABLE `events` ADD `source_thought_id` text;--> statement-breakpoint
ALTER TABLE `outbox` ADD `thought_id` text;--> statement-breakpoint
ALTER TABLE `outbox` ADD `question_id` text;--> statement-breakpoint
ALTER TABLE `suggestions` ADD `source_thought_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `source_thought_id` text;--> statement-breakpoint
ALTER TABLE `tracker_entries` ADD `source_thought_id` text;--> statement-breakpoint
ALTER TABLE `trackers` ADD `source_thought_id` text;