-- Rollback change capture for the D1 to Postgres switch. Triggers are attached
-- only at switch time by packages/db/scripts/cutover/attach-change-capture.sql,
-- so copy writes made before the switch are never recorded.
CREATE TABLE "cutover_changes" (
	"id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	"table_name" text NOT NULL,
	"operation" text NOT NULL,
	"row" jsonb NOT NULL,
	"changed_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE FUNCTION cutover_capture() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO cutover_changes (table_name, operation, "row")
VALUES (TG_TABLE_NAME, TG_OP, to_jsonb(COALESCE(NEW, OLD)));
RETURN COALESCE(NEW, OLD);
END;
$function$;
