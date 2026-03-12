CREATE TABLE "baseline_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"baseline_version_id" uuid,
	"image_url" text NOT NULL,
	"label" varchar,
	"notes" text,
	"is_active" boolean DEFAULT true,
	"embedding" jsonb,
	"quality_score" real,
	"embedding_model_version" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "baseline_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"label" text,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"property_id" uuid,
	"user_id" uuid,
	"payload" jsonb NOT NULL,
	"metadata" jsonb,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guest_stays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"guest_name" text,
	"platform" varchar NOT NULL,
	"check_in" date NOT NULL,
	"check_out" date NOT NULL,
	"reservation_id" text,
	"notes" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "inspection_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inspection_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"room_id" uuid,
	"metadata" jsonb,
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inspection_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inspection_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"baseline_image_id" uuid NOT NULL,
	"current_image_url" text NOT NULL,
	"status" varchar DEFAULT 'pending',
	"score" real,
	"findings" jsonb,
	"raw_response" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "inspections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"inspector_id" uuid NOT NULL,
	"status" varchar DEFAULT 'in_progress',
	"inspection_mode" varchar DEFAULT 'turnover',
	"completion_tier" varchar,
	"readiness_score" real,
	"notes" text,
	"started_at" timestamp DEFAULT now(),
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"name" varchar NOT NULL,
	"category" varchar,
	"description" text,
	"condition" varchar DEFAULT 'good',
	"importance" varchar DEFAULT 'normal',
	"image_url" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "media_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"file_url" text NOT NULL,
	"file_name" varchar NOT NULL,
	"file_type" varchar NOT NULL,
	"file_size" integer,
	"processing_status" varchar DEFAULT 'pending',
	"ai_analysis" jsonb,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar NOT NULL,
	"address" text,
	"city" varchar,
	"state" varchar,
	"zip_code" varchar,
	"property_type" varchar,
	"bedrooms" integer,
	"bathrooms" integer,
	"square_feet" integer,
	"estimated_value" varchar,
	"notes" text,
	"cover_image_url" text,
	"training_status" varchar DEFAULT 'untrained',
	"training_completed_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "property_conditions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"room_id" uuid,
	"description" text NOT NULL,
	"category" varchar NOT NULL,
	"severity" varchar,
	"image_url" text,
	"reported_at" timestamp DEFAULT now() NOT NULL,
	"acknowledged_by" uuid,
	"resolved_at" timestamp,
	"is_active" boolean DEFAULT true
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"name" varchar NOT NULL,
	"description" text,
	"room_type" varchar,
	"sort_order" integer DEFAULT 0,
	"cover_image_url" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supabase_id" varchar NOT NULL,
	"email" varchar NOT NULL,
	"first_name" varchar,
	"last_name" varchar,
	"profile_image_url" varchar,
	"role" varchar DEFAULT 'owner',
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "users_supabase_id_unique" UNIQUE("supabase_id"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "baseline_images" ADD CONSTRAINT "baseline_images_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baseline_images" ADD CONSTRAINT "baseline_images_baseline_version_id_baseline_versions_id_fk" FOREIGN KEY ("baseline_version_id") REFERENCES "public"."baseline_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baseline_versions" ADD CONSTRAINT "baseline_versions_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_stays" ADD CONSTRAINT "guest_stays_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_events" ADD CONSTRAINT "inspection_events_inspection_id_inspections_id_fk" FOREIGN KEY ("inspection_id") REFERENCES "public"."inspections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_results" ADD CONSTRAINT "inspection_results_inspection_id_inspections_id_fk" FOREIGN KEY ("inspection_id") REFERENCES "public"."inspections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_results" ADD CONSTRAINT "inspection_results_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_results" ADD CONSTRAINT "inspection_results_baseline_image_id_baseline_images_id_fk" FOREIGN KEY ("baseline_image_id") REFERENCES "public"."baseline_images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_inspector_id_users_id_fk" FOREIGN KEY ("inspector_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_conditions" ADD CONSTRAINT "property_conditions_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_baseline_images_room_id" ON "baseline_images" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "idx_baseline_images_version_id" ON "baseline_images" USING btree ("baseline_version_id");--> statement-breakpoint
CREATE INDEX "idx_baseline_versions_property_id" ON "baseline_versions" USING btree ("property_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_baseline_versions_property_version" ON "baseline_versions" USING btree ("property_id","version_number");--> statement-breakpoint
CREATE INDEX "idx_events_property_id_timestamp" ON "events" USING btree ("property_id","timestamp");--> statement-breakpoint
CREATE INDEX "idx_events_aggregate_id_version" ON "events" USING btree ("aggregate_id","version");--> statement-breakpoint
CREATE INDEX "idx_events_event_type_timestamp" ON "events" USING btree ("event_type","timestamp");--> statement-breakpoint
CREATE INDEX "idx_guest_stays_property_id" ON "guest_stays" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "idx_inspection_events_inspection_id" ON "inspection_events" USING btree ("inspection_id");--> statement-breakpoint
CREATE INDEX "idx_inspection_results_inspection_id" ON "inspection_results" USING btree ("inspection_id");--> statement-breakpoint
CREATE INDEX "idx_inspection_results_room_id" ON "inspection_results" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "idx_inspections_property_id" ON "inspections" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "idx_inspections_inspector_id" ON "inspections" USING btree ("inspector_id");--> statement-breakpoint
CREATE INDEX "idx_items_room_id" ON "items" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "idx_media_uploads_property_id" ON "media_uploads" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "idx_properties_user_id" ON "properties" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_property_conditions_property_id" ON "property_conditions" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "idx_rooms_property_id" ON "rooms" USING btree ("property_id");