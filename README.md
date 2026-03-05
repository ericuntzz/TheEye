# The Eye

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

# Start both services
npm run dev:all
```

- Next.js app: http://localhost:3000
- Vision service: http://localhost:8000
- Vision API docs: http://localhost:8000/docs

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
