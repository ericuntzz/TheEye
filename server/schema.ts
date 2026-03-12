import { sql, relations } from "drizzle-orm";
import {
  pgTable,
  timestamp,
  varchar,
  text,
  integer,
  boolean,
  jsonb,
  real,
  uuid,
  date,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ============================================================================
// Users
// ============================================================================

export const users = pgTable("users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  supabaseId: varchar("supabase_id").unique().notNull(),
  email: varchar("email").unique().notNull(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  role: varchar("role").default("owner"), // owner, manager, inspector
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ============================================================================
// Properties
// ============================================================================

export const properties = pgTable("properties", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id")
    .references(() => users.id)
    .notNull(),
  name: varchar("name").notNull(),
  address: text("address"),
  city: varchar("city"),
  state: varchar("state"),
  zipCode: varchar("zip_code"),
  propertyType: varchar("property_type"), // house, condo, cabin, etc.
  bedrooms: integer("bedrooms"),
  bathrooms: integer("bathrooms"),
  squareFeet: integer("square_feet"),
  estimatedValue: varchar("estimated_value"),
  notes: text("notes"),
  coverImageUrl: text("cover_image_url"),
  trainingStatus: varchar("training_status").default("untrained"), // untrained, training, trained
  trainingCompletedAt: timestamp("training_completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_properties_user_id").on(table.userId),
]);

export type Property = typeof properties.$inferSelect;
export type InsertProperty = typeof properties.$inferInsert;

// ============================================================================
// Rooms (per property — auto-created by AI during training)
// ============================================================================

export const rooms = pgTable("rooms", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  propertyId: uuid("property_id")
    .references(() => properties.id, { onDelete: "cascade" })
    .notNull(),
  name: varchar("name").notNull(), // "Master Bedroom", "Kitchen", etc.
  description: text("description"),
  roomType: varchar("room_type"), // bedroom, bathroom, kitchen, living, outdoor, garage, etc.
  sortOrder: integer("sort_order").default(0),
  coverImageUrl: text("cover_image_url"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_rooms_property_id").on(table.propertyId),
]);

export type Room = typeof rooms.$inferSelect;
export type InsertRoom = typeof rooms.$inferInsert;

// ============================================================================
// Items (per room — auto-detected by AI during training)
// ============================================================================

export const items = pgTable("items", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  roomId: uuid("room_id")
    .references(() => rooms.id, { onDelete: "cascade" })
    .notNull(),
  name: varchar("name").notNull(), // "Leather Sofa", "Crystal Vase", etc.
  category: varchar("category"), // furniture, decor, appliance, fixture, art, etc.
  description: text("description"),
  condition: varchar("condition").default("good"), // excellent, good, fair, poor
  importance: varchar("importance").default("normal"), // critical, high, normal, low
  imageUrl: text("image_url"), // cropped/reference image of just this item
  metadata: jsonb("metadata").$type<Record<string, string>>(), // AI-detected attributes
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_items_room_id").on(table.roomId),
]);

export type Item = typeof items.$inferSelect;
export type InsertItem = typeof items.$inferInsert;

// ============================================================================
// Baseline Versions (groups of baseline images per property)
// ============================================================================

export const baselineVersions = pgTable("baseline_versions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  propertyId: uuid("property_id")
    .references(() => properties.id, { onDelete: "cascade" })
    .notNull(),
  versionNumber: integer("version_number").notNull(),
  label: text("label"), // "Original", "Post-renovation", "Winter 2025"
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_baseline_versions_property_id").on(table.propertyId),
  uniqueIndex("uq_baseline_versions_property_version").on(table.propertyId, table.versionNumber),
]);

export type BaselineVersion = typeof baselineVersions.$inferSelect;
export type InsertBaselineVersion = typeof baselineVersions.$inferInsert;

// ============================================================================
// Baseline Images (the "perfect" state of each room)
// ============================================================================

export const baselineImages = pgTable("baseline_images", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  roomId: uuid("room_id")
    .references(() => rooms.id, { onDelete: "cascade" })
    .notNull(),
  baselineVersionId: uuid("baseline_version_id")
    .references(() => baselineVersions.id, { onDelete: "cascade" }),
  imageUrl: text("image_url").notNull(),
  label: varchar("label"), // "wide angle", "bathroom counter", "sink area", etc.
  notes: text("notes"),
  isActive: boolean("is_active").default(true),
  embedding: jsonb("embedding").$type<number[]>(), // 512-dim MobileCLIP embedding
  qualityScore: real("quality_score"), // Laplacian variance blur score
  embeddingModelVersion: text("embedding_model_version"), // track which model generated the embedding
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_baseline_images_room_id").on(table.roomId),
  index("idx_baseline_images_version_id").on(table.baselineVersionId),
]);

export type BaselineImage = typeof baselineImages.$inferSelect;
export type InsertBaselineImage = typeof baselineImages.$inferInsert;

// ============================================================================
// Media Uploads (raw uploaded files before AI processing)
// ============================================================================

