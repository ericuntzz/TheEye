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
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type Property = typeof properties.$inferSelect;
export type InsertProperty = typeof properties.$inferInsert;

// ============================================================================
// Rooms (per property)
// ============================================================================

export const rooms = pgTable("rooms", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  propertyId: uuid("property_id")
    .references(() => properties.id, { onDelete: "cascade" })
    .notNull(),
  name: varchar("name").notNull(), // "Master Bedroom", "Kitchen", etc.
  description: text("description"),
  sortOrder: integer("sort_order").default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export type Room = typeof rooms.$inferSelect;
export type InsertRoom = typeof rooms.$inferInsert;

// ============================================================================
// Baseline Images (the "perfect" state of each room)
// ============================================================================

export const baselineImages = pgTable("baseline_images", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  roomId: uuid("room_id")
    .references(() => rooms.id, { onDelete: "cascade" })
    .notNull(),
  imageUrl: text("image_url").notNull(),
  label: varchar("label"), // "wide angle", "bathroom counter", etc.
  notes: text("notes"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export type BaselineImage = typeof baselineImages.$inferSelect;
export type InsertBaselineImage = typeof baselineImages.$inferInsert;

// ============================================================================
// Inspections
// ============================================================================

export const inspections = pgTable("inspections", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  propertyId: uuid("property_id")
    .references(() => properties.id)
    .notNull(),
  inspectorId: uuid("inspector_id")
    .references(() => users.id)
    .notNull(),
  status: varchar("status").default("in_progress"), // in_progress, completed, reviewed
  readinessScore: real("readiness_score"), // 0-100
  notes: text("notes"),
  startedAt: timestamp("started_at").defaultNow(),
  completedAt: timestamp("completed_at"),
});

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
    .references(() => rooms.id)
    .notNull(),
  baselineImageId: uuid("baseline_image_id")
    .references(() => baselineImages.id)
    .notNull(),
  currentImageUrl: text("current_image_url").notNull(),
  status: varchar("status").default("pending"), // pending, passed, flagged
  score: real("score"), // 0-100 for this room
  findings: jsonb("findings").$type<Finding[]>(),
  rawResponse: text("raw_response"), // Full AI response for debugging
  createdAt: timestamp("created_at").defaultNow(),
});

export type InspectionResult = typeof inspectionResults.$inferSelect;
export type InsertInspectionResult = typeof inspectionResults.$inferInsert;

// ============================================================================
// Types
// ============================================================================

export interface Finding {
  category: "missing" | "moved" | "cleanliness" | "damage" | "inventory";
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  confidence: number; // 0-1
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
}));

export const roomsRelations = relations(rooms, ({ one, many }) => ({
  property: one(properties, {
    fields: [rooms.propertyId],
    references: [properties.id],
  }),
  baselineImages: many(baselineImages),
}));

export const baselineImagesRelations = relations(baselineImages, ({ one }) => ({
  room: one(rooms, {
    fields: [baselineImages.roomId],
    references: [rooms.id],
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
