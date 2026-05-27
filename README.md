# RoastMyResume

AI-powered resume feedback that doesn't sugarcoat.

## Deploy to Vercel

1. Import this folder into Vercel (drag & drop or GitHub)
2. Add environment variable: `VITE_GROQ_API_KEY` = your Groq API key
3. Build settings are auto-detected via `vercel.json`
4. Click Deploy

## Run locally

```bash
npm install
# Create .env from .env.example and add your Groq API key
cp .env.example .env
npm run dev
```

## Get a free Groq API key

https://console.groq.com — free tier is more than enough for this app.