export const mediaUploads = pgTable("media_uploads", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  propertyId: uuid("property_id")
    .references(() => properties.id, { onDelete: "cascade" })
    .notNull(),
  fileUrl: text("file_url").notNull(),
  fileName: varchar("file_name").notNull(),
  fileType: varchar("file_type").notNull(), // image/jpeg, video/mp4, etc.
  fileSize: integer("file_size"), // bytes
  processingStatus: varchar("processing_status").default("pending"), // pending, processing, completed, failed
  aiAnalysis: jsonb("ai_analysis"), // Raw AI analysis result
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_media_uploads_property_id").on(table.propertyId),
]);

export type MediaUpload = typeof mediaUploads.$inferSelect;
export type InsertMediaUpload = typeof mediaUploads.$inferInsert;

// ============================================================================
// Inspections
// ============================================================================

export const inspections = pgTable("inspections", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  propertyId: uuid("property_id")
    .references(() => properties.id, { onDelete: "cascade" })
    .notNull(),
  inspectorId: uuid("inspector_id")
    .references(() => users.id)
    .notNull(),
  status: varchar("status").default("in_progress"), // in_progress, paused, completed, reviewed
  inspectionMode: varchar("inspection_mode").default("turnover"), // turnover, maintenance, owner_arrival, vacancy_check
  completionTier: varchar("completion_tier"), // minimum, standard, thorough
  readinessScore: real("readiness_score"), // 0-100
  notes: text("notes"),
  startedAt: timestamp("started_at").defaultNow(),
  completedAt: timestamp("completed_at"),
}, (table) => [
  index("idx_inspections_property_id").on(table.propertyId),
  index("idx_inspections_inspector_id").on(table.inspectorId),
]);

export type Inspection = typeof inspections.$inferSelect;
export type InsertInspection = typeof inspections.$inferInsert;

// ============================================================================
// Inspection Results (per room comparison)
// ============================================================================

export const inspectionResults = pgTable("inspection_results", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  inspectionId: uuid("inspection_id")
    .references(() => inspections.id, { onDelete: "cascade" })
    .notNull(),
  roomId: uuid("room_id")
    .references(() => rooms.id, { onDelete: "cascade" })
    .notNull(),
  baselineImageId: uuid("baseline_image_id")
    .references(() => baselineImages.id, { onDelete: "cascade" })
    .notNull(),
  currentImageUrl: text("current_image_url").notNull(),
  status: varchar("status").default("pending"), // pending, passed, flagged
  score: real("score"), // 0-100 for this room
  findings: jsonb("findings").$type<Finding[]>(),
  rawResponse: text("raw_response"), // Full AI response for debugging
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_inspection_results_inspection_id").on(table.inspectionId),
  index("idx_inspection_results_room_id").on(table.roomId),
]);

export type InspectionResult = typeof inspectionResults.$inferSelect;
export type InsertInspectionResult = typeof inspectionResults.$inferInsert;

// ============================================================================
// Inspection Events (comprehensive event logging per inspection)
// ============================================================================

export const inspectionEvents = pgTable("inspection_events", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  inspectionId: uuid("inspection_id")
    .references(() => inspections.id, { onDelete: "cascade" })
    .notNull(),
  eventType: text("event_type").notNull(), // room_entered, angle_scanned, finding_suggested, etc.
  roomId: uuid("room_id"),
  metadata: jsonb("metadata"), // networkState, batteryLevel, thermalState, etc.
  timestamp: timestamp("timestamp").defaultNow().notNull(),
}, (table) => [
  index("idx_inspection_events_inspection_id").on(table.inspectionId),
]);

export type InspectionEvent = typeof inspectionEvents.$inferSelect;
export type InsertInspectionEvent = typeof inspectionEvents.$inferInsert;

// ============================================================================
// Property Conditions (Known Condition Register)
// ============================================================================

export const propertyConditions = pgTable("property_conditions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  propertyId: uuid("property_id")
    .references(() => properties.id, { onDelete: "cascade" })
    .notNull(),
  roomId: uuid("room_id"),
  description: text("description").notNull(),
  category: varchar("category").notNull(), // accepted_wear, deferred_maintenance, owner_approved, known_defect
  severity: varchar("severity"), // cosmetic, maintenance, safety
  imageUrl: text("image_url"),
  reportedAt: timestamp("reported_at").defaultNow().notNull(),
  acknowledgedBy: uuid("acknowledged_by"),
  resolvedAt: timestamp("resolved_at"),
  isActive: boolean("is_active").default(true),
}, (table) => [
  index("idx_property_conditions_property_id").on(table.propertyId),
]);

export type PropertyCondition = typeof propertyConditions.$inferSelect;
export type InsertPropertyCondition = typeof propertyConditions.$inferInsert;

// ============================================================================
// Guest Stays (Guest Stay Timeline for damage attribution)
// ============================================================================

export const guestStays = pgTable("guest_stays", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  propertyId: uuid("property_id")
    .references(() => properties.id, { onDelete: "cascade" })
    .notNull(),
  guestName: text("guest_name"),
  platform: varchar("platform").notNull(), // airbnb, vrbo, direct, owner
  checkIn: date("check_in").notNull(),
  checkOut: date("check_out").notNull(),
  reservationId: text("reservation_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_guest_stays_property_id").on(table.propertyId),
]);

