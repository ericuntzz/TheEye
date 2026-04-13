CREATE TABLE "property_vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"name" varchar NOT NULL,
	"category" varchar NOT NULL,
	"email" varchar,
	"phone" varchar,
	"notes" text,
	"is_preferred" boolean DEFAULT false,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "property_vendors" ADD CONSTRAINT "property_vendors_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_property_vendors_property" ON "property_vendors" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "idx_property_vendors_category" ON "property_vendors" USING btree ("category");