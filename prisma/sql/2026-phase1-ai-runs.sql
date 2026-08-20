-- Phase 1 — additive only. Safe for SQLite production.
-- Applied via: npx prisma db push (deploy script). Do not use migrate reset.

CREATE TABLE IF NOT EXISTS "ai_runs" (
    "run_id" TEXT NOT NULL PRIMARY KEY,
    "actor_user_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "request_preview" TEXT NOT NULL,
    "intent" TEXT,
    "answer_mode" TEXT,
    "tools_json" TEXT,
    "sources_json" TEXT,
    "prompt_tokens" INTEGER,
    "completion_tokens" INTEGER,
    "total_tokens" INTEGER,
    "estimated_cost_usd" REAL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error_message" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" DATETIME,
    CONSTRAINT "ai_runs_actor_user_id_fkey"
      FOREIGN KEY ("actor_user_id") REFERENCES "users" ("user_id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ai_runs_actor_user_id_idx" ON "ai_runs"("actor_user_id");
CREATE INDEX IF NOT EXISTS "ai_runs_created_at_idx" ON "ai_runs"("created_at");
CREATE INDEX IF NOT EXISTS "ai_runs_status_idx" ON "ai_runs"("status");
