#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

const expectedTables = [
  "baseline_images",
  "baseline_versions",
  "events",
  "guest_stays",
  "inspection_events",
  "inspection_results",
  "inspections",
  "items",
  "media_uploads",
  "properties",
  "property_conditions",
  "rooms",
  "users",
];

function readJournal(migrationsFolder) {
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  if (!fs.existsSync(journalPath)) {
    throw new Error(`Missing journal file: ${journalPath}`);
  }
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  if (!Array.isArray(journal.entries)) {
    throw new Error("Invalid drizzle journal format: entries[] missing");
  }
  return journal.entries;
}

function computeMigrationHash(migrationsFolder, tag) {
  const sqlPath = path.join(migrationsFolder, `${tag}.sql`);
  if (!fs.existsSync(sqlPath)) {
    throw new Error(`Missing migration SQL file: ${sqlPath}`);
  }
  const sql = fs.readFileSync(sqlPath, "utf8");
  return crypto.createHash("sha256").update(sql).digest("hex");
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }

  const migrationsFolder = path.join(process.cwd(), "drizzle");
  const journalEntries = readJournal(migrationsFolder);
  const sql = postgres(process.env.DATABASE_URL, {
    ssl: "require",
    connect_timeout: 10,
    max: 1,
    onnotice: () => {},
  });

  try {
    await sql`create schema if not exists "drizzle"`;
    await sql.unsafe(`
      create table if not exists "drizzle"."__drizzle_migrations" (
        id serial primary key,
        hash text not null,
        created_at bigint
      )
    `);

    const [{ count: existingMigrationRows }] = await sql.unsafe(
      `select count(*)::int as count from "drizzle"."__drizzle_migrations"`,
    );
    if (existingMigrationRows > 0) {
      console.log(
        `drizzle.__drizzle_migrations already has ${existingMigrationRows} row(s); skipping baseline.`,
      );
      return;
    }

    const publicRows = await sql`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
      order by table_name
    `;
    const existingPublicTables = new Set(publicRows.map((r) => r.table_name));
    const missing = expectedTables.filter((table) => !existingPublicTables.has(table));

    if (missing.length > 0) {
      throw new Error(
        `Refusing to baseline migrations: missing expected public tables: ${missing.join(", ")}`,
      );
    }

    let inserted = 0;
    for (const entry of journalEntries) {
      const hash = computeMigrationHash(migrationsFolder, entry.tag);
      await sql`
        insert into "drizzle"."__drizzle_migrations" ("hash", "created_at")
        values (${hash}, ${entry.when})
      `;
      inserted++;
    }

    console.log(`Baselined ${inserted} migration(s) into drizzle.__drizzle_migrations`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error("[baseline-drizzle] Failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
