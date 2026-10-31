import blueprint from "../../../os/dev/demo-pack/work-blueprint.json";
import { policyPacks } from "@tedix/db/schema/control-plane";
import { DatabaseSync } from "node:sqlite";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	createOsWorkspace,
	getOsWorkspace,
} from "@tedix/db/queries/os-workspaces/workspaces";
import {
	createOsGadget,
	createOsGadgetRevision,
	listOsWorkApps,
} from "@tedix/db/queries/os-workspaces/gadgets";
import { getOsBlueprintRevision } from "@tedix/db/queries/os-workspaces/blueprints";
import {
	osWorkspaces,
	osGadgets,
	osGadgetRevisions,
	osBlueprints,
	osBlueprintRevisions,
} from "@tedix/db/schema/os-workspaces";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import {
	parseStoredOsBlueprintDefinition,
	OsGadgetManifestSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import { installDefaultWorkApps } from "./default-work-apps";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		"CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL); INSERT INTO organizations (id) VALUES ('pine-studio'), ('cedar-studio');",
	);
	sqlite.exec(
		schemaDdl(
			policyPacks,
			osWorkspaces,
			osGadgets,
			osGadgetRevisions,
			osBlueprints,
			osBlueprintRevisions,
		),
	);
	sqlite
		.prepare(
			"INSERT INTO policy_packs(id,name,slug,scope,target,status,version,published_at,published_by,definition) VALUES('example-onboarding','Example','work-onboarding','system','shared','active',1,'2026-01-01T00:00:00Z','example-admin',?)",
		)
		.run(
			JSON.stringify({ workOnboarding: { version: 1, definition: blueprint } }),
		);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}
const owner = { kind: "user" as const, id: "pine-owner" };

