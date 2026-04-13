import { db } from './server/db.js';
import { events } from './server/schema.js';
import { desc, eq, gte, and } from 'drizzle-orm';

async function main() {
  const since = new Date(Date.now() - 8 * 60 * 60 * 1000);
  const rows = await db.select().from(events)
    .where(and(eq(events.eventType, 'TicketCreated'), gte(events.timestamp, since)))
    .orderBy(desc(events.timestamp))
    .limit(20);
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
