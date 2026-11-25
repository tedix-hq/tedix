-- SQLite rowid orders release receipts sharing a second-resolution timestamp.
-- Keep an insertion-order tie-breaker without exposing it in the registry API.
ALTER TABLE "docs_releases"
	ADD COLUMN "release_order" bigint GENERATED ALWAYS AS IDENTITY;

-- The guarded UPDATE compares this source-row marker after any row-lock wait.
-- A correlated latest-receipt read alone does not refresh its MVCC snapshot.
ALTER TABLE "docs_sites" ADD COLUMN "active_release_id" text;
UPDATE "docs_sites" AS site
SET "active_release_id" = (
	SELECT release.id FROM "docs_releases" AS release
	WHERE release.site_id = site.id
	ORDER BY release.created_at DESC, release.release_order DESC
	LIMIT 1
);
