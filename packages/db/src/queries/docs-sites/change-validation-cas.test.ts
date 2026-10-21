import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import {
	type DocsBuild,
	docsBuilds,
	docsChanges,
	docsSites,
} from "../../schema/docs-sites";
import { organizations } from "../../schema/organizations";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { getDocsChange, syncDocsChangeValidation } from "./changes";

async function setup(
	buildStatus: DocsBuild["status"] = "complete",
	buildSiteId = "site-1",
) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(organizations, docsSites, docsBuilds, docsChanges));
	let beforeUpdate: (() => void) | undefined;
	const db = createDbQueryClient(
		createD1Facade(sqlite, {
			onPrepare(query) {
				if (!query.startsWith('update "docs_changes"')) return;
				const hook = beforeUpdate;
				beforeUpdate = undefined;
				hook?.();
			},
		}),
	);
	await db.insert(organizations).values({
		id: "org-docs",
		name: "Docs Org",
		slug: "docs-org",
		descopeTenantId: "org_docs",
	});
	for (const id of ["site-1", "site-2"]) {
		await db.insert(docsSites).values({
			id,
			orgSlug: "docs-org",
			slug: id,
			title: "Example Docs",
			description: "Reference",
			canonicalUrl: `https://${id}.docs.example`,
			sourceProvider: "generic",
		});
	}
	await db.insert(docsBuilds).values([
		{ id: "build-a", siteId: buildSiteId, status: buildStatus },
		{ id: "build-b", siteId: "site-1", status: "queued" },
	]);
	await db.insert(docsChanges).values({
		id: "change-1",
		siteId: "site-1",
		status: "validating",
		previewBuildId: "build-a",
		path: "docs/index.md",
		message: "Clarify introduction",
		baseRevision: "base",
		proposalBranch: "proposal/change-1",
		proposalRevision: "proposal",
		contentSha256: "content-hash",
		proposedByType: "external_agent",
		proposedById: "example-agent",
		updatedAt: "2026-01-01 00:00:00",
	});
	const change = await getDocsChange(db, "change-1");
	assert.ok(change);
	return {
		db,
		sqlite,
		change,
		race(hook: () => void) {
			beforeUpdate = hook;
		},
	};
}

describe("documentation change validation CAS", () => {
	for (const [buildStatus, expected] of [
		["complete", "validated"],
		["failed", "rejected"],
	] as const) {
		it(`transitions a ${buildStatus} preview to ${expected}`, async () => {
			const { db, sqlite, change } = await setup(buildStatus);
			try {
				const result = await syncDocsChangeValidation(db, change);
				assert.equal(result.status, expected);
				assert.equal(result.previewBuildId, "build-a");
				assert.deepEqual(await getDocsChange(db, change.id), result);
				assert.deepEqual(await syncDocsChangeValidation(db, change), result);
			} finally {
				sqlite.close();
			}
		});

		it(`ignores a ${buildStatus} build belonging to another site`, async () => {
			const { db, sqlite, change } = await setup(buildStatus, "site-2");
			try {
				assert.deepEqual(await syncDocsChangeValidation(db, change), change);
				assert.deepEqual(await getDocsChange(db, change.id), change);
			} finally {
				sqlite.close();
			}
		});

		it(`does not apply build A's ${buildStatus} result to replacement B`, async () => {
			const context = await setup(buildStatus);
			const { db, sqlite, change } = context;
			let raced = false;
			context.race(() => {
				raced = true;
				sqlite.exec(
					"UPDATE docs_changes SET preview_build_id = 'build-b', updated_at = 'replacement' WHERE id = 'change-1'",
				);
			});
			try {
				const result = await syncDocsChangeValidation(db, change);
				assert.ok(raced);
				assert.equal(result.status, "validating");
				assert.equal(result.previewBuildId, "build-b");
				assert.equal(result.updatedAt, "replacement");
				assert.deepEqual(await getDocsChange(db, change.id), result);
			} finally {
				sqlite.close();
			}
		});

		for (const terminal of ["committed", "rejected"] as const) {
			it(`preserves concurrent ${terminal} against a ${buildStatus} result`, async () => {
				const context = await setup(buildStatus);
				const { db, sqlite, change } = context;
				let raced = false;
				context.race(() => {
					raced = true;
					sqlite
						.prepare(
							"UPDATE docs_changes SET status = ?, committed_revision = 'winner', updated_at = 'terminal' WHERE id = 'change-1'",
						)
						.run(terminal);
				});
				try {
					const result = await syncDocsChangeValidation(db, change);
					assert.ok(raced);
					assert.equal(result.status, terminal);
					assert.equal(result.committedRevision, "winner");
					assert.equal(result.updatedAt, "terminal");
					assert.deepEqual(await getDocsChange(db, change.id), result);
				} finally {
					sqlite.close();
				}
			});
		}
	}

	for (const status of [
		"queued",
		"running",
		"missing",
		"no-preview",
	] as const) {
		it(`leaves a ${status} preview unchanged`, async () => {
			const { db, sqlite, change } = await setup(
				status === "running" ? "running" : "queued",
			);
			try {
				if (status === "missing")
					sqlite.exec("DELETE FROM docs_builds WHERE id = 'build-a'");
				if (status === "no-preview")
					sqlite.exec("UPDATE docs_changes SET preview_build_id = NULL");
				const current = await getDocsChange(db, change.id);
				assert.deepEqual(await syncDocsChangeValidation(db, change), current);
				assert.deepEqual(await getDocsChange(db, change.id), current);
			} finally {
				sqlite.close();
			}
		});
	}

	for (const status of [
		"proposed",
		"validated",
		"committed",
		"rejected",
	] as const) {
		it(`returns the fresh ${status} row for stale validating input`, async () => {
			const { db, sqlite, change } = await setup();
			try {
				sqlite.prepare("UPDATE docs_changes SET status = ?").run(status);
				const current = await getDocsChange(db, change.id);
				assert.deepEqual(await syncDocsChangeValidation(db, change), current);
				assert.deepEqual(await getDocsChange(db, change.id), current);
			} finally {
				sqlite.close();
			}
		});
	}

	it("uses the fresh preview and status instead of stale caller fields", async () => {
		const { db, sqlite, change } = await setup();
		try {
			const result = await syncDocsChangeValidation(db, {
				...change,
				status: "committed",
				previewBuildId: "build-b",
			});
			assert.equal(result.status, "validated");
			assert.equal(result.previewBuildId, "build-a");
		} finally {
			sqlite.close();
		}
	});

	it("does not transition a change moved to another site during validation", async () => {
		const context = await setup();
		const { db, sqlite, change } = context;
		let raced = false;
		context.race(() => {
			raced = true;
			sqlite.exec("UPDATE docs_changes SET site_id = 'site-2'");
		});
		try {
			const result = await syncDocsChangeValidation(db, change);
			assert.ok(raced);
			assert.equal(result.status, "validating");
			assert.equal(result.siteId, "site-2");
			assert.deepEqual(await getDocsChange(db, change.id), result);
		} finally {
			sqlite.close();
		}
	});

	it("retains the observed row fallback if the change disappears after the read", async () => {
		const context = await setup();
		const { db, sqlite, change } = context;
		context.race(() => sqlite.exec("DELETE FROM docs_changes"));
		try {
			assert.deepEqual(await syncDocsChangeValidation(db, change), change);
			assert.equal(await getDocsChange(db, change.id), null);
			await assert.rejects(syncDocsChangeValidation(db, change), {
				message: "Documentation change not found",
			});
		} finally {
			sqlite.close();
		}
	});
});
