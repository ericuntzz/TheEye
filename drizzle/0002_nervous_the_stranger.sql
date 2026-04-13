CREATE TABLE "finding_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"inspection_id" uuid,
	"room_id" uuid,
	"baseline_image_id" uuid,
	"finding_fingerprint" text NOT NULL,
	"finding_description" text NOT NULL,
	"finding_category" varchar,
	"finding_severity" varchar,
	"action" varchar NOT NULL,
	"dismiss_reason" varchar,
	"dismiss_count" integer DEFAULT 1,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "property_supply_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"room_id" uuid,
	"name" varchar NOT NULL,
	"category" varchar NOT NULL,
	"amazon_asin" varchar,
	"amazon_url" text,
	"default_quantity" integer DEFAULT 1 NOT NULL,
	"par_level" integer,
	"current_stock" integer,
	"unit" varchar DEFAULT 'each',
	"vendor" varchar,
	"notes" text,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "restock_order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"supply_item_id" uuid,
	"name" varchar NOT NULL,
	"amazon_asin" varchar,
	"quantity" integer DEFAULT 1 NOT NULL,
	"room_name" varchar,
	"source" varchar DEFAULT 'manual' NOT NULL,
	"status" varchar DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "restock_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"inspection_id" uuid,
	"user_id" uuid,
	"status" varchar DEFAULT 'draft' NOT NULL,
	"amazon_cart_url" text,
	"total_items" integer DEFAULT 0,
	"notes" text,
	"confirmed_at" timestamp,
	"ordered_at" timestamp,
	"delivered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inspections" ADD COLUMN "effective_coverage" jsonb;--> statement-breakpoint
ALTER TABLE "finding_feedback" ADD CONSTRAINT "finding_feedback_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_feedback" ADD CONSTRAINT "finding_feedback_inspection_id_inspections_id_fk" FOREIGN KEY ("inspection_id") REFERENCES "public"."inspections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_supply_items" ADD CONSTRAINT "property_supply_items_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_supply_items" ADD CONSTRAINT "property_supply_items_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restock_order_items" ADD CONSTRAINT "restock_order_items_order_id_restock_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."restock_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restock_order_items" ADD CONSTRAINT "restock_order_items_supply_item_id_property_supply_items_id_fk" FOREIGN KEY ("supply_item_id") REFERENCES "public"."property_supply_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restock_orders" ADD CONSTRAINT "restock_orders_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restock_orders" ADD CONSTRAINT "restock_orders_inspection_id_inspections_id_fk" FOREIGN KEY ("inspection_id") REFERENCES "public"."inspections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restock_orders" ADD CONSTRAINT "restock_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_finding_feedback_property" ON "finding_feedback" USING btree ("property_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_finding_feedback_unique_fingerprint" ON "finding_feedback" USING btree ("property_id","finding_fingerprint");--> statement-breakpoint
CREATE INDEX "idx_supply_items_property" ON "property_supply_items" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "idx_supply_items_category" ON "property_supply_items" USING btree ("property_id","category");--> statement-breakpoint
CREATE INDEX "idx_restock_order_items_order" ON "restock_order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "idx_restock_orders_property" ON "restock_orders" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "idx_restock_orders_status" ON "restock_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_restock_orders_inspection" ON "restock_orders" USING btree ("inspection_id");