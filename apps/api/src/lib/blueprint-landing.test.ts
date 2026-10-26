import { DatabaseSync } from "node:sqlite";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	osBlueprintRevisions,
	osBlueprints,
} from "@tedix/db/schema/os-workspaces";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import {
	handlePublicBlueprintPage,
	readGalleryBlueprintPage,
} from "./blueprint-landing";

const ORG_ID = "0a000000-0000-4000-8000-0000000000aa";
const ORG_NAME = "Northwind Fictional GmbH";
const CREATOR_ID = "user-creator-7f3a";
const SKILL_ID = "0b000000-0000-4000-8000-0000000000bb";
const REVISION_ID = "0c000000-0000-4000-8000-0000000000cc";
const CATALOG_ID = "0d000000-0000-4000-8000-0000000000d1";
const PRIVATE_ID = "0d000000-0000-4000-8000-0000000000d2";
const DRAFT_ID = "0d000000-0000-4000-8000-0000000000d3";
const APP_SOURCE_MARKER = "secret-app-source-marker";

const definition = {
	gadgets: [
		{
			name: "Pipeline Board",
			manifest: {
				entry: "gadgets/pipeline/index.html",
				capabilities: ["outputs.read"],
			},
		},
	],
	requirements: {
		version: 1,
		skills: [
			{
				role: "skill",
				skillId: SKILL_ID,
				slug: "weekly-pipeline-review",
				revision: 4,
				workflowSha256: null,
			},
		],
		connections: [
			{ providerId: "gmail", tokenScope: "tenant", scopes: ["mail.read"] },
		],
		resources: [
			{
				slot: "team_calendar",
				providerId: "google-calendar",
				tokenScope: "either",
				scopes: [],
				resourceType: "calendar",
				label: "Team calendar",
			},
		],
		policies: [
			{ scope: "organization", slug: "private-policy-pack", version: 2 },
		],
		runtime: null,
		layout: null,
		outputs: [{ gadget: "Pipeline Board", kind: "sheet", title: "Pipeline" }],
		steward: { tediSlug: "private-steward-tedi" },
	},
	note: APP_SOURCE_MARKER,
};

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		PRAGMA foreign_keys = OFF;
		CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
		INSERT INTO organizations (id, name) VALUES ('${ORG_ID}', '${ORG_NAME}');
	`);
	sqlite.exec(schemaDdl(osBlueprints, osBlueprintRevisions));
	const db = createDbQueryClient(createD1Facade(sqlite));
	const row = (
		id: string,
		status: "draft" | "published",
		visibility: "org" | "catalog",
	) => ({
		id,
		organizationId: ORG_ID,
		name: `Pipeline Kit ${id.slice(-2)}`,
		description: "Weekly pipeline review for a sales team",
		status,
		visibility,
		currentRevisionId: REVISION_ID,
		featuredAt: "2026-10-26T08:00:00.000Z",
		createdByKind: "user" as const,
		createdById: CREATOR_ID,
	});
	return {
		db,
		async seed() {
			await db
				.insert(osBlueprints)
				.values([
					row(CATALOG_ID, "published", "catalog"),
					row(PRIVATE_ID, "published", "org"),
					row(DRAFT_ID, "draft", "catalog"),
				]);
			await db.insert(osBlueprintRevisions).values({
				id: REVISION_ID,
				organizationId: ORG_ID,
				blueprintId: CATALOG_ID,
				revision: 3,
				definition: JSON.stringify(definition),
				createdByKind: "user",
				createdById: CREATOR_ID,
				publishedAt: "2026-10-20T10:00:00.000Z",
			});
		},
	};
}

describe("blueprint landing page", () => {
	it("builds the signed-in page from an allowlist, with the publisher's display name", async () => {
		const { db, seed } = fixture();
		await seed();
		expect(await readGalleryBlueprintPage(db, CATALOG_ID)).toEqual({
			id: CATALOG_ID,
			name: "Pipeline Kit d1",
			description: "Weekly pipeline review for a sales team",
			publishedAt: "2026-10-20T10:00:00.000Z",
			featured: true,
			apps: [{ name: "Pipeline Board" }],
			needs: {
				connections: [{ providerId: "gmail" }],
				resources: [{ label: "Team calendar", providerId: "google-calendar" }],
				skills: [{ slug: "weekly-pipeline-review" }],
				outputs: [{ title: "Pipeline", kind: "sheet" }],
			},
			organizationName: ORG_NAME,
		});
	});

	it("serves the public page without organization, member, revision, skill, policy or app-source data", async () => {
		const { db, seed } = fixture();
		await seed();
		const response = await handlePublicBlueprintPage(db, CATALOG_ID);
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
		const body = await response.text();
		const parsed = JSON.parse(body) as { blueprint: Record<string, unknown> };
		expect(Object.keys(parsed)).toEqual(["blueprint"]);
		expect(Object.keys(parsed.blueprint).sort()).toEqual(
			[
				"apps",
				"description",
				"featured",
				"id",
				"name",
				"needs",
				"publishedAt",
			].sort(),
		);
		for (const forbidden of [
			ORG_ID,
			ORG_NAME,
			CREATOR_ID,
			SKILL_ID,
			REVISION_ID,
			"private-policy-pack",
			"private-steward-tedi",
			"mail.read",
			"gadgets/pipeline/index.html",
			APP_SOURCE_MARKER,
			"organizationId",
			"organizationName",
			"createdById",
		]) {
			expect(body, forbidden).not.toContain(forbidden);
		}
	});

	it("answers private, draft, missing and malformed ids with the same 404", async () => {
		const { db, seed } = fixture();
		await seed();
		const bodies = new Set<string>();
		for (const id of [
			PRIVATE_ID,
			DRAFT_ID,
			"0d000000-0000-4000-8000-0000000000ff",
			"not-a-uuid",
			"' OR 1=1 --",
		]) {
			const response = await handlePublicBlueprintPage(db, id);
			expect(response.status, id).toBe(404);
			bodies.add(await response.text());
		}
		expect(bodies.size).toBe(1);
	});
});
