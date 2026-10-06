/**
 * Role-matrix authorization for the Tedix OS workspace surface: every
 * procedure group rides its least-privilege os:* verb (os:read, os:author,
 * os:run, os:publish, os:admin), settings:manage remains sufficient for every
 * verb, API-key machine contexts keep the apps:read / apps:write planes, and
 * cross-tenant overrides stay fail-closed on token permission claims.
 */

import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { osShareLinks, osShareSessions } from "@tedix/db/schema/os-shares";
import {
	osBlueprintRevisions,
	osBlueprints,
	osGadgetExecutions,
	osGadgetRevisions,
	osGadgets,
	osOutputRevisions,
	osOutputs,
	osWorkspaces,
} from "@tedix/db/schema/os-workspaces";
import { createDbClient } from "@tedix/db/client";
import { userConfigs } from "@tedix/db/schema/user-configs";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import { canonicalDigest } from "../../lib/blueprint-digest";
import type { BaseContext } from "../orpc";
import { osWorkspacesContractRouter } from "./os-workspaces";

const WORKSPACE_ID = "0b90b0e2-14da-4a34-bd35-a416ab604f25";

function createEnv(): CloudflareEnv {
	const sqlite = new DatabaseSync(":memory:");
	// The router binds the caller's organization into every predicate, so the
	// fixture keeps FKs off. The gallery join reads organizations.id/name only.
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			osWorkspaces,
			osGadgets,
			osGadgetRevisions,
			osGadgetExecutions,
			osBlueprints,
			osBlueprintRevisions,
			osOutputs,
			osOutputRevisions,
			osShareLinks,
			osShareSessions,
			userConfigs,
			auditEvents,
		),
	);
	sqlite.exec(`
		CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
		INSERT INTO organizations (id, name) VALUES ('org-1', 'First Org');
	`);
	return {
		ENVIRONMENT: "test",
		API_URL: "https://api.tedix.test",
		DB: createD1Facade(sqlite),
	} as CloudflareEnv;
}

function userContext(
	env: CloudflareEnv,
	permissions: string[],
	options: {
		sub?: string;
		userRole?: string;
		crossTenantOverrideActive?: boolean;
	} = {},
): BaseContext {
	return {
		authType: "user",
		crossTenantOverrideActive: options.crossTenantOverrideActive,
		db: createDbClient(env.DB) as BaseContext["db"],
		env,
		headers: new Headers(),
		organizationId: "org-1",
		url: new URL("https://api.tedix.test/rpc/os-workspaces"),
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions,
			roles: [],
			sub: options.sub ?? "user-1",
		},
		userRole: options.userRole,
	} as BaseContext;
}

function apiKeyContext(env: CloudflareEnv, scopes: string[]): BaseContext {
	return {
		apiKey: {
			id: "key-1",
			name: "test",
			organizationId: "org-1",
			scopes,
		},
		authType: "apikey",
		db: createDbClient(env.DB) as BaseContext["db"],
		env,
		headers: new Headers(),
		organizationId: "org-1",
		url: new URL("https://api.tedix.test/rpc/os-workspaces"),
	} as BaseContext;
}

function userClient(
	env: CloudflareEnv,
	permissions: string[],
	options?: Parameters<typeof userContext>[2],
) {
	return createRouterClient(osWorkspacesContractRouter, {
		context: userContext(env, permissions, options),
	});
}

function apiKeyClient(env: CloudflareEnv, scopes: string[]) {
	return createRouterClient(osWorkspacesContractRouter, {
		context: apiKeyContext(env, scopes),
	});
}

/** Seed a workspace with one runnable gadget using full settings authority. */
async function seedGadget(env: CloudflareEnv) {
	const admin = userClient(env, ["settings:manage"]);
	const { workspace } = await admin.workspaces.create({ name: "Ops" });
	const { gadget } = await admin.gadgets.create({
		workspaceId: workspace.id,
		name: "Runner",
	});
	await admin.gadgets.revise({
		workspaceId: workspace.id,
		gadgetId: gadget.id,
		manifest: { entry: "main.ts", capabilities: [] },
	});
	return { workspaceId: workspace.id, gadgetId: gadget.id };
}

