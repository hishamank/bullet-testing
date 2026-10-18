CREATE TABLE `audio_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`bullet_id` text NOT NULL,
	`mime_type` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text,
	`local_path` text,
	`received_bytes` integer DEFAULT 0 NOT NULL,
	`upload_status` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audio_bullet_idx` ON `audio_attachments` (`bullet_id`);--> statement-breakpoint
CREATE TABLE `transcripts` (
	`id` text PRIMARY KEY NOT NULL,
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
	`transcribed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `transcripts_bullet_idx` ON `transcripts` (`bullet_id`);--> statement-breakpoint
ALTER TABLE `bullets` ADD `text_edited_by_user` integer DEFAULT false NOT NULL;