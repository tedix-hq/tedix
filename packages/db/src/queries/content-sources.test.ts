import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	listContentSourceDocumentsByObjectKeys,
	updateContentSourceDocumentProjection,
	upsertContentSourceDocument,
} from "./content-sources";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE content_source_documents (
			id TEXT PRIMARY KEY,
			app_id TEXT NOT NULL,
			source_id TEXT,
			canonical_url TEXT NOT NULL,
			source_revision TEXT NOT NULL,
			visibility TEXT NOT NULL,
			object_key TEXT NOT NULL,
			digest TEXT NOT NULL,
			title TEXT NOT NULL,
			content_type TEXT NOT NULL,
			ai_search_item_id TEXT,
			ai_search_status TEXT DEFAULT 'pending' NOT NULL,
			ai_search_error TEXT,
			created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
			updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
		);
		CREATE UNIQUE INDEX uq_content_source_documents_app_url
			ON content_source_documents (app_id, canonical_url);
		CREATE UNIQUE INDEX uq_content_source_documents_app_object
			ON content_source_documents (app_id, object_key);
	`);
	return createDbClient(createD1Facade(sqlite));
}

describe("content source document projections", () => {
	it("upserts canonical state and resets a changed document for projection", async () => {
		const db = fixture();
		const base = {
			id: "doc-1",
			appId: "app-1",
			sourceId: null,
			canonicalUrl: "https://example.com/exact-page",
			sourceRevision: "sha256:first",
			visibility: "private" as const,
			objectKey: "app/sources/ingest/one.md",
			digest: "first",
			title: "First",
			contentType: "docs",
		};

		const inserted = await upsertContentSourceDocument(db, base);
		await updateContentSourceDocumentProjection(db, inserted.id, {
			aiSearchItemId: "item-1",
			aiSearchStatus: "completed",
		});
		const updated = await upsertContentSourceDocument(db, {
			...base,
			id: "ignored-on-conflict",
			sourceRevision: "sha256:second",
			digest: "second",
			title: "Second",
		});

		expect(updated).toMatchObject({
			id: "doc-1",
			digest: "second",
			title: "Second",
			aiSearchItemId: null,
			aiSearchStatus: "pending",
			aiSearchError: null,
		});

		await upsertContentSourceDocument(db, {
			...base,
			id: "doc-other-app",
			appId: "app-2",
		});
		await expect(
			listContentSourceDocumentsByObjectKeys(db, "app-1", [
				"app/sources/ingest/one.md",
			]),
		).resolves.toHaveLength(1);
	});
});
