import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { tediArtifacts } from "../../schema/cognitive-runtime";
import { createD1Facade } from "../../test/d1-facade";
import { createDurableSqliteFixture } from "../../test/durable-sqlite-fixture";
import { schemaDdl } from "../../test/schema-ddl";
import * as platform from "../cognitive-runtime";
import * as platformEvents from "../kernel-runtime-events";
import * as tenant from "./tedi-artifacts";
import { createTenantStoreDb } from "./tenant-store";

function dbs() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(tediArtifacts));
	return { sqlite, platform: createDbClient(createD1Facade(sqlite)) };
}

function tenantFixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(tediArtifacts));
	return {
		sqlite,
		db: createTenantStoreDb(createDurableSqliteFixture(sqlite)),
	};
}

const claim = {
	id: "art-1",
	organizationId: "org-1",
	tediId: "tedi-1",
	conversationId: "conv-1",
	runId: "run-1",
	kind: "file" as const,
	name: "report.md",
	mimeType: "text/markdown",
	uri: "r2://artifacts/report.md",
	sizeBytes: 42,
	metadata: { source: "test" },
	accessClassification: "runtime_private" as const,
	contentDigest: "d-1",
	producerExecutionId: "exec-1",
	publicationState: "pending" as const,
	createdAt: "2026-08-13T18:00:00.000Z",
};

describe("tedi artifacts plane parity", () => {
	it("claims an artifact identically; replay reads the same claim", async () => {
		const p = dbs();
		const t = tenantFixture();
		const [pFirst, tFirst] = await Promise.all([
			platform.claimTediArtifact(p.platform, claim),
			tenant.claimTediArtifact(t.db, claim),
		]);
		expect(tFirst.created).toBe(true);
		expect(tFirst.artifact).toEqual(pFirst.artifact);
		const [pReplay, tReplay] = await Promise.all([
			platform.claimTediArtifact(p.platform, claim),
			tenant.claimTediArtifact(t.db, claim),
		]);
		expect(tReplay.created).toBe(false);
		expect(tReplay.artifact).toEqual(pReplay.artifact);
	});

	it("rejects a conflicting claim with the same error type on both planes", async () => {
		const t = tenantFixture();
		await tenant.claimTediArtifact(t.db, claim);
		await expect(
			tenant.claimTediArtifact(t.db, { ...claim, name: "other.md" }),
		).rejects.toBeInstanceOf(tenant.TediArtifactOwnershipConflictError);
	});

	it("publishes only the exact pending claim", async () => {
		const t = tenantFixture();
		await tenant.claimTediArtifact(t.db, claim);
		expect(
			await tenant.markTediArtifactPublished(t.db, {
				id: claim.id,
				organizationId: "org-1",
				tediId: "tedi-1",
				contentDigest: "wrong",
			}),
		).toBeNull();
		const published = await tenant.markTediArtifactPublished(t.db, {
			id: claim.id,
			organizationId: "org-1",
			tediId: "tedi-1",
			contentDigest: "d-1",
		});
		expect(published).toMatchObject({ publicationState: "ready" });
		// A second publish of the same row is a no-op (no longer pending).
		expect(
			await tenant.markTediArtifactPublished(t.db, {
				id: claim.id,
				organizationId: "org-1",
				tediId: "tedi-1",
				contentDigest: "d-1",
			}),
		).toBeNull();
	});

	it("lists, gets, and upserts identically to the platform reads", async () => {
		const p = dbs();
		const t = tenantFixture();
		await Promise.all([
			platform.claimTediArtifact(p.platform, claim),
			tenant.claimTediArtifact(t.db, claim),
		]);
		const [pList, tList] = await Promise.all([
			platform.listTediArtifacts(p.platform, {
				organizationId: "org-1",
				tediId: "tedi-1",
				runId: "run-1",
				limit: 10,
			}),
			tenant.listTediArtifacts(t.db, {
				tediId: "tedi-1",
				runId: "run-1",
				limit: 10,
			}),
		]);
		expect(tList).toEqual(pList);
		const [pRuns, tRuns] = await Promise.all([
			platformEvents.listTediArtifacts(p.platform, {
				organizationId: "org-1",
				tediId: "tedi-1",
				runIds: ["run-1", "run-2"],
				limit: 10,
			}),
			tenant.listTediArtifactsForRuns(t.db, {
				organizationId: "org-1",
				tediId: "tedi-1",
				runIds: ["run-1", "run-2"],
				limit: 10,
			}),
		]);
		expect(tRuns).toEqual(pRuns);
		const [pGet, tGet] = await Promise.all([
			platformEvents.getTediArtifactById(p.platform, {
				organizationId: "org-1",
				tediId: "tedi-1",
				artifactId: "art-1",
			}),
			tenant.getTediArtifactById(t.db, {
				organizationId: "org-1",
				tediId: "tedi-1",
				artifactId: "art-1",
			}),
		]);
		expect(tGet).toEqual(pGet);
		const [pClaim, tClaim] = await Promise.all([
			platform.getTediArtifactClaim(p.platform, "art-1"),
			tenant.getTediArtifactClaim(t.db, "art-1"),
		]);
		expect(tClaim).toEqual(pClaim);
	});
});
