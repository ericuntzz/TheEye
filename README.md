# Atria

AI-Powered Visual Intelligence for Luxury Property Management.

## Architecture

```
Next.js (TypeScript)          Python FastAPI
├── Frontend (App Router)     ├── Claude Vision API
├── Supabase Auth             ├── Image Processing
├── BFF API Routes            └── Custom ML Models (Phase 2)
└── Dashboard UI
         │                           │
         └───── PostgreSQL ──────────┘
               (Drizzle ORM)
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15, React 19, Tailwind CSS 4, Radix UI |
| Auth | Supabase Auth |
| Database | PostgreSQL + Drizzle ORM |
| Vision AI | Claude Vision API (Python FastAPI service) |
| Deployment | Replit |

## Getting Started

### Prerequisites
- Node.js 20+
- Python 3.11+
- PostgreSQL database (Neon recommended)
- Supabase project (for auth)
- Anthropic API key

### Environment Variables
Copy `.env.example` to `.env` and fill in your values.

### Development

```bash
# Install dependencies
npm install
cd vision-service && pip install -r requirements.txt && cd ..

# Push database schema
npm run db:push

# If db:push hangs on schema introspection in an existing database,
# baseline migration history and use migrate instead
npm run db:baseline
npx drizzle-kit migrate --config drizzle.config.ts

# Start web + Expo together
npm run dev:full
```

- Next.js app: http://localhost:3000
- Vision service: http://localhost:8000
- Vision API docs: http://localhost:8000/docs

### Phone Testing (Expo)

```bash
# Recommended: auto-detect LAN IP and start API + Expo together
npm run dev:phone
```

Useful variants:

```bash
# Use Expo tunnel (if LAN mode is blocked by network policy)
npm run dev:phone:tunnel

# Clear Metro cache when stale bundles persist
npm run dev:phone:clear

# Use Expo Go instead of custom dev client
npm run dev:phone:go
```

Notes:
- `dev:phone` sets `EXPO_PUBLIC_API_URL` to `http://<your-lan-ip>:<api-port>` automatically.
- If default ports are occupied, the launcher automatically picks the next free API/Expo ports and prints them.
- On a physical phone, `localhost` and `127.0.0.1` point to the phone itself, not your Mac.
- Verify backend reachability from your phone via the printed `Health check URL` in terminal.
- If the app shows `Expected MIME-Type ... got text/html`, reopen the latest Expo QR/deep-link and run `npm run dev:phone:clear` to clear stale Metro bundle references.

## Project Structure

```
├── src/                    # Next.js frontend
│   ├── app/               # App Router pages & API routes
│   ├── components/        # React components
│   ├── hooks/             # Custom hooks
│   ├── lib/               # Utilities & Supabase clients
│   └── styles/            # Global CSS
├── server/                # Shared server code
│   ├── schema.ts          # Drizzle ORM schema
│   └── db.ts              # Database connection
├── vision-service/        # Python FastAPI
│   ├── main.py            # FastAPI app
│   ├── routers/           # API endpoints
│   └── services/          # Vision AI logic
└── drizzle/               # Database migrations
```