/**
 * A minimal, VALID export envelope. Digest, key set, and field shapes come from
 * the real producer (src/services/os-blueprint-portability.ts), so a rejection
 * in these tests can only be the authorization gate, never a malformed input.
 */
async function exportEnvelope() {
	const definition = {
		gadgets: [{ name: "CRM", manifest: { entry: "crm.ts", capabilities: [] } }],
		requirements: null,
	};
	return {
		envelopeVersion: 1 as const,
		exportedAt: "2026-08-17T12:00:00.000Z",
		exportedByKind: "user" as const,
		source: {
			organizationId: "org-2",
			organizationName: "Second Org",
			blueprintId: "8b9c0d1e-2f3a-4b5c-8d6e-7f8a9b0c1d2e",
			blueprintName: "Imported Pod",
			revisionId: "9c0d1e2f-3a4b-4c5d-8e6f-8a9b0c1d2e3f",
			revision: 1,
			definitionSha256: await canonicalDigest(definition),
			forkedAt: "2026-08-17T12:00:00.000Z",
			via: "export" as const,
			attested: true,
		},
		blueprint: {
			name: "Imported Pod",
			description: null,
			status: "published" as const,
		},
		revision: {
			revision: 1,
			createdAt: "2026-08-17T11:00:00.000Z",
			publishedAt: "2026-08-17T11:30:00.000Z",
			createdByKind: "user" as const,
		},
		definition,
		lineage: null,
	};
}

/** Seed a blueprint carrying one unpublished revision. */
async function seedBlueprint(env: CloudflareEnv) {
	const admin = userClient(env, ["settings:manage"]);
	const { blueprint } = await admin.blueprints.create({ name: "Sales Pod" });
	await admin.blueprints.revise({
		blueprintId: blueprint.id,
		definition: { gadgets: [{ name: "CRM", manifest: { entry: "crm.ts" } }] },
	});
	return blueprint.id;
}

