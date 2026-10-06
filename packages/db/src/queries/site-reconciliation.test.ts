import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	getLatestSiteReconciliation,
	recordSiteReconciliation,
} from "./site-reconciliation";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE organizations (id TEXT PRIMARY KEY, slug TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}');
		CREATE TABLE site_reconciliation_runs (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, source TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT NOT NULL, sites_checked INTEGER NOT NULL, issue_count INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
		CREATE TABLE site_reconciliation_findings (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, organization_id TEXT NOT NULL, site_id TEXT NOT NULL, site_slug TEXT NOT NULL, site_type TEXT NOT NULL, code TEXT NOT NULL, severity TEXT NOT NULL, detail TEXT NOT NULL, first_detected_at TEXT NOT NULL, last_detected_at TEXT NOT NULL, resolved_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
	`);
	sqlite
		.prepare("INSERT INTO organizations (id, slug) VALUES (?, ?)")
		.run("org-1", "acme");
	return createDbClient(createD1Facade(sqlite));
}

describe("site reconciliation persistence", () => {
	it("keeps recurring findings open and resolves absent findings", async () => {
		const db = fixture();
		const finding = {
			siteId: "site-1",
			slug: "acme",
			type: "cms" as const,
			code: "missing_release",
			severity: "error" as const,
			detail: "Missing",
		};
		await recordSiteReconciliation(db, {
			runId: "run-1",
			organizationId: "org-1",
			source: "scheduled",
			startedAt: "2026-01-01T00:00:00Z",
			completedAt: "2026-01-01T00:00:01Z",
			sitesChecked: 1,
			findings: [finding],
		});
		await recordSiteReconciliation(db, {
			runId: "run-2",
			organizationId: "org-1",
			source: "scheduled",
			startedAt: "2026-01-01T01:00:00Z",
			completedAt: "2026-01-01T01:00:01Z",
			sitesChecked: 1,
			findings: [finding],
		});
		await expect(
			getLatestSiteReconciliation(db, "org-1"),
		).resolves.toMatchObject({
			run: { id: "run-2", issueCount: 1 },
			findings: [
				{
					firstDetectedAt: "2026-01-01T00:00:01Z",
					lastDetectedAt: "2026-01-01T01:00:01Z",
					resolvedAt: null,
				},
			],
		});
		await recordSiteReconciliation(db, {
			runId: "run-3",
			organizationId: "org-1",
			source: "manual",
			startedAt: "2026-01-01T02:00:00Z",
			completedAt: "2026-01-01T02:00:01Z",
			sitesChecked: 1,
			findings: [],
		});
		await expect(
			getLatestSiteReconciliation(db, "org-1"),
		).resolves.toMatchObject({
			run: { id: "run-3", issueCount: 0 },
			findings: [],
		});
	});
});
