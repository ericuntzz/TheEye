ALTER TABLE "inspection_results" ALTER COLUMN "baseline_image_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "inspection_results" ALTER COLUMN "current_image_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "inspection_results" ADD COLUMN "is_room_anchor" boolean DEFAULT false;