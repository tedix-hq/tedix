import { DatabaseSync } from "node:sqlite";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { skillRuns, skillRunArtifacts } from "../../schema/cognitive";
import { createD1Facade } from "../../test/d1-facade";
import { createDurableSqliteFixture } from "../../test/durable-sqlite-fixture";
import { schemaDdl } from "../../test/schema-ddl";
import * as platform from "../skill-run-artifacts";
import * as tenant from "./skill-run-artifacts";
import { createTenantStoreDb } from "./tenant-store";

function dbs() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(skillRunArtifacts));
	return {
		sqlite,
		platform: createDbClient(createD1Facade(sqlite)),
	};
}

function tenantFixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(skillRunArtifacts));
	return {
		sqlite,
		db: createTenantStoreDb(createDurableSqliteFixture(sqlite)),
	};
}

const artifact = {
	runId: "run-1",
	path: "steps/x:load/attempts/1.json",
	mimeType: "application/json",
	r2Key: "run-1/bodies/a1",
	sizeBytes: 64,
};

/** Artifact reads are run-keyed; the platform seam still requires a tenant scope. */
const scope = { organizationId: "org-1" };

async function body(row: { sha256: string | null } | null) {
	return row;
}

describe("skill-run artifacts plane parity", () => {
	it("records metadata-only rows; upserts rewrite in place identically", async () => {
		const t = tenantFixture();
		const sha = await sha256Hex("v1");
		const created = await tenant.recordRunArtifact(t.db, {
			...artifact,
			sha256: sha,
		});
		expect(created).toMatchObject({
			runId: "run-1",
			path: artifact.path,
			contentInline: null,
			contentR2Key: "run-1/bodies/a1",
			sha256: sha,
			sizeBytes: 64,
			attempt: 1,
			outcome: "success",
		});
		// Upsert over the same (runId, path) rewrites the row in place.
		const sha2 = await sha256Hex("v2");
		const updated = await tenant.recordRunArtifact(t.db, {
			...artifact,
			sha256: sha2,
			sizeBytes: 99,
			outcome: "failure",
		});
		expect(updated.id).toBe(created.id);
		expect(updated).toMatchObject({
			sha256: sha2,
			sizeBytes: 99,
			outcome: "failure",
		});
		expect(
			t.sqlite.prepare("SELECT count(*) AS n FROM skill_run_artifacts").get(),
		).toEqual({ n: 1 });
	});

	it("rejects invalid paths identically to the platform validator", async () => {
		const t = tenantFixture();
		for (const path of [
			"",
			"/abs",
			"../escape",
			"a/../b",
			"x://y",
			"SKILL.md",
		]) {
			await expect(
				tenant.recordRunArtifact(t.db, { ...artifact, path, sha256: "s" }),
			).rejects.toThrow("SKILL_RUN_ARTIFACT_INVALID_PATH");
		}
	});

	it("reads artifacts by run, page, and canonical path identically", async () => {
		const p = dbs();
		const t = tenantFixture();
		const now = Date.now();
		for (const [i, path] of [
			"steps/x:a/attempts/1.json",
			"steps/x:b/calls/1.json",
			"timeline.json",
			"epochs/2/manifest.json",
		].entries()) {
			const row = {
				id: `a-${i}`,
				runId: "run-1",
				path,
				mimeType: "application/json",
				sizeBytes: 10,
				contentInline: null,
				contentR2Key: `k-${i}`,
				sha256: `s-${i}`,
				attempt: 1,
				outcome: "success" as const,
				createdAt: new Date(now + i).toISOString(),
			};
			await p.platform.insert(skillRunArtifacts).values(row);
			t.db.insert(skillRunArtifacts).values(row).run();
		}
		const [pAll, tAll] = await Promise.all([
			platform.listRunArtifacts(p.platform, scope, "run-1"),
			tenant.listRunArtifacts(t.db, "run-1"),
		]);
		expect(tAll).toEqual(pAll);
		const [pPage, tPage] = await Promise.all([
			platform.listRunArtifactsPage(p.platform, scope, "run-1", {
				limit: 2,
				offset: 1,
			}),
			tenant.listRunArtifactsPage(t.db, "run-1", { limit: 2, offset: 1 }),
		]);
		expect(tPage).toEqual(pPage);
		const [pOne, tOne] = await Promise.all([
			platform.getRunArtifact(p.platform, scope, "run-1", "timeline.json"),
			tenant.getRunArtifact(t.db, "run-1", "timeline.json"),
		]);
		expect(tOne).toEqual(pOne);
		const [pOps, tOps] = await Promise.all([
			platform.listRunOperationalArtifacts(p.platform, scope, "run-1"),
			tenant.listRunOperationalArtifacts(t.db, "run-1"),
		]);
		expect(tOps).toEqual(pOps);
		const [pSteps, tSteps] = await Promise.all([
			platform.listRunWorkflowStepArtifacts(p.platform, scope, "run-1"),
			tenant.listRunWorkflowStepArtifacts(t.db, "run-1"),
		]);
		expect(tSteps).toEqual(pSteps);
		const [pCalls, tCalls] = await Promise.all([
			platform.listRunWorkflowCallArtifacts(p.platform, scope, "run-1"),
			tenant.listRunWorkflowCallArtifacts(t.db, "run-1"),
		]);
		expect(tCalls).toEqual(pCalls);
		const [pBatch, tBatch] = await Promise.all([
			platform.listRunArtifactsForRuns(p.platform, scope, ["run-1", "run-2"]),
			tenant.listRunArtifactsForRuns(t.db, ["run-1", "run-2"]),
		]);
		expect(tBatch).toEqual(pBatch);
		const [pByPath, tByPath] = await Promise.all([
			platform.listRunArtifactsForRunsByPath(
				p.platform,
				scope,
				["run-1"],
				"timeline.json",
			),
			tenant.listRunArtifactsForRunsByPath(t.db, ["run-1"], "timeline.json"),
		]);
		expect(tByPath).toEqual(pByPath);
		const [pObs, tObs] = await Promise.all([
			platform.listRunWorkflowRuntimeObservationsForRuns(p.platform, scope, [
				"run-1",
			]),
			tenant.listRunWorkflowRuntimeObservationsForRuns(t.db, ["run-1"]),
		]);
		expect(tObs).toEqual(pObs);
		const [pTime, tTime] = await Promise.all([
			platform.listRunTimelineArtifacts(p.platform, scope, "run-1", 2),
			tenant.listRunTimelineArtifacts(t.db, "run-1", 2),
		]);
		expect(tTime).toEqual(pTime);
	});

	it("deletes a run's artifacts and reports the count identically", async () => {
		const t = tenantFixture();
		await tenant.recordRunArtifact(t.db, { ...artifact, sha256: "s1" });
		await tenant.recordRunArtifact(t.db, {
			...artifact,
			path: "timeline.json",
			r2Key: "run-1/bodies/a2",
			sha256: "s2",
		});
		expect(await tenant.deleteRunArtifacts(t.db, "run-1")).toBe(2);
		expect(await tenant.listRunArtifacts(t.db, "run-1")).toEqual([]);
	});
});
