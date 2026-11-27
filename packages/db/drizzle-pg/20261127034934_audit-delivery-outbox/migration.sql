CREATE TABLE "audit_delivery_outbox" (
	"id" text PRIMARY KEY,
	"ignore_duplicates" boolean DEFAULT false NOT NULL,
	"organization_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"metadata" jsonb,
	"ip_address" text,
	"user_agent" text,
	"timestamp" timestamp with time zone NOT NULL,
	"trace_id" text
);
--> statement-breakpoint
CREATE TABLE "read_marks" (
	"organization_id" text,
	"kind" text,
	"row_id" text,
	"last_read_on" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "read_marks_pkey" PRIMARY KEY("organization_id","kind","row_id")
);
--> statement-breakpoint
ALTER TABLE "read_marks" ADD CONSTRAINT "read_marks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
