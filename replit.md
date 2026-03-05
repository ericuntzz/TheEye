# The Eye

AI-Powered Visual Intelligence for Luxury Property Management.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15.3, React 19, Tailwind CSS 4, Radix UI |
| Auth | Supabase Auth |
| Database | PostgreSQL (Replit) + Drizzle ORM |
| Vision AI | Claude Vision API (Python FastAPI service) |
| Deployment | Replit (autoscale) |

## Project Structure

```
├── src/
│   ├── app/                    # Next.js App Router
│   │   ├── api/                # API routes (auth callback, health, vision)
│   │   ├── dashboard/          # Dashboard page
│   │   ├── login/              # Login page
│   │   ├── layout.tsx          # Root layout
│   │   └── page.tsx            # Home page (redirects to login)
│   ├── components/
│   │   ├── dashboard/          # Dashboard components
│   │   ├── ui/                 # Radix UI components (button, card, dialog, etc.)
│   │   └── providers.tsx       # React Query provider
│   ├── lib/
│   │   ├── supabase/           # Supabase client/server/middleware
│   │   └── query-client.ts     # React Query configuration
│   ├── styles/globals.css      # Tailwind CSS + custom theme
│   └── middleware.ts           # Auth middleware
├── server/
│   ├── db.ts                   # Drizzle database connection
│   └── schema.ts              # Database schema (users, properties, rooms, inspections)
├── vision-service/             # Python FastAPI service
│   ├── main.py                 # FastAPI app entry point
│   ├── requirements.txt        # Python dependencies
│   ├── routers/compare.py      # Vision comparison endpoints
│   └── services/claude_vision.py  # Claude Vision API integration
├── next.config.ts              # Next.js configuration
├── drizzle.config.ts           # Drizzle ORM configuration
├── tsconfig.json               # TypeScript configuration
└── postcss.config.mjs          # PostCSS + Tailwind config
```

## Development

- **Frontend**: Next.js with Turbopack on port 5000 (`npm run dev`)
- **Vision Service**: Python FastAPI on port 8000 (uvicorn)
- **Database**: Replit PostgreSQL, schema managed via Drizzle ORM
- **Schema push**: `npx drizzle-kit push`

## Environment Variables

- `DATABASE_URL` — PostgreSQL connection (auto-set by Replit)
- `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase anon key
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service role key
- `ANTHROPIC_API_KEY` — Claude Vision API key
- `VISION_SERVICE_URL` — Vision service URL (http://localhost:8000)

## Database Schema

- **users** — App users (linked to Supabase auth)
- **properties** — Luxury properties
- **rooms** — Rooms within properties
- **baseline_images** — Reference images for each room
- **inspections** — Property inspection records
- **inspection_results** — Per-room inspection results with AI analysis

## Deployment

- Target: autoscale
- Build: `npm run build`
- Run: `npm run start`

## Important Notes

- Tailwind CSS v4 uses `source(none)` directive in globals.css to prevent generating CSS with unresolvable `url()` references (Turbopack compatibility fix)
- The database driver uses `drizzle-orm/node-postgres` (pg) instead of `@neondatabase/serverless` for Replit PostgreSQL compatibility
