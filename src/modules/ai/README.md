# GreenOS AI Assistant

Uses OpenAI Chat Completions.

## Env (server `.env`)

```
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-5.5
```

Restart PM2 / Node after changing `.env`.

## API

```
GET  /api/ai/status
POST /api/ai/chat   { "message": "...", "history": [{ "role":"user"|"assistant", "content":"..." }] }
```

UI: GreenOS shell → AI Assistant (or 🤖 in the top bar).