describe("os-workspaces verb matrix", () => {
	it("rejects a user with no OS permission from reads and writes", async () => {
		const client = userClient(createEnv(), []);

		await expect(client.workspaces.list({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			client.workspaces.create({ name: "Ops" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(client.blueprints.list({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		// The gallery is org-agnostic but never permission-agnostic.
		await expect(client.blueprints.gallery({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			client.blueprints.preflight({ blueprintId: WORKSPACE_ID }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("os:read lists and gets but cannot author, run, publish, or delete", async () => {
		const env = createEnv();
		const reader = userClient(env, ["os:read"]);

		await expect(reader.workspaces.list({})).resolves.toEqual({
			items: [],
			truncated: false,
		});
		await expect(reader.workspacePreferences.list({})).resolves.toEqual({
			items: [],
		});
		await expect(reader.blueprints.list({})).resolves.toEqual({
			items: [],
			truncated: false,
		});
		await expect(reader.blueprints.gallery({})).resolves.toEqual({
			items: [],
		});
		await expect(reader.outputs.list({})).resolves.toEqual({
			items: [],
			truncated: false,
		});
		// Dependency preflight is a read: it resolves rows, never mints authority.
		const blueprintId = await seedBlueprint(env);
		await expect(
			reader.blueprints.preflight({ blueprintId }),
		).resolves.toMatchObject({
			preflight: { status: "not_configured", instantiateAllowed: true },
		});
		// Export is a pure projection of a blueprint the reader can already read.
		await expect(
			reader.blueprints.export({ blueprintId }),
		).resolves.toMatchObject({ export: { envelopeVersion: 1 } });
		// The upgrade preview is a read too: os:read clears the gate and the call
		// then fails on the missing workspace, not on authorization.
		await expect(
			reader.workspaces.previewBlueprintUpgrade({ workspaceId: WORKSPACE_ID }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		await expect(
			reader.blueprints.import({ export: await exportEnvelope() }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			reader.workspaces.decideBlueprintUpgrade({
				workspaceId: WORKSPACE_ID,
				decision: "stay_pinned",
				candidateRevisionId: WORKSPACE_ID,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			reader.workspaces.create({ name: "Ops" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			reader.workspaces.update({
				workspaceId: WORKSPACE_ID,
				name: "Renamed",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			reader.outputs.create({
				kind: "document",
				title: "Brief",
				content: { kind: "document", blocks: [] },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			reader.gadgets.run({
				workspaceId: WORKSPACE_ID,
				gadgetId: WORKSPACE_ID,
				tediId: WORKSPACE_ID,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			reader.blueprints.publish({ blueprintId: WORKSPACE_ID }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			reader.gadgets.delete({
				workspaceId: WORKSPACE_ID,
				gadgetId: WORKSPACE_ID,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("os:author authors workspaces, gadgets, outputs, and blueprint drafts but cannot read, run, publish, or delete", async () => {
		const env = createEnv();
		const author = userClient(env, ["os:author"]);

		const { workspace } = await author.workspaces.create({ name: "Ops" });
		await expect(
			author.workspaces.update({
				workspaceId: workspace.id,
				name: "Operations",
			}),
		).resolves.toMatchObject({ workspace: { name: "Operations" } });
		const { gadget } = await author.gadgets.create({
			workspaceId: workspace.id,
			name: "Runner",
		});
		await expect(
			author.gadgets.revise({
				workspaceId: workspace.id,
				gadgetId: gadget.id,
				manifest: { entry: "main.ts" },
			}),
		).resolves.toMatchObject({ revision: { revision: 1 } });
		const { output } = await author.outputs.create({
			kind: "document",
			title: "Brief",
			content: { kind: "document", blocks: [] },
		});
		await expect(
			author.outputs.patchDocument({
				outputId: output.id,
				ops: [
					{ op: "insert", index: 0, block: { type: "paragraph", text: "hi" } },
				],
			}),
		).resolves.toMatchObject({ revision: { revision: 2 } });
		const { blueprint } = await author.blueprints.create({ name: "Pod" });
		await expect(
			author.blueprints.revise({
				blueprintId: blueprint.id,
				definition: { gadgets: [] },
			}),
		).resolves.toMatchObject({ revision: { revision: 1 } });

		// Importing an export envelope authors a new draft blueprint.
		await expect(
			author.blueprints.import({ export: await exportEnvelope() }),
		).resolves.toMatchObject({
			blueprint: { name: "Imported Pod", status: "draft", visibility: "org" },
		});

		await expect(author.workspaces.list({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		// Export is a read, and authoring is not reading.
		await expect(
			author.blueprints.export({ blueprintId: blueprint.id }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			author.gadgets.run({
				workspaceId: workspace.id,
				gadgetId: gadget.id,
				tediId: WORKSPACE_ID,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			author.blueprints.publish({ blueprintId: blueprint.id }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			author.gadgets.delete({
				workspaceId: workspace.id,
				gadgetId: gadget.id,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("os:run admits governed Gadget requests, nothing else", async () => {
		const env = createEnv();
		const seeded = await seedGadget(env);
		const runner = userClient(env, ["os:run"], { sub: "runner-1" });

		const { execution } = await runner.gadgets.run({
			workspaceId: seeded.workspaceId,
			gadgetId: seeded.gadgetId,
			tediId: WORKSPACE_ID,
			capabilities: ["test:undeclared"],
		});
		expect(execution).toMatchObject({
			status: "denied",
			createdById: "runner-1",
		});

		await expect(runner.workspaces.list({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			runner.gadgets.create({
				workspaceId: seeded.workspaceId,
				name: "Another",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			runner.gadgets.delete({
				workspaceId: seeded.workspaceId,
				gadgetId: seeded.gadgetId,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("os:publish publishes, gates visibility, and instantiates, nothing else", async () => {
		const env = createEnv();
		const blueprintId = await seedBlueprint(env);
		const publisher = userClient(env, ["os:publish"]);

		await expect(
			publisher.blueprints.publish({ blueprintId }),
		).resolves.toMatchObject({ blueprint: { status: "published" } });
		await expect(
			publisher.blueprints.setVisibility({
				blueprintId,
				visibility: "catalog",
			}),
		).resolves.toMatchObject({ blueprint: { visibility: "catalog" } });
		await expect(
			publisher.blueprints.instantiate({
				blueprintId,
				workspaceName: "Sales EU",
			}),
		).resolves.toMatchObject({ workspace: { name: "Sales EU" } });
		await expect(
			publisher.blueprints.instantiateFromGallery({
				blueprintId,
				workspaceName: "Sales US",
			}),
		).resolves.toMatchObject({ workspace: { name: "Sales US" } });

		// Deciding an upgrade re-pins a workspace onto a published revision, so it
		// rides the publish verb: os:publish clears the gate and the call then
		// fails on the missing workspace, not on authorization.
		await expect(
			publisher.workspaces.decideBlueprintUpgrade({
				workspaceId: WORKSPACE_ID,
				decision: "stay_pinned",
				candidateRevisionId: WORKSPACE_ID,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		await expect(
			publisher.blueprints.create({ name: "Another" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			publisher.blueprints.import({ export: await exportEnvelope() }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			publisher.blueprints.revise({
				blueprintId,
				definition: { gadgets: [] },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(publisher.blueprints.list({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it("os:admin permanently deletes inactive resources, nothing else", async () => {
		const env = createEnv();
		const seeded = await seedGadget(env);
		const destroyer = userClient(env, ["os:admin"]);

		await expect(
			destroyer.gadgets.create({
				workspaceId: seeded.workspaceId,
				name: "Another",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(destroyer.workspaces.list({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			destroyer.gadgets.run({
				workspaceId: seeded.workspaceId,
				gadgetId: seeded.gadgetId,
				tediId: WORKSPACE_ID,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		await expect(
			destroyer.gadgets.delete({
				workspaceId: seeded.workspaceId,
				gadgetId: seeded.gadgetId,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("settings:manage remains sufficient for every verb group", async () => {
		const env = createEnv();
		const admin = userClient(env, ["settings:manage"]);

		const { workspace } = await admin.workspaces.create({ name: "Ops" });
		await expect(admin.workspaces.list({})).resolves.toMatchObject({
			items: [{ id: workspace.id }],
		});
		const { gadget } = await admin.gadgets.create({
			workspaceId: workspace.id,
			name: "Runner",
		});
		await admin.gadgets.revise({
			workspaceId: workspace.id,
			gadgetId: gadget.id,
			manifest: { entry: "main.ts" },
		});
		const { execution } = await admin.gadgets.run({
			workspaceId: workspace.id,
			gadgetId: gadget.id,
			tediId: WORKSPACE_ID,
			capabilities: ["test:undeclared"],
		});
		expect(execution.status).toBe("denied");
		const { blueprint } = await admin.blueprints.create({ name: "Pod" });
		await admin.blueprints.revise({
			blueprintId: blueprint.id,
			definition: { gadgets: [] },
		});
		await expect(
			admin.blueprints.publish({ blueprintId: blueprint.id }),
		).resolves.toMatchObject({ blueprint: { status: "published" } });
		await admin.gadgets.archive({
			workspaceId: workspace.id,
			gadgetId: gadget.id,
		});
		await expect(
			admin.gadgets.delete({
				workspaceId: workspace.id,
				gadgetId: gadget.id,
			}),
		).resolves.toEqual({ deleted: true });
	});

	it("under a cross-tenant override, token os:*/settings claims are distrusted; only the resolved membership role authorizes", async () => {
		const env = createEnv();
		const impostor = userClient(env, ["settings:manage", "os:read"], {
			crossTenantOverrideActive: true,
		});
		await expect(impostor.workspaces.list({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});

		const member = userClient(env, ["settings:manage", "os:read"], {
			crossTenantOverrideActive: true,
			userRole: "admin",
		});
		await expect(member.workspaces.list({})).resolves.toEqual({
			items: [],
			truncated: false,
		});
	});
});

describe("os-workspaces machine plane (unchanged)", () => {
	it("rejects an API key without apps:read from reads", async () => {
		const client = apiKeyClient(createEnv(), []);

		await expect(client.workspaces.list({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			client.gadgets.list({ workspaceId: WORKSPACE_ID }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(client.blueprints.gallery({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(client.outputs.list({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			client.executions.list({
				workspaceId: WORKSPACE_ID,
				gadgetId: WORKSPACE_ID,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("apps:read reads and apps:write spans every OS write verb", async () => {
		const env = createEnv();
		const writer = apiKeyClient(env, ["apps:write"]);
		const reader = apiKeyClient(env, ["apps:read"]);
		await expect(reader.workspacePreferences.list({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});

		const { workspace } = await writer.workspaces.create({ name: "Ops" });
		const { gadget } = await writer.gadgets.create({
			workspaceId: workspace.id,
			name: "Runner",
		});
		await writer.gadgets.revise({
			workspaceId: workspace.id,
			gadgetId: gadget.id,
			manifest: { entry: "main.ts" },
		});
		const { execution } = await writer.gadgets.run({
			workspaceId: workspace.id,
			gadgetId: gadget.id,
			tediId: WORKSPACE_ID,
			capabilities: ["test:undeclared"],
		});
		expect(execution.status).toBe("denied");
		const { blueprint } = await writer.blueprints.create({ name: "Pod" });
		await writer.blueprints.revise({
			blueprintId: blueprint.id,
			definition: { gadgets: [] },
		});
		await expect(
			writer.blueprints.publish({ blueprintId: blueprint.id }),
		).resolves.toMatchObject({ blueprint: { status: "published" } });
		await writer.gadgets.archive({
			workspaceId: workspace.id,
			gadgetId: gadget.id,
		});
		await expect(
			writer.gadgets.delete({
				workspaceId: workspace.id,
				gadgetId: gadget.id,
			}),
		).resolves.toEqual({ deleted: true });

		await expect(reader.workspaces.list({})).resolves.toMatchObject({
			items: [{ id: workspace.id }],
		});
		await expect(
			reader.workspaces.create({ name: "No" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("rejects a read-only API key from every write verb", async () => {
		const client = apiKeyClient(createEnv(), ["apps:read"]);

		await expect(
			client.workspaces.create({ name: "Ops" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			client.workspaces.archive({ workspaceId: WORKSPACE_ID }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			client.gadgets.revise({
				workspaceId: WORKSPACE_ID,
				gadgetId: WORKSPACE_ID,
				manifest: { entry: "main.ts" },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			client.gadgets.run({
				workspaceId: WORKSPACE_ID,
				gadgetId: WORKSPACE_ID,
				tediId: WORKSPACE_ID,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			client.gadgets.delete({
				workspaceId: WORKSPACE_ID,
				gadgetId: WORKSPACE_ID,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			client.blueprints.publish({ blueprintId: WORKSPACE_ID }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			client.blueprints.instantiate({
				blueprintId: WORKSPACE_ID,
				workspaceName: "Ops",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			client.blueprints.setVisibility({
				blueprintId: WORKSPACE_ID,
				visibility: "catalog",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			client.blueprints.instantiateFromGallery({
				blueprintId: WORKSPACE_ID,
				workspaceName: "Ops",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			client.outputs.create({
				kind: "document",
				title: "Brief",
				content: { kind: "document", blocks: [] },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			client.outputs.revise({
				outputId: WORKSPACE_ID,
				content: { kind: "document", blocks: [] },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			client.outputs.patchDocument({
				outputId: WORKSPACE_ID,
				ops: [{ op: "delete", index: 0 }],
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			client.outputs.setSheetRange({
				outputId: WORKSPACE_ID,
				startRow: 0,
				startColumn: 0,
				cells: [["x"]],
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			client.outputs.export({ outputId: WORKSPACE_ID, format: "pdf" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			client.blueprints.import({ export: await exportEnvelope() }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			client.workspaces.decideBlueprintUpgrade({
				workspaceId: WORKSPACE_ID,
				decision: "stay_pinned",
				candidateRevisionId: WORKSPACE_ID,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