describe("default Work blueprint installation", () => {
	it("installs pinned tenant-owned Feed and Deck with product navigation; retry and concurrent calls converge", async () => {
		const { db, sqlite } = fixture();
		try {
			const [first, second] = await Promise.all([
				installDefaultWorkApps(db, "pine-studio", owner),
				installDefaultWorkApps(db, "pine-studio", owner),
			]);
			expect(second).toEqual(first);
			expect(await installDefaultWorkApps(db, "pine-studio", owner)).toEqual(
				first,
			);
			const workspace = await getOsWorkspace(db, {
				organizationId: "pine-studio",
				workspaceId: first.workspaceId,
			});
			expect(workspace).toMatchObject({
				visibility: "org",
				status: "active",
				sourceBlueprintRevisionNumber: 1,
			});
			const apps = await listOsWorkApps(
				db,
				"pine-studio",
				{ userIds: [] },
				100,
			);
			expect(apps).toHaveLength(2);
			const manifests = apps.map((row) =>
				OsGadgetManifestSchema.parse(JSON.parse(row.revision.manifest)),
			);
			expect(manifests).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						entry: "tedix:app/activity-feed",
						navigation: { board: true, work: "feed" },
						config: expect.objectContaining({
							scope: "organization",
							projects: [],
						}),
					}),
					expect.objectContaining({
						entry: "tedix:app/decision-deck",
						navigation: { board: true, work: "deck", workDefault: true },
					}),
				]),
			);
			const revision = await getOsBlueprintRevision(db, {
				organizationId: "pine-studio",
				revisionId: workspace!.sourceBlueprintRevisionId!,
			});
			expect(
				parseStoredOsBlueprintDefinition(revision!.definition).gadgets,
			).toHaveLength(2);
			expect(
				sqlite.prepare("SELECT count(*) AS n FROM os_blueprints").get(),
			).toEqual({ n: 1 });
			expect(
				sqlite.prepare("SELECT count(*) AS n FROM os_workspaces").get(),
			).toEqual({ n: 1 });
		} finally {
			sqlite.close();
		}
	});

	it("preserves a manually installed Feed and installs only the missing Deck on retry", async () => {
		const { db, sqlite } = fixture();
		try {
			const workspaceId = crypto.randomUUID();
			const gadgetId = crypto.randomUUID();
			const base = {
				organizationId: "pine-studio",
				createdByKind: "user" as const,
				createdById: owner.id,
			};
			await createOsWorkspace(db, {
				...base,
				id: workspaceId,
				name: "Pine desk",
			});
			await createOsGadget(db, {
				...base,
				id: gadgetId,
				workspaceId,
				name: "Pine feed",
			});
			const manifest = {
				entry: "tedix:app/activity-feed",
				navigation: { work: "feed" },
				capabilities: [],
				config: {
					version: 1,
					scope: "organization",
					projects: [],
					attentionBudget: 3,
				},
			};
			await createOsGadgetRevision(db, {
				...base,
				id: crypto.randomUUID(),
				gadgetId,
				manifest: JSON.stringify(manifest),
			});
			await installDefaultWorkApps(db, "pine-studio", owner);
			await installDefaultWorkApps(db, "pine-studio", owner);
			const apps = await listOsWorkApps(
				db,
				"pine-studio",
				{ userIds: [] },
				100,
			);
			expect(apps).toHaveLength(2);
			expect(
				JSON.parse(
					apps.find((row) => row.gadget.id === gadgetId)!.revision.manifest,
				),
			).toEqual(manifest);
		} finally {
			sqlite.close();
		}
	});

	it("keeps tenants isolated and preserves an existing unrelated Work workspace", async () => {
		const { db, sqlite } = fixture();
		try {
			await createOsWorkspace(db, {
				id: crypto.randomUUID(),
				organizationId: "pine-studio",
				name: "Work",
				createdByKind: "user",
				createdById: owner.id,
			});
			const pine = await installDefaultWorkApps(db, "pine-studio", owner);
			const cedar = await installDefaultWorkApps(db, "cedar-studio", owner);
			expect(pine.workspaceId).not.toBe(cedar.workspaceId);
			expect(
				await getOsWorkspace(db, {
					organizationId: "cedar-studio",
					workspaceId: pine.workspaceId,
				}),
			).toBeUndefined();
			expect(
				await listOsWorkApps(db, "cedar-studio", { userIds: [] }, 100),
			).toHaveLength(2);
			expect(
				sqlite.prepare("SELECT count(*) AS n FROM os_workspaces").get(),
			).toEqual({ n: 3 });
		} finally {
			sqlite.close();
		}
	});

	it("rolls back a failed install, reports it, and succeeds on retry without orphan rows", async () => {
		const { db, sqlite } = fixture();
		try {
			sqlite.exec(
				"CREATE TRIGGER reject_work_apps BEFORE INSERT ON os_gadget_revisions BEGIN SELECT RAISE(ABORT, 'fictional install failure'); END;",
			);
			await expect(
				installDefaultWorkApps(db, "pine-studio", owner),
			).rejects.toThrow();
			expect(
				sqlite.prepare("SELECT count(*) AS n FROM os_workspaces").get(),
			).toEqual({ n: 0 });
			expect(
				sqlite.prepare("SELECT count(*) AS n FROM os_blueprints").get(),
			).toEqual({ n: 0 });
			sqlite.exec("DROP TRIGGER reject_work_apps;");
			await installDefaultWorkApps(db, "pine-studio", owner);
			expect(
				await listOsWorkApps(db, "pine-studio", { userIds: [] }, 100),
			).toHaveLength(2);
		} finally {
			sqlite.close();
		}
	});
});

it("requires published configuration for a new install but preserves an existing pinned installation after revocation", async () => {
	const { db, sqlite } = fixture();
	const first = await installDefaultWorkApps(db, "pine-studio", owner);
	const before = sqlite
		.prepare("SELECT manifest FROM os_gadget_revisions ORDER BY id")
		.all();
	sqlite.exec("UPDATE policy_packs SET status='archived'");
	expect(await installDefaultWorkApps(db, "pine-studio", owner)).toEqual(first);
	expect(
		sqlite
			.prepare("SELECT manifest FROM os_gadget_revisions ORDER BY id")
			.all(),
	).toEqual(before);
	await expect(
		installDefaultWorkApps(db, "cedar-studio", owner),
	).rejects.toThrow();
	expect(
		sqlite
			.prepare(
				"SELECT count(*) AS n FROM os_workspaces WHERE organization_id='cedar-studio'",
			)
			.get(),
	).toEqual({ n: 0 });
	sqlite.close();
});
