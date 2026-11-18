-- Additive Big Problems tables (safe / non-destructive).
-- Prefer `npm run db:push` which applies the Prisma schema; this SQL is a reference for ops.

CREATE TABLE IF NOT EXISTS big_problem_case_counters (
  year INTEGER PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0
);

-- Full DDL is owned by prisma/schema.prisma (SQLite) and schema.postgresql.prisma.
-- Run: npm run db:push
