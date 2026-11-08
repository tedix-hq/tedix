import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import {
	osBlueprints,
	osBlueprintRevisions,
	osGadgets,
	osGadgetRevisions,
	osGadgetCode,
	osWorkspaceResources,
	osWorkspaces,
} from "../../schema/os-workspaces";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	installWorkspaceApp,
	type InstallWorkspaceAppParams,
} from "./install-app";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		"PRAGMA foreign_keys = ON; CREATE TABLE organizations(id TEXT PRIMARY KEY); INSERT INTO organizations VALUES ('org');",
	);
	sqlite.exec(
		schemaDdl(
			osWorkspaces,
			osBlueprints,
			osBlueprintRevisions,
			osGadgets,
			osGadgetRevisions,
			osGadgetCode,
			osWorkspaceResources,
		),
	);
	const base = {
		organizationId: "org",
		createdByKind: "user" as const,
		createdById: "user",
	};
	const params: InstallWorkspaceAppParams = {
		blueprint: {
			...base,
			id: "blueprint",
			name: "Doc",
			currentRevisionId: "blueprint-revision",
		},
		blueprintRevision: {
			...base,
			id: "blueprint-revision",
			blueprintId: "blueprint",
			revision: 1,
			definition: '{"gadgets":[]}',
		},
		gadget: {
			...base,
			id: "app",
			workspaceId: "workspace",
			name: "Doc",
			currentRevisionId: "revision",
			sourceBlueprintRevisionId: "blueprint-revision",
		},
		revision: {
			...base,
			id: "revision",
			gadgetId: "app",
			revision: 1,
			manifest: "{}",
		},
		code: {
			organizationId: "org",
			revisionId: "revision",
			gadgetId: "app",
			files: '{"client.js":"","server.js":""}',
			codeLength: 0,
		},
		resource: {
			...base,
			id: "resource",
			workspaceId: "workspace",
			slot: "document",
			providerId: "tedix",
			connectionScope: "tenant",
			resourceType: "output",
			providerResourceId: "output",
			name: "Doc",
		},
	};
	return { db: createDbQueryClient(createD1Facade(sqlite)), params };
}

describe("workspace app installation", () => {
	it("installs the template, code and capability atomically and retries by stable identity", async () => {
		const { db, params } = fixture();
		await db
			.insert(osWorkspaces)
			.values({
				id: "workspace",
				organizationId: "org",
				name: "Docs",
				createdByKind: "user",
				createdById: "user",
			});
		await installWorkspaceApp(db, params);
		await installWorkspaceApp(db, params);
		expect(await db.select().from(osGadgets)).toHaveLength(1);
		expect(await db.select().from(osGadgetCode)).toHaveLength(1);
		expect(await db.select().from(osBlueprintRevisions)).toHaveLength(1);
		expect(await db.select().from(osWorkspaceResources)).toHaveLength(1);
	});
	it("rolls back every app and template row when the output slot conflicts", async () => {
		const { db, params } = fixture();
		await db
			.insert(osWorkspaces)
			.values({
				id: "workspace",
				organizationId: "org",
				name: "Docs",
				createdByKind: "user",
				createdById: "user",
			});
		await db
			.insert(osWorkspaceResources)
			.values({
				...params.resource!,
				id: "other",
				providerResourceId: "other-output",
			});
		await expect(installWorkspaceApp(db, params)).rejects.toThrow();
		expect(await db.select().from(osGadgets)).toHaveLength(0);
		expect(await db.select().from(osGadgetCode)).toHaveLength(0);
		expect(await db.select().from(osBlueprints)).toHaveLength(0);
	});
});
