ALTER TABLE `bullets` ADD `resolves_thought_id` text;--> statement-breakpoint
ALTER TABLE `events` ADD `user_edited_at` integer;--> statement-breakpoint
ALTER TABLE `questions` ADD `answer_option` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `user_edited_at` integer;--> statement-breakpoint
ALTER TABLE `thoughts` ADD `resolved_at` integer;--> statement-breakpoint
ALTER TABLE `thoughts` ADD `resolved_by_bullet_id` text;--> statement-breakpoint
ALTER TABLE `tracker_entries` ADD `user_edited_at` integer;