export type GuestStay = typeof guestStays.$inferSelect;
export type InsertGuestStay = typeof guestStays.$inferInsert;

// ============================================================================
// Events (append-only event log — foundation for property memory, attribution, agents)
// ============================================================================

export const events = pgTable("events", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  eventType: text("event_type").notNull(),
  aggregateType: text("aggregate_type").notNull(), // property, inspection, finding, etc.
  aggregateId: uuid("aggregate_id").notNull(),
  propertyId: uuid("property_id"),
  userId: uuid("user_id"),
  payload: jsonb("payload").notNull(),
  metadata: jsonb("metadata"), // context: device, network, app version
  timestamp: timestamp("timestamp").defaultNow().notNull(),
  version: integer("version").notNull().default(1),
}, (table) => [
  index("idx_events_property_id_timestamp").on(table.propertyId, table.timestamp),
  index("idx_events_aggregate_id_version").on(table.aggregateId, table.version),
  index("idx_events_event_type_timestamp").on(table.eventType, table.timestamp),
]);

export type Event = typeof events.$inferSelect;
export type InsertEvent = typeof events.$inferInsert;

// ============================================================================
// Types
// ============================================================================

export interface Finding {
  category:
    | "missing"
    | "moved"
    | "cleanliness"
    | "damage"
    | "inventory"
    | "operational"
    | "safety"
    | "restock"
    | "presentation"
    | "manual_note";
  description: string;
  severity: "cosmetic" | "maintenance" | "safety" | "urgent_repair" | "guest_damage";
  confidence: number; // 0-1
  findingCategory?: "condition" | "presentation" | "restock";
  isClaimable?: boolean;
  objectClass?: "fixed" | "durable_movable" | "decorative" | "consumable";
  id?: string;
  source?: "manual_note" | "ai";
  roomName?: string;
  status?: "suggested" | "confirmed" | "dismissed";
  createdAt?: string;
}

// ============================================================================
// Relations
// ============================================================================

export const usersRelations = relations(users, ({ many }) => ({
  properties: many(properties),
  inspections: many(inspections),
}));

export const propertiesRelations = relations(properties, ({ one, many }) => ({
  owner: one(users, {
    fields: [properties.userId],
    references: [users.id],
  }),
  rooms: many(rooms),
  inspections: many(inspections),
  mediaUploads: many(mediaUploads),
  baselineVersions: many(baselineVersions),
  conditions: many(propertyConditions),
  guestStays: many(guestStays),
}));

export const roomsRelations = relations(rooms, ({ one, many }) => ({
  property: one(properties, {
    fields: [rooms.propertyId],
    references: [properties.id],
  }),
  baselineImages: many(baselineImages),
  items: many(items),
}));

export const itemsRelations = relations(items, ({ one }) => ({
  room: one(rooms, {
    fields: [items.roomId],
    references: [rooms.id],
  }),
}));

export const baselineVersionsRelations = relations(baselineVersions, ({ one, many }) => ({
  property: one(properties, {
    fields: [baselineVersions.propertyId],
    references: [properties.id],
  }),
  baselineImages: many(baselineImages),
}));

export const baselineImagesRelations = relations(baselineImages, ({ one }) => ({
  room: one(rooms, {
    fields: [baselineImages.roomId],
    references: [rooms.id],
  }),
  version: one(baselineVersions, {
    fields: [baselineImages.baselineVersionId],
    references: [baselineVersions.id],
  }),
}));

export const mediaUploadsRelations = relations(mediaUploads, ({ one }) => ({
  property: one(properties, {
    fields: [mediaUploads.propertyId],
    references: [properties.id],
  }),
}));

export const inspectionsRelations = relations(inspections, ({ one, many }) => ({
  property: one(properties, {
    fields: [inspections.propertyId],
    references: [properties.id],
  }),
  inspector: one(users, {
    fields: [inspections.inspectorId],
    references: [users.id],
  }),
  results: many(inspectionResults),
  inspectionEvents: many(inspectionEvents),
}));

export const inspectionResultsRelations = relations(
  inspectionResults,
  ({ one }) => ({
    inspection: one(inspections, {
      fields: [inspectionResults.inspectionId],
      references: [inspections.id],
    }),
    room: one(rooms, {
      fields: [inspectionResults.roomId],
      references: [rooms.id],
    }),
    baselineImage: one(baselineImages, {
      fields: [inspectionResults.baselineImageId],
      references: [baselineImages.id],
    }),
  }),
);

export const inspectionEventsRelations = relations(inspectionEvents, ({ one }) => ({
  inspection: one(inspections, {
    fields: [inspectionEvents.inspectionId],
    references: [inspections.id],
  }),
}));

export const propertyConditionsRelations = relations(propertyConditions, ({ one }) => ({
  property: one(properties, {
    fields: [propertyConditions.propertyId],
    references: [properties.id],
  }),
}));

export const guestStaysRelations = relations(guestStays, ({ one }) => ({
  property: one(properties, {
    fields: [guestStays.propertyId],
    references: [properties.id],
  }),
}));
