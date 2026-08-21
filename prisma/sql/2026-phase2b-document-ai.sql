-- Phase 2B Document AI — additive only (SQLite). Applied via prisma db push.
-- Do not use migrate reset.

CREATE TABLE IF NOT EXISTS "ai_document_jobs" (
    "job_id" TEXT NOT NULL PRIMARY KEY,
    "document_source" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "carrier_id" TEXT,
    "shipment_lead_id" TEXT,
    "actor_user_id" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "declared_doc_type" TEXT,
    "classified_doc_type" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "provider_model" TEXT,
    "cached_from_job_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" DATETIME,
    "completed_at" DATETIME,
    CONSTRAINT "ai_document_jobs_actor_user_id_fkey"
      FOREIGN KEY ("actor_user_id") REFERENCES "users" ("user_id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ai_document_jobs_document_id_idx" ON "ai_document_jobs"("document_id");
CREATE INDEX IF NOT EXISTS "ai_document_jobs_checksum_idx" ON "ai_document_jobs"("checksum");
CREATE INDEX IF NOT EXISTS "ai_document_jobs_status_idx" ON "ai_document_jobs"("status");
CREATE INDEX IF NOT EXISTS "ai_document_jobs_actor_user_id_idx" ON "ai_document_jobs"("actor_user_id");
CREATE INDEX IF NOT EXISTS "ai_document_jobs_created_at_idx" ON "ai_document_jobs"("created_at");
CREATE INDEX IF NOT EXISTS "ai_document_jobs_carrier_id_idx" ON "ai_document_jobs"("carrier_id");
CREATE INDEX IF NOT EXISTS "ai_document_jobs_shipment_lead_id_idx" ON "ai_document_jobs"("shipment_lead_id");

CREATE TABLE IF NOT EXISTS "ai_document_extractions" (
    "extraction_id" TEXT NOT NULL PRIMARY KEY,
    "job_id" TEXT NOT NULL,
    "document_type" TEXT NOT NULL,
    "page_count" INTEGER,
    "text_char_count" INTEGER,
    "overall_confidence" REAL,
    "signatures_json" TEXT,
    "meta_json" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_document_extractions_job_id_fkey"
      FOREIGN KEY ("job_id") REFERENCES "ai_document_jobs" ("job_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "ai_document_extractions_job_id_key" ON "ai_document_extractions"("job_id");
CREATE INDEX IF NOT EXISTS "ai_document_extractions_document_type_idx" ON "ai_document_extractions"("document_type");

CREATE TABLE IF NOT EXISTS "document_extraction_fields" (
    "field_id" TEXT NOT NULL PRIMARY KEY,
    "extraction_id" TEXT NOT NULL,
    "field_key" TEXT NOT NULL,
    "value_text" TEXT,
    "value_normalized" TEXT,
    "value_protected" TEXT,
    "confidence" REAL,
    "page" INTEGER,
    "source" TEXT,
    "method" TEXT,
    "field_status" TEXT NOT NULL DEFAULT 'FIELD_FOUND',
    CONSTRAINT "document_extraction_fields_extraction_id_fkey"
      FOREIGN KEY ("extraction_id") REFERENCES "ai_document_extractions" ("extraction_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "document_extraction_fields_extraction_id_idx" ON "document_extraction_fields"("extraction_id");
CREATE INDEX IF NOT EXISTS "document_extraction_fields_field_key_idx" ON "document_extraction_fields"("field_key");

CREATE TABLE IF NOT EXISTS "document_validation_results" (
    "validation_id" TEXT NOT NULL PRIMARY KEY,
    "job_id" TEXT NOT NULL,
    "overall_status" TEXT NOT NULL,
    "traffic_light" TEXT NOT NULL,
    "levels_json" TEXT,
    "checks_json" TEXT,
    "matches_json" TEXT,
    "warnings_json" TEXT,
    "errors_json" TEXT,
    "requires_review" BOOLEAN NOT NULL DEFAULT false,
    "reviewer_user_id" TEXT,
    "reviewed_at" DATETIME,
    "review_decision" TEXT,
    "review_notes" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "document_validation_results_job_id_fkey"
      FOREIGN KEY ("job_id") REFERENCES "ai_document_jobs" ("job_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "document_validation_results_job_id_key" ON "document_validation_results"("job_id");
CREATE INDEX IF NOT EXISTS "document_validation_results_overall_status_idx" ON "document_validation_results"("overall_status");
CREATE INDEX IF NOT EXISTS "document_validation_results_requires_review_idx" ON "document_validation_results"("requires_review");
