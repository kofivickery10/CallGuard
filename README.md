# CallGuard

AI-powered QA platform for call centers. Automatically transcribes and scores calls against predefined scorecards.

## Setup

```bash
# Install dependencies
npm install

# Copy environment config
cp .env.example .env
# Fill in your API keys in .env

# Run database migrations
npm run migrate

# Start development
npm run dev:api     # API server on :3001
npm run dev:worker  # Background job worker
npm run dev:web     # React frontend on :5173
```

## Production (PM2)

```bash
npm run build
pm2 start ecosystem.config.js
```

## Tech Stack

- **Frontend:** React + Vite + TypeScript + Tailwind + Shadcn/UI
- **Backend:** Node.js + Express + TypeScript
- **Database:** PostgreSQL
- **Queue:** BullMQ + Redis
- **Storage:** AWS S3
- **AI:** Deepgram (transcription) + Claude (scoring)
