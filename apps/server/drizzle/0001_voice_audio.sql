CREATE TABLE `audio_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`bullet_id` text NOT NULL,
	`mime_type` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text,
	`storage_key` text NOT NULL,
	`received_bytes` integer DEFAULT 0 NOT NULL,
	`upload_status` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bullet_id`) REFERENCES `bullets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audio_bullet_idx` ON `audio_attachments` (`bullet_id`);--> statement-breakpoint
CREATE TABLE `transcripts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`bullet_id` text NOT NULL,
	`attachment_id` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`engine` text NOT NULL,
	`model` text,
	`languages` text NOT NULL,
	`transcribed_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bullet_id`) REFERENCES `bullets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attachment_id`) REFERENCES `audio_attachments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `transcripts_attachment_idx` ON `transcripts` (`attachment_id`);--> statement-breakpoint
ALTER TABLE `bullets` ADD `text_edited_by_user` integer DEFAULT false NOT NULL;