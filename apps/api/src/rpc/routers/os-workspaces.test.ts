import {
	kernelRuntimeRuns,
	kernelConversationGrants,
} from "@tedix/db/schema/cognitive-runtime";
/**
 * Tedix OS workspace-domain router: tenant binding, creator accountability,
 * revision optimistic concurrency surfacing, and the blueprint publish gate —
 * exercised end to end against a real D1 facade (`createD1Facade` rejects the
 * two Drizzle idioms that break on production D1).
 */

import { DatabaseSync } from "node:sqlite";
import { unzipSync } from "fflate";
import { createRouterClient } from "@orpc/server";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { osShareLinks, osShareSessions } from "@tedix/db/schema/os-shares";
import { skillRunArtifacts, skillRuns } from "@tedix/db/schema/cognitive";
import {
	osBlueprintRevisions,
	osBlueprints,
	osCollaborationProposals,
	osGadgetExecutions,
	osGadgetRevisions,
	osGadgets,
	osOutputRevisions,
	osOutputs,
	osWorkspaceResources,
	osWorkspaces,
} from "@tedix/db/schema/os-workspaces";
import { createDbClient } from "@tedix/db/client";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createOsGadgetExecution } from "@tedix/db/queries/os-workspaces/executions";
import { recordRunArtifact } from "@tedix/db/queries/skill-run-artifacts";
import { userConfigs } from "@tedix/db/schema/user-configs";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
// The same digest the export path records, so a lineage assertion compares
// against the real producer rather than a hand-copied constant.
import { canonicalDigest } from "../../lib/blueprint-digest";
import {
	failOsGadgetApprovalDispatch,
	settleOsGadgetApproval,
} from "../../services/os-gadget-approval-settlement";
import type { BaseContext } from "../orpc";
import { osWorkspacesContractRouter } from "./os-workspaces";
import { sha256Hex } from "@tedix/worker-kit/crypto";

// Governed-dispatch collaborators. The paths a receipt records (preflight,
// budget, approvals, skill lookup, tedi ownership) are mocked per test; the
// receipt store itself stays the real D1 facade.
const mocks = vi.hoisted(() => ({
	authorizeRuntimeBudget: vi.fn(),
	createApprovalRequest: vi.fn(),
	getApprovalRequestById: vi.fn(),
	getPolicyPackBySlugForOrganization: vi.fn(),
	getRuntimeProfileById: vi.fn(),
	getSkillEntryBySlug: vi.fn(),
	resolveConnectionAvailability: vi.fn(),
	getTediById: vi.fn(),
	getTediOrganizationId: vi.fn(),
	getWorkItemById: vi.fn(),
	resolveWorkItemExecutionPreflight: vi.fn(),
	authorizeDerivedOutputSources: vi.fn().mockResolvedValue(true),
}));

vi.mock(
	"../../services/os-derived-resource-access",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../services/os-derived-resource-access")
		>()),
		authorizeDerivedOutputSources: mocks.authorizeDerivedOutputSources,
	}),
);

vi.mock("../../services/work-item-execution-preflight", () => ({
	resolveWorkItemExecutionPreflight: mocks.resolveWorkItemExecutionPreflight,
}));
vi.mock("../../services/connection-availability", () => ({
	resolveConnectionAvailability: mocks.resolveConnectionAvailability,
}));
vi.mock("../../services/runtime-budget-admission", () => ({
	authorizeRuntimeBudget: mocks.authorizeRuntimeBudget,
}));
vi.mock("@tedix/db/queries/cognitive/skill-crud", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/cognitive/skill-crud")
	>()),
	getSkillEntryBySlug: mocks.getSkillEntryBySlug,
}));
vi.mock("@tedix/db/queries/tedis", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/tedis")>()),
	getTediById: mocks.getTediById,
	getTediOrganizationId: mocks.getTediOrganizationId,
}));
vi.mock("@tedix/db/queries/approvals", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/approvals")>()),
	createApprovalRequest: mocks.createApprovalRequest,
	getApprovalRequestById: mocks.getApprovalRequestById,
}));
vi.mock("@tedix/db/queries/work-items/crud", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/work-items/crud")
	>()),
	getWorkItemById: mocks.getWorkItemById,
}));
vi.mock(
	"@tedix/db/queries/control-plane/definitions",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@tedix/db/queries/control-plane/definitions")
		>()),
		getRuntimeProfileById: mocks.getRuntimeProfileById,
		getPolicyPackBySlugForOrganization:
			mocks.getPolicyPackBySlugForOrganization,
	}),
);

function createEnv(): CloudflareEnv {
	const sqlite = new DatabaseSync(":memory:");
	// The router binds the caller's organization into every predicate, so the
	// fixture keeps FKs off. The gallery join reads organizations.id/name only;
	// a minimal hand-made parent table (with display names) covers it.
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			kernelRuntimeRuns,
			kernelConversationGrants,
			osWorkspaces,
			osGadgets,
			osGadgetRevisions,
			osGadgetExecutions,
			osBlueprints,
			osBlueprintRevisions,
			osOutputs,
			osOutputRevisions,
			osWorkspaceResources,
			osCollaborationProposals,
			osShareLinks,
			osShareSessions,
			skillRuns,
			skillRunArtifacts,
			userConfigs,
			auditEvents,
		),
	);
	sqlite.exec(`
		CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
		INSERT INTO organizations (id, name)
			VALUES ('org-1', 'First Org'), ('org-2', 'Second Org');
	`);
	return {
		ENVIRONMENT: "test",
		API_URL: "https://api.tedix.test",
		SECRETS_MASTER_KEY: "test-gadget-export-secret",
		AZURE_CHAT_DEPLOYMENT: "gpt-5.6-luna",
		TEDIX_BILLING_SETTLEMENT_MODE: "external",
		DB: createD1Facade(sqlite),
	} as unknown as CloudflareEnv;
}

function userContext(
	env: CloudflareEnv,
	organizationId: string,
	userId = "user-1",
): BaseContext {
	return {
		authType: "user",
		db: createDbClient(env.DB) as BaseContext["db"],
		env,
		headers: new Headers(),
		organizationId,
		url: new URL("https://api.tedix.test/rpc/os-workspaces"),
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions: ["settings:manage"],
			roles: [],
			sub: userId,
		},
	} as BaseContext;
}

function apiKeyContext(
	env: CloudflareEnv,
	organizationId: string,
): BaseContext {
	return {
		apiKey: {
			id: "key-1",
			name: "test",
			organizationId,
			scopes: ["apps:read", "apps:write"],
		},
		authType: "apikey",
		db: createDbClient(env.DB) as BaseContext["db"],
		env,
		headers: new Headers(),
		organizationId,
		url: new URL("https://api.tedix.test/rpc/os-workspaces"),
	} as BaseContext;
}

function clients() {
	const env = createEnv();
	return {
		/** The shared D1 facade, so a test can assert on the ROW, not just the wire. */
		env,
		org1: createRouterClient(osWorkspacesContractRouter, {
			context: userContext(env, "org-1"),
		}),
		org2: createRouterClient(osWorkspacesContractRouter, {
			context: userContext(env, "org-2"),
		}),
		machine: createRouterClient(osWorkspacesContractRouter, {
			context: apiKeyContext(env, "org-1"),
		}),
		machineAgent: createRouterClient(osWorkspacesContractRouter, {
			context: {
				...apiKeyContext(env, "org-1"),
				externalAgentSessionId: "codex:session-1",
				externalAgentPrincipalId: "external-agent-1",
			},
		}),
	};
}

describe("workspaces", () => {
	let c: ReturnType<typeof clients>;
	beforeEach(() => {
		c = clients();
	});

	it("creates, updates, reads, and archives inside the caller's organization only", async () => {
		const { workspace } = await c.org1.workspaces.create({
			name: "Operations",
			description: "ops hub",
		});
		expect(workspace).toMatchObject({
			organizationId: "org-1",
			name: "Operations",
			status: "active",
			createdByKind: "user",
			createdById: "user-1",
		});

		await expect(
			c.org1.workspaces.get({ workspaceId: workspace.id }),
		).resolves.toMatchObject({ workspace: { name: "Operations" } });
		// The same UUID resolved from another tenant must not exist.
		await expect(
			c.org2.workspaces.get({ workspaceId: workspace.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			c.org2.workspaces.update({
				workspaceId: workspace.id,
				name: "Cross-tenant rename",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			c.org2.workspaces.archive({ workspaceId: workspace.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		const updated = await c.org1.workspaces.update({
			workspaceId: workspace.id,
			name: "Operations Center",
			description: null,
		});
		expect(updated.workspace).toMatchObject({
			name: "Operations Center",
			description: null,
			status: "active",
		});

		const archived = await c.org1.workspaces.archive({
			workspaceId: workspace.id,
		});
		expect(archived.workspace.status).toBe("archived");
		await c.org1.workspacePreferences.setFavorite({
			workspaceId: workspace.id,
			favorite: true,
		});
		await expect(
			c.org2.workspaces.delete({ workspaceId: workspace.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			c.org1.workspaces.delete({ workspaceId: workspace.id }),
		).resolves.toEqual({ deleted: true });
		await expect(
			c.org1.workspaces.get({ workspaceId: workspace.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect((await c.org1.workspacePreferences.list({})).items).toHaveLength(0);
	});

	it("refuses to permanently delete an active workspace", async () => {
		const { workspace } = await c.org1.workspaces.create({ name: "Active" });
		await expect(
			c.org1.workspaces.delete({ workspaceId: workspace.id }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("preserves retained collaboration evidence during permanent deletion", async () => {
		const { workspace } = await c.org1.workspaces.create({ name: "Reviewed" });
		const { output } = await c.org1.outputs.create({
			workspaceId: workspace.id,
			kind: "document",
			title: "Reviewed draft",
			content: { kind: "document", blocks: [] },
		});
		await c.machineAgent.collaboration.create({
			workspaceId: workspace.id,
			documentType: "output",
			documentId: output.id,
			sourceKind: "agent_session",
			sourceId: "codex:session-1",
			content: { kind: "document", blocks: [] },
		});
		await c.org1.outputs.archive({ outputId: output.id });
		await c.org1.workspaces.archive({ workspaceId: workspace.id });

		await expect(
			c.org1.outputs.delete({ outputId: output.id }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			c.org1.workspaces.delete({ workspaceId: workspace.id }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("maps the per-org unique name to CONFLICT and truncates lists", async () => {
		await c.org1.workspaces.create({ name: "Operations" });
		await expect(
			c.org1.workspaces.create({ name: "Operations" }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		// The same name is free in another organization.
		await expect(
			c.org2.workspaces.create({ name: "Operations" }),
		).resolves.toBeDefined();

		await c.org1.workspaces.create({ name: "Research" });
		await c.org1.workspaces.create({ name: "Support" });
		const support = await c.org1.workspaces.create({ name: "Customer Care" });
		await expect(
			c.org1.workspaces.update({
				workspaceId: support.workspace.id,
				name: "Operations",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		const page = await c.org1.workspaces.list({ limit: 2 });
		expect(page.items).toHaveLength(2);
		expect(page.truncated).toBe(true);
		const all = await c.org1.workspaces.list({});
		expect(all.items).toHaveLength(4);
		expect(all.truncated).toBe(false);
	});

	it("records machine principals as service creators", async () => {
		const { workspace } = await c.machine.workspaces.create({ name: "Bots" });
		expect(workspace).toMatchObject({
			createdByKind: "service",
			createdById: "key-1",
		});
	});
});

describe("Workspace resources", () => {
	it("rebinds the connection requirement while preserving exact object identity and author authority", async () => {
		const c = clients();
		const { workspace } = await c.org1.workspaces.create({ name: "CSF" });
		const { resource } = await c.org1.resources.create({
			workspaceId: workspace.id,
			selection: {
				providerId: "google-drive",
				connectionScope: "user",
				requiredScopes: ["drive.readonly"],
				resourceType: "file",
				providerResourceId: "drive-file-123",
				name: "CSF",
				metadata: {},
			},
		});
		const input = {
			workspaceId: workspace.id,
			resourceId: resource.id,
			expectedUpdatedAt: resource.updatedAt,
			connectionScope: "tenant" as const,
		};
		const reader = createRouterClient(osWorkspacesContractRouter, {
			context: {
				...userContext(c.env, "org-1", "reader-1"),
				user: {
					...userContext(c.env, "org-1", "reader-1").user!,
					permissions: ["os:read"],
				},
			},
		});
		await expect(reader.resources.rebind(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(c.org2.resources.rebind(input)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		const rebound = await c.org1.resources.rebind(input);
		expect(rebound.resource).toMatchObject({
			id: resource.id,
			workspaceId: workspace.id,
			providerId: "google-drive",
			providerResourceId: "drive-file-123",
			resourceType: "file",
			connectionScope: "tenant",
			requiredScopes: ["drive.readonly"],
		});
		await expect(c.org1.resources.rebind(input)).rejects.toMatchObject({
			code: "CONFLICT",
		});
		const scoped = await c.org1.resources.rebind({
			...input,
			expectedUpdatedAt: rebound.resource.updatedAt,
			requiredScopes: ["https://www.googleapis.com/auth/drive.readonly"],
		});
		expect(scoped.resource.requiredScopes).toEqual([
			"https://www.googleapis.com/auth/drive.readonly",
		]);
	});

	it("keeps provider references tenant-scoped and preserves removed evidence", async () => {
		const c = clients();
		const { workspace } = await c.org1.workspaces.create({ name: "Resources" });
		const { resource } = await c.org1.resources.create({
			workspaceId: workspace.id,
			selection: {
				providerId: "github",
				connectionScope: "tenant",
				requiredScopes: ["contents:read"],
				resourceType: "repository",
				providerResourceId: "tedix-hq/tedix",
				name: "Product repository",
				metadata: { url: "https://github.com/tedix-hq/tedix" },
			},
		});
		expect(resource).toMatchObject({
			organizationId: "org-1",
			workspaceId: workspace.id,
			providerResourceId: "tedix-hq/tedix",
			status: "active",
		});
		await expect(
			c.org2.resources.get({
				workspaceId: workspace.id,
				resourceId: resource.id,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		const renamed = await c.org1.resources.rename({
			workspaceId: workspace.id,
			resourceId: resource.id,
			name: "Primary repository",
			expectedUpdatedAt: resource.updatedAt,
		});
		expect(renamed.resource.name).toBe("Primary repository");
		const removed = await c.org1.resources.remove({
			workspaceId: workspace.id,
			resourceId: resource.id,
			expectedUpdatedAt: renamed.resource.updatedAt,
		});
		expect(removed.resource.status).toBe("removed");
		expect(
			await c.org1.resources.list({
				workspaceId: workspace.id,
				status: "removed",
				limit: 50,
			}),
		).toMatchObject({ items: [{ id: resource.id }], truncated: false });
	});
});

describe("workspace preferences", () => {
	it("keeps favorites and recency personal, org-scoped, and UUID keyed", async () => {
		const c = clients();
		const { workspace } = await c.org1.workspaces.create({
			name: "Operations",
		});
		const secondUser = createRouterClient(osWorkspacesContractRouter, {
			context: userContext(c.env, "org-1", "user-2"),
		});

		expect(await c.org1.workspacePreferences.list({})).toEqual({ items: [] });
		const touched = await c.org1.workspacePreferences.touch({
			workspaceId: workspace.id,
		});
		expect(touched.preference).toMatchObject({
			workspaceId: workspace.id,
			favorite: false,
			lastOpenedAt: expect.any(String),
		});

		const favorited = await c.org1.workspacePreferences.setFavorite({
			workspaceId: workspace.id,
			favorite: true,
		});
		expect(favorited.preference).toMatchObject({
			workspaceId: workspace.id,
			favorite: true,
			lastOpenedAt: touched.preference.lastOpenedAt,
		});
		expect(await c.org1.workspacePreferences.list({})).toEqual({
			items: [favorited.preference],
		});
		expect(await secondUser.workspacePreferences.list({})).toEqual({
			items: [],
		});
		expect(await c.org2.workspacePreferences.list({})).toEqual({ items: [] });
	});

	it("requires an owned workspace and a human user principal", async () => {
		const c = clients();
		const { workspace } = await c.org1.workspaces.create({
			name: "Operations",
		});

		await expect(
			c.org2.workspacePreferences.setFavorite({
				workspaceId: workspace.id,
				favorite: true,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(c.machine.workspacePreferences.list({})).rejects.toMatchObject(
			{
				code: "FORBIDDEN",
			},
		);
		await expect(
			c.machine.workspacePreferences.touch({ workspaceId: workspace.id }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("gadgets", () => {
	let c: ReturnType<typeof clients>;
	let workspaceId: string;
	beforeEach(async () => {
		c = clients();
		workspaceId = (await c.org1.workspaces.create({ name: "Operations" }))
			.workspace.id;
	});

	it("creates in a workspace the org owns and pins gets to the path workspace", async () => {
		const { gadget } = await c.org1.gadgets.create({
			workspaceId,
			name: "Inbox Triage",
		});
		expect(gadget).toMatchObject({
			workspaceId,
			status: "active",
			currentRevisionId: null,
		});

		const fetched = await c.org1.gadgets.get({
			workspaceId,
			gadgetId: gadget.id,
		});
		expect(fetched.currentRevision).toBeNull();

		// A real gadget id under a different workspace path must 404.
		const otherWorkspaceId = (
			await c.org1.workspaces.create({ name: "Research" })
		).workspace.id;
		await expect(
			c.org1.gadgets.get({
				workspaceId: otherWorkspaceId,
				gadgetId: gadget.id,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		// And another tenant cannot reach the workspace at all.
		await expect(
			c.org2.gadgets.create({ workspaceId, name: "Exfil" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			c.org1.gadgets.create({ workspaceId, name: "Inbox Triage" }),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("appends revisions, advances the pointer, and surfaces a lost CAS as typed CONFLICT", async () => {
		const { gadget } = await c.org1.gadgets.create({
			workspaceId,
			name: "Inbox Triage",
		});

		const first = await c.org1.gadgets.revise({
			workspaceId,
			gadgetId: gadget.id,
			manifest: { entry: "main.ts", capabilities: ["email:read"] },
			expectedRevision: 0,
		});
		expect(first.revision).toMatchObject({
			revision: 1,
			manifest: { entry: "main.ts", capabilities: ["email:read"] },
		});
		expect(first.gadget.currentRevisionId).toBe(first.revision.id);

		const second = await c.org1.gadgets.revise({
			workspaceId,
			gadgetId: gadget.id,
			manifest: { entry: "main.ts" },
			expectedRevision: 1,
			sourceArtifactRef: "r2://artifacts/gadget-v2.tar",
		});
		expect(second.revision.revision).toBe(2);
		expect(second.revision.sourceArtifactRef).toBe(
			"r2://artifacts/gadget-v2.tar",
		);

		// Stale guard: the store moved to 2, the caller still believes 1.
		await expect(
			c.org1.gadgets.revise({
				workspaceId,
				gadgetId: gadget.id,
				manifest: { entry: "main.ts" },
				expectedRevision: 1,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { expectedRevision: 1, currentRevision: 2 },
		});

		// Unguarded append still lands as max+1.
		const third = await c.org1.gadgets.revise({
			workspaceId,
			gadgetId: gadget.id,
			manifest: { entry: "main.ts" },
		});
		expect(third.revision.revision).toBe(3);

		const fetched = await c.org1.gadgets.get({
			workspaceId,
			gadgetId: gadget.id,
		});
		expect(fetched.currentRevision?.revision).toBe(3);

		const archived = await c.org1.gadgets.archive({
			workspaceId,
			gadgetId: gadget.id,
		});
		expect(archived.gadget.status).toBe("archived");
	});
});

describe("outputs", () => {
	let c: ReturnType<typeof clients>;
	beforeEach(() => {
		mocks.authorizeDerivedOutputSources.mockReset().mockResolvedValue(true);
		c = clients();
	});

	it("inherits a governed run's server-recorded resource access envelope", async () => {
		const runId = "9f1e2d3c-4b5a-4697-8899-aabbccddeeff";
		const accessEnvelope = {
			version: 1 as const,
			sources: [
				{
					workspaceResourceId: "00000000-0000-4000-8000-000000000001",
					workspaceId: "00000000-0000-4000-8000-000000000002",
					providerId: "github",
					resourceType: "repository",
					providerResourceId: "tedix-hq/tedix",
					connectionScope: "tenant" as const,
					requiredScopes: ["repo:read"],
					operations: ["read"],
				},
			],
		};
		await createOsGadgetExecution(createDbQueryClient(c.env.DB), {
			id: crypto.randomUUID(),
			organizationId: "org-1",
			workspaceId: "00000000-0000-4000-8000-000000000002",
			gadgetId: crypto.randomUUID(),
			status: "running",
			grantedCapabilities: "[]",
			policyDecision: '{"allowed":true,"reasons":[]}',
			runId,
			resourceAccessEnvelope: JSON.stringify(accessEnvelope),
			createdByKind: "tedi",
			createdById: "tedi-1",
		});
		const context = apiKeyContext(c.env, "org-1");
		context.serviceAccount = { clientId: "skill-runtime" };
		context.headers = new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Tedi-Scopes": "apps:write",
			"X-Tedix-Auth-Client-Id": "skill-runtime",
			"X-Tedix-Skill-Run-Id": runId,
		});
		const producer = createRouterClient(osWorkspacesContractRouter, {
			context,
		});
		const created = await producer.outputs.create({
			kind: "document",
			title: "Derived brief",
		});
		expect(created.revision.accessEnvelope).toEqual(accessEnvelope);
	});

	it("denies direct reads, edits, and previews after source access is revoked", async () => {
		mocks.authorizeDerivedOutputSources.mockResolvedValue(true);
		const created = await c.org1.outputs.create({
			kind: "document",
			title: "Protected brief",
			content: {
				kind: "document",
				blocks: [{ type: "paragraph", text: "protected source" }],
			},
		});
		expect(
			(await c.org1.outputs.get({ outputId: created.output.id }))
				.currentRevision.content,
		).toMatchObject({ kind: "document" });

		mocks.authorizeDerivedOutputSources.mockResolvedValue(false);
		await expect(
			c.org1.outputs.get({ outputId: created.output.id }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			c.org1.outputs.revise({
				outputId: created.output.id,
				content: { kind: "document", blocks: [] },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			c.org1.outputs.patchDocument({
				outputId: created.output.id,
				expectedRevision: 1,
				ops: [
					{
						op: "insert",
						index: 1,
						block: { type: "paragraph", text: "must not be appended" },
					},
				],
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			c.org1.outputs.export({ outputId: created.output.id, format: "docx" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		const library = await c.org1.outputs.library({ limit: 20 });
		expect(library.items).toEqual([
			expect.objectContaining({
				output: expect.objectContaining({ id: created.output.id }),
				preview: {
					kind: "unavailable",
					reason: "source_access_unavailable",
				},
			}),
		]);
		mocks.authorizeDerivedOutputSources.mockResolvedValue(true);
		const unchanged = await c.org1.outputs.get({ outputId: created.output.id });
		expect(unchanged.currentRevision).toMatchObject({
			revision: 1,
			content: {
				kind: "document",
				blocks: [{ type: "paragraph", text: "protected source" }],
			},
		});
	});

	it("reveals a Home authoring link only with conversation read access", async () => {
		const created = await c.org1.outputs.create({
			kind: "document",
			title: "Authored",
		});
		const db = createDbClient(c.env.DB);
		const readerContext = userContext(c.env, "org-1");
		readerContext.user!.permissions.push("tedis:read");
		const reader = createRouterClient(osWorkspacesContractRouter, {
			context: readerContext,
		});
		await db.insert(kernelRuntimeRuns).values({
			id: "home-author",
			organizationId: "org-1",
			conversationId: "private-conversation",
			status: "completed",
			createdAt: "2026-09-20",
			updatedAt: "2026-09-20",
			metadata: {
				kernelEvidence: { toolName: "os.create_os_output" },
				kernelOutputReceipt: {
					outputId: created.output.id,
					revisionId: created.revision.id,
				},
			},
		});
		expect(
			(await reader.outputs.get({ outputId: created.output.id }))
				.authoringHomeRun,
		).toEqual({ runId: "home-author" });
		expect(
			(await c.machine.outputs.get({ outputId: created.output.id }))
				.authoringHomeRun,
		).toBeNull();
		await db.insert(kernelConversationGrants).values({
			id: "grant-1",
			organizationId: "org-1",
			conversationId: "private-conversation",
			granteeDescopeUserId: "other-user",
			access: "owner",
			createdAt: "2026-09-20",
			updatedAt: "2026-09-20",
		});
		const denied = await reader.outputs.get({ outputId: created.output.id });
		expect(denied.authoringHomeRun).toBeNull();
		expect(denied.output.id).toBe(created.output.id);
		expect(denied.currentRevision.producedBy).toBeNull();
	});

	it("creates each format with revision 1 and rejects a mismatched body", async () => {
		const doc = await c.org1.outputs.create({
			kind: "document",
			title: "Launch brief",
			content: {
				kind: "document",
				blocks: [
					{ type: "heading", level: 1, text: "Launch" },
					{ type: "paragraph", text: "Ship the Tedix OS." },
				],
			},
		});
		expect(doc.output).toMatchObject({
			kind: "document",
			status: "active",
			currentRevisionId: doc.revision.id,
			workspaceId: null,
		});
		expect(doc.revision).toMatchObject({ revision: 1 });

		const sheet = await c.org1.outputs.create({
			kind: "sheet",
			title: "Pipeline",
			content: {
				kind: "sheet",
				columns: ["Deal", "Value"],
				rows: [
					["Acme", 1200],
					["Globex", 800],
				],
			},
		});
		expect(sheet.revision.content).toMatchObject({ kind: "sheet" });

		await expect(
			c.org1.outputs.create({
				kind: "presentation",
				title: "Mismatch",
				content: { kind: "document", blocks: [] },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		// A workspaceId must exist in the caller's organization.
		await expect(
			c.org1.outputs.create({
				kind: "document",
				title: "Orphan",
				workspaceId: "0b90b0e2-14da-4a34-bd35-a416ab604f25",
				content: { kind: "document", blocks: [] },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		const listed = await c.org1.outputs.list({});
		expect(listed.items).toHaveLength(2);
		expect((await c.org1.outputs.list({ kind: "sheet" })).items).toHaveLength(
			1,
		);
		// Omitting the body creates the empty artifact of that kind. The content
		// schema is a four-way union of nested block unions -- ~10KB projected as
		// a tool schema -- and requiring it made "create me a document" fail from
		// a chat turn while the identical call with a hand-built body succeeded.
		for (const [kind, empty] of [
			["document", { kind: "document", blocks: [] }],
			["sheet", { kind: "sheet", columns: [], rows: [] }],
			["presentation", { kind: "presentation", slides: [] }],
		] as const) {
			const created = await c.org1.outputs.create({
				kind,
				title: `Empty ${kind}`,
			});
			expect(created.output.kind).toBe(kind);
			expect(created.revision.revision).toBe(1);
			expect(created.revision.content).toMatchObject(empty);
		}

		// A video has no empty form: without a renderId it names nothing.
		await expect(
			c.org1.outputs.create({ kind: "video", title: "No render" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		// Another tenant sees nothing.
		expect((await c.org2.outputs.list({})).items).toHaveLength(0);
	});

	it("revises with CAS, enforces kind stability, and archives in scope", async () => {
		const { output } = await c.org1.outputs.create({
			kind: "presentation",
			title: "Board deck",
			content: {
				kind: "presentation",
				slides: [{ title: "Q3", bullets: ["Revenue"] }],
			},
		});

		const second = await c.org1.outputs.revise({
			outputId: output.id,
			content: {
				kind: "presentation",
				slides: [
					{ title: "Q3", bullets: ["Revenue", "Churn"] },
					{ title: "Q4 plan", bullets: [] },
				],
			},
			note: "added Q4",
			expectedRevision: 1,
		});
		expect(second.revision).toMatchObject({ revision: 2, note: "added Q4" });
		expect(second.output.currentRevisionId).toBe(second.revision.id);

		// Stale CAS surfaces the typed conflict.
		await expect(
			c.org1.outputs.revise({
				outputId: output.id,
				content: { kind: "presentation", slides: [] },
				expectedRevision: 1,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { expectedRevision: 1, currentRevision: 2 },
		});

		// The format is fixed at creation.
		await expect(
			c.org1.outputs.revise({
				outputId: output.id,
				content: { kind: "document", blocks: [] },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		const fetched = await c.org1.outputs.get({ outputId: output.id });
		expect(fetched.currentRevision.revision).toBe(2);
		await expect(
			c.org2.outputs.get({ outputId: output.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			c.org2.outputs.archive({ outputId: output.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		const archived = await c.org1.outputs.archive({ outputId: output.id });
		expect(archived.output.status).toBe("archived");
		await expect(
			c.org2.outputs.delete({ outputId: output.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			c.org1.outputs.delete({ outputId: output.id }),
		).resolves.toEqual({ deleted: true });
		await expect(
			c.org1.outputs.get({ outputId: output.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("lists safe previews and provenance, survives workspace archive, and renames without revising", async () => {
		const { workspace } = await c.org1.workspaces.create({
			name: "Q3 planning",
		});
		const document = await c.org1.outputs.create({
			workspaceId: workspace.id,
			kind: "document",
			title: "Launch brief",
			content: {
				kind: "document",
				blocks: [
					{ type: "heading", level: 1, text: "Launch plan" },
					{ type: "paragraph", text: "Ship the governed workspace." },
				],
			},
		});
		await c.machine.outputs.create({
			workspaceId: workspace.id,
			kind: "sheet",
			title: "Pipeline",
			content: {
				kind: "sheet",
				columns: ["Deal", "Value"],
				rows: [["Acme", 1200]],
			},
		});
		await c.machine.outputs.create({
			workspaceId: workspace.id,
			kind: "presentation",
			title: "Board deck",
			content: {
				kind: "presentation",
				slides: [{ title: "Q3", bullets: ["Revenue", "Retention"] }],
			},
		});
		await c.org1.workspaces.archive({ workspaceId: workspace.id });

		const library = await c.org1.outputs.library({ status: "active" });
		expect(library.items).toHaveLength(3);
		expect(
			library.items.every((item) => item.workspace?.status === "archived"),
		).toBe(true);
		expect(
			library.items.find((item) => item.output.kind === "document"),
		).toMatchObject({
			scope: "mine",
			workspace: { name: "Q3 planning", status: "archived" },
			preview: {
				kind: "document",
				lines: ["Launch plan", "Ship the governed workspace."],
				blockCount: 2,
			},
		});
		expect(
			library.items.find((item) => item.output.kind === "sheet"),
		).toMatchObject({
			scope: "organization",
			preview: {
				kind: "sheet",
				columns: ["Deal", "Value"],
				rows: [["Acme", 1200]],
			},
		});
		expect(
			library.items.find((item) => item.output.kind === "presentation"),
		).toMatchObject({
			preview: {
				kind: "presentation",
				title: "Q3",
				bullets: ["Revenue", "Retention"],
				slideCount: 1,
			},
		});
		expect((await c.org2.outputs.library({})).items).toHaveLength(0);

		const renamed = await c.org1.outputs.rename({
			outputId: document.output.id,
			title: "Launch brief approved",
		});
		expect(renamed.output).toMatchObject({
			title: "Launch brief approved",
			currentRevisionId: document.revision.id,
		});
		expect(
			(await c.org1.outputs.get({ outputId: document.output.id }))
				.currentRevision.revision,
		).toBe(1);
		await expect(
			c.org2.outputs.rename({ outputId: document.output.id, title: "Nope" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("patches a presentation slide by slide and never drops its deck", async () => {
		const created = await c.org1.outputs.create({
			kind: "presentation",
			title: "Deck patching",
		});
		const id = created.output.id;
		expect(created.revision.content).toMatchObject({ slides: [] });

		// Insert two slides from outlines. The router lays out the canvas, so a
		// caller describes a slide instead of positioning elements.
		const two = await c.org1.outputs.patchSlides({
			outputId: id,
			ops: [
				{ op: "insert", index: 0, slide: { title: "Second", bullets: [] } },
				{
					op: "insert",
					index: 0,
					slide: { title: "First", bullets: ["alpha", "beta"], notes: "hello" },
				},
			],
		});
		const body = two.revision.content;
		if (body.kind !== "presentation") throw new Error("expected presentation");
		expect(body.slides.map((slide) => slide.title)).toEqual([
			"First",
			"Second",
		]);
		expect(body.slides[0]?.bullets).toEqual(["alpha", "beta"]);
		expect(body.slides[0]?.notes).toBe("hello");
		// The deck is the primary body and must exist, laid out in its own
		// coordinates, with the projection derived from it.
		expect(body.deck?.slides).toHaveLength(2);
		expect(body.deck?.width).toBe(1_200);
		const titleElement = body.deck?.slides[0]?.elements.find(
			(element) => element.type === "title",
		);
		expect(titleElement?.text).toBe("First");

		// Move, replace and delete all address the evolving list in order.
		const moved = await c.org1.outputs.patchSlides({
			outputId: id,
			ops: [
				{ op: "move", from: 0, to: 1 },
				{
					op: "replace",
					index: 0,
					slide: { title: "Second edited", bullets: ["x"] },
				},
			],
		});
		const movedBody = moved.revision.content;
		if (movedBody.kind !== "presentation") throw new Error("expected deck");
		expect(movedBody.slides.map((slide) => slide.title)).toEqual([
			"Second edited",
			"First",
		]);
		// A replace keeps the slide's identity rather than minting a new one.
		expect(movedBody.deck?.slides[0]?.id).toBe(body.deck?.slides[1]?.id);

		const deleted = await c.org1.outputs.patchSlides({
			outputId: id,
			ops: [{ op: "delete", index: 0 }],
		});
		const deletedBody = deleted.revision.content;
		if (deletedBody.kind !== "presentation") throw new Error("expected deck");
		expect(deletedBody.slides.map((slide) => slide.title)).toEqual(["First"]);
		// activeSlideId must still name a slide that exists.
		expect(
			deletedBody.deck?.slides.some(
				(slide) => slide.id === deletedBody.deck?.activeSlideId,
			),
		).toBe(true);

		// Out-of-range and wrong-kind both refuse.
		await expect(
			c.org1.outputs.patchSlides({
				outputId: id,
				ops: [{ op: "delete", index: 9 }],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		const doc = await c.org1.outputs.create({
			kind: "document",
			title: "Not a deck",
		});
		await expect(
			c.org1.outputs.patchSlides({
				outputId: doc.output.id,
				ops: [
					{ op: "insert", index: 0, slide: { title: "nope", bullets: [] } },
				],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

describe("collaboration proposals", () => {
	let c: ReturnType<typeof clients>;
	beforeEach(() => {
		c = clients();
	});

	async function outputFixture() {
		const { workspace } = await c.org1.workspaces.create({
			name: "Canvas room",
		});
		const created = await c.org1.outputs.create({
			workspaceId: workspace.id,
			kind: "document",
			title: "Launch brief",
			content: { kind: "document", blocks: [] },
		});
		return { workspace, ...created };
	}

	it("keeps streaming previews non-canonical until a separate accepted merge", async () => {
		const { workspace, output, revision } = await outputFixture();
		await expect(
			c.machine.collaboration.create({
				workspaceId: workspace.id,
				documentType: "output",
				documentId: output.id,
				sourceKind: "chat",
				sourceId: "caller-asserted-chat",
				content: { kind: "document", blocks: [] },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		const created = await c.machineAgent.collaboration.create({
			workspaceId: workspace.id,
			documentType: "output",
			documentId: output.id,
			sourceKind: "agent_session",
			sourceId: "codex:session-1",
			content: {
				kind: "document",
				blocks: [{ type: "paragraph", text: "first preview" }],
			},
		});
		expect(created.proposal).toMatchObject({
			baseRevisionId: revision.id,
			baseRevision: 1,
			status: "open",
			sequence: 0,
			createdByKind: "external_agent",
		});
		const otherProducer = createRouterClient(osWorkspacesContractRouter, {
			context: {
				...apiKeyContext(c.env, "org-1"),
				externalAgentSessionId: "codex:other-session",
				externalAgentPrincipalId: "external-agent-2",
			},
		});
		await expect(
			otherProducer.collaboration.updatePreview({
				proposalId: created.proposal.id,
				expectedSequence: 0,
				content: { kind: "document", blocks: [] },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		const preview = await c.machineAgent.collaboration.updatePreview({
			proposalId: created.proposal.id,
			expectedSequence: 0,
			content: {
				kind: "document",
				blocks: [{ type: "paragraph", text: "final preview" }],
			},
		});
		expect(preview.proposal.sequence).toBe(1);
		await expect(
			c.machineAgent.collaboration.updatePreview({
				proposalId: created.proposal.id,
				expectedSequence: 0,
				content: { kind: "document", blocks: [] },
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });

		await c.org1.collaboration.accept({
			proposalId: created.proposal.id,
			expectedSequence: 1,
			rationale: "Human reviewed the final streamed preview",
			evidenceRefs: ["canvas://review/session-1"],
		});
		expect(
			(await c.org1.outputs.get({ outputId: output.id })).currentRevision
				.revision,
		).toBe(1);
		const merged = await c.org1.collaboration.merge({
			proposalId: created.proposal.id,
			expectedSequence: 1,
			rationale: "Approved for the immutable history",
			evidenceRefs: ["canvas://review/session-1"],
		});
		expect(merged).toMatchObject({
			proposal: { status: "merged", resultRevision: 2 },
			revision: { revision: 2 },
		});
		await expect(
			c.org1.outputs.get({ outputId: output.id }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("audits rejection without changing the canonical revision and enforces tenant scope", async () => {
		const { workspace, output } = await outputFixture();
		const { proposal } = await c.machineAgent.collaboration.create({
			workspaceId: workspace.id,
			documentType: "output",
			documentId: output.id,
			sourceKind: "agent_session",
			sourceId: "codex:session-1",
			content: { kind: "document", blocks: [] },
		});
		const rejected = await c.org1.collaboration.reject({
			proposalId: proposal.id,
			expectedSequence: 0,
			rationale: "The evidence did not support the edit",
			evidenceRefs: ["run://7/evidence"],
		});
		expect(rejected.proposal).toMatchObject({
			status: "rejected",
			decisionRationale: "The evidence did not support the edit",
			decisionEvidenceRefs: ["run://7/evidence"],
		});
		expect(
			(await c.org1.outputs.get({ outputId: output.id })).currentRevision
				.revision,
		).toBe(1);
		expect(
			(await c.org1.collaboration.list({ workspaceId: workspace.id })).items,
		).toHaveLength(1);
		await expect(
			c.org2.collaboration.get({ proposalId: proposal.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("rejects a merge if a human advanced the immutable base after acceptance", async () => {
		const { workspace, output } = await outputFixture();
		const { proposal } = await c.machineAgent.collaboration.create({
			workspaceId: workspace.id,
			documentType: "output",
			documentId: output.id,
			sourceKind: "agent_session",
			sourceId: "codex:session-1",
			content: {
				kind: "document",
				blocks: [{ type: "paragraph", text: "agent edit" }],
			},
		});
		await c.org1.collaboration.accept({
			proposalId: proposal.id,
			expectedSequence: 0,
			rationale: "Preview accepted",
		});
		await c.org1.outputs.revise({
			outputId: output.id,
			expectedRevision: 1,
			content: {
				kind: "document",
				blocks: [{ type: "paragraph", text: "human edit" }],
			},
		});
		await expect(
			c.org1.collaboration.merge({
				proposalId: proposal.id,
				expectedSequence: 0,
				rationale: "stale merge attempt",
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { expectedRevision: 1, currentRevision: 2 },
		});
		expect(
			(await c.org1.collaboration.get({ proposalId: proposal.id })).proposal
				.status,
		).toBe("accepted");
	});
});

describe("output patch verbs", () => {
	let c: ReturnType<typeof clients>;
	beforeEach(() => {
		c = clients();
	});

	it("applies document ops in order against the evolving list and CAS-persists", async () => {
		const { output } = await c.org1.outputs.create({
			kind: "document",
			title: "Launch brief",
			content: {
				kind: "document",
				blocks: [
					{ type: "heading", level: 1, text: "Launch" },
					{ type: "paragraph", text: "Old summary." },
					{ type: "paragraph", text: "Keep me." },
				],
			},
		});

		const patched = await c.org1.outputs.patchDocument({
			outputId: output.id,
			expectedRevision: 1,
			note: "headless edit",
			ops: [
				{
					op: "replace",
					index: 1,
					block: { type: "paragraph", text: "New summary." },
				},
				{ op: "delete", index: 2 },
				// After the delete the list has 2 blocks; appending at index 2 is valid.
				{ op: "insert", index: 2, block: { type: "quote", text: "Ship it." } },
			],
		});
		expect(patched.revision).toMatchObject({
			revision: 2,
			note: "headless edit",
		});
		expect(patched.output.currentRevisionId).toBe(patched.revision.id);
		expect(patched.revision.content).toEqual({
			kind: "document",
			blocks: [
				{ type: "heading", level: 1, text: "Launch" },
				{ type: "paragraph", text: "New summary." },
				{ type: "quote", text: "Ship it." },
			],
		});
	});

	it("rejects out-of-range indices, non-document outputs, and stale CAS", async () => {
		const { output } = await c.org1.outputs.create({
			kind: "document",
			title: "Bounds",
			content: {
				kind: "document",
				blocks: [{ type: "paragraph", text: "only block" }],
			},
		});

		// insert may append at length (1) but not beyond.
		await expect(
			c.org1.outputs.patchDocument({
				outputId: output.id,
				ops: [
					{ op: "insert", index: 2, block: { type: "paragraph", text: "x" } },
				],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		// replace/delete require an existing index.
		await expect(
			c.org1.outputs.patchDocument({
				outputId: output.id,
				ops: [
					{ op: "replace", index: 1, block: { type: "paragraph", text: "x" } },
				],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			c.org1.outputs.patchDocument({
				outputId: output.id,
				ops: [{ op: "delete", index: 1 }],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		// A failed patch persisted nothing.
		const unchanged = await c.org1.outputs.get({ outputId: output.id });
		expect(unchanged.currentRevision.revision).toBe(1);

		const sheet = await c.org1.outputs.create({
			kind: "sheet",
			title: "Not a doc",
			content: { kind: "sheet", columns: ["A"], rows: [] },
		});
		await expect(
			c.org1.outputs.patchDocument({
				outputId: sheet.output.id,
				ops: [{ op: "delete", index: 0 }],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		await c.org1.outputs.revise({
			outputId: output.id,
			content: {
				kind: "document",
				blocks: [{ type: "paragraph", text: "revision 2" }],
			},
		});
		await expect(
			c.org1.outputs.patchDocument({
				outputId: output.id,
				expectedRevision: 1,
				ops: [{ op: "delete", index: 0 }],
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { expectedRevision: 1, currentRevision: 2 },
		});

		// Cross-tenant patching never resolves the output.
		await expect(
			c.org2.outputs.patchDocument({
				outputId: output.id,
				ops: [{ op: "delete", index: 0 }],
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("writes a sheet rectangle, null-filling extended rows and short rows", async () => {
		const { output } = await c.org1.outputs.create({
			kind: "sheet",
			title: "Pipeline",
			content: {
				kind: "sheet",
				columns: ["Deal", "Value", "Won"],
				rows: [["Acme"]],
			},
		});

		const written = await c.org1.outputs.setSheetRange({
			outputId: output.id,
			startRow: 1,
			startColumn: 1,
			cells: [
				[1200, true],
				[800, false],
			],
			expectedRevision: 1,
		});
		expect(written.revision.revision).toBe(2);
		expect(written.revision.content).toEqual({
			kind: "sheet",
			columns: ["Deal", "Value", "Won"],
			rows: [["Acme"], [null, 1200, true], [null, 800, false]],
		});

		// Overwrite into the existing short row: it null-fills up to startColumn.
		const second = await c.org1.outputs.setSheetRange({
			outputId: output.id,
			startRow: 0,
			startColumn: 2,
			cells: [[true]],
		});
		expect(second.revision.revision).toBe(3);
		const content = second.revision.content;
		if (content.kind !== "sheet") throw new Error("expected sheet content");
		expect(content.rows[0]).toEqual(["Acme", null, true]);
	});

	it("preserves workbook formatting when a headless range write updates cells", async () => {
		const { output } = await c.org1.outputs.create({
			kind: "sheet",
			title: "Formatted workbook",
			content: {
				kind: "sheet",
				columns: ["Deal", "Value"],
				rows: [["Acme", 1200]],
				workbook: {
					activeSheetId: "pipeline",
					sheets: [
						{
							id: "pipeline",
							name: "Pipeline",
							columns: [
								{ id: "deal", label: "Deal", width: 140 },
								{ id: "value", label: "Value", width: 120 },
							],
							rows: [
								[
									{ input: "Acme", value: "Acme" },
									{
										input: "1200",
										value: 1200,
										format: { bold: true, numberFormat: "currency" },
									},
								],
							],
							frozenRows: 1,
							frozenColumns: 1,
						},
					],
				},
			},
		});
		const written = await c.org1.outputs.setSheetRange({
			outputId: output.id,
			startRow: 0,
			startColumn: 1,
			cells: [[1500]],
		});
		const content = written.revision.content;
		if (content.kind !== "sheet") throw new Error("expected sheet");
		expect(content.rows).toEqual([["Acme", 1500]]);
		expect(content.workbook?.sheets[0]?.rows[0]?.[1]).toEqual({
			input: "1500",
			value: 1500,
			format: { bold: true, numberFormat: "currency" },
		});
		expect(content.workbook?.sheets[0]).toMatchObject({
			frozenRows: 1,
			frozenColumns: 1,
		});
	});

	it("refuses column growth, the row cap, non-sheet outputs, and stale CAS", async () => {
		const { output } = await c.org1.outputs.create({
			kind: "sheet",
			title: "Bounds",
			content: { kind: "sheet", columns: ["A", "B"], rows: [] },
		});

		// startColumn + width beyond the column count: columns are editor-added.
		await expect(
			c.org1.outputs.setSheetRange({
				outputId: output.id,
				startRow: 0,
				startColumn: 1,
				cells: [["x", "y"]],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		// The write may extend rows only up to the 1000-row cap.
		await expect(
			c.org1.outputs.setSheetRange({
				outputId: output.id,
				startRow: 1000,
				startColumn: 0,
				cells: [["x"]],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		const doc = await c.org1.outputs.create({
			kind: "document",
			title: "Not a sheet",
			content: { kind: "document", blocks: [] },
		});
		await expect(
			c.org1.outputs.setSheetRange({
				outputId: doc.output.id,
				startRow: 0,
				startColumn: 0,
				cells: [["x"]],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		await c.org1.outputs.revise({
			outputId: output.id,
			content: { kind: "sheet", columns: ["A", "B"], rows: [["v", "w"]] },
		});
		await expect(
			c.org1.outputs.setSheetRange({
				outputId: output.id,
				startRow: 0,
				startColumn: 0,
				cells: [["x"]],
				expectedRevision: 1,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { expectedRevision: 1, currentRevision: 2 },
		});
	});
});

describe("output export", () => {
	const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

	function exportEnv(overrides: {
		pdfBytes?: Uint8Array;
		pngBytes?: Uint8Array;
		withBrowser?: boolean;
	}) {
		const env = createEnv();
		const calls: Array<{ action: string; payload: Record<string, unknown> }> =
			[];
		const puts: Array<{
			key: string;
			size: number;
			contentType: string | undefined;
		}> = [];
		const metadata: Array<{
			key: string;
			customMetadata: Record<string, string> | undefined;
		}> = [];
		if (overrides.withBrowser !== false) {
			(env as Record<string, unknown>).BROWSER = {
				quickAction: async (
					action: string,
					payload: Record<string, unknown>,
				) => {
					calls.push({ action, payload });
					if (action === "pdf") {
						return new Response(
							overrides.pdfBytes ?? new Uint8Array([1, 2, 3]),
							{
								headers: { "content-type": "application/pdf" },
							},
						);
					}
					return new Response(
						overrides.pngBytes ?? new Uint8Array([...PNG_MAGIC, 0, 0]),
						{ headers: { "content-type": "image/png" } },
					);
				},
			};
		}
		const bodies = new Map<string, Uint8Array>();
		(env as Record<string, unknown>).R2_BUCKET = {
			put: async (
				key: string,
				value: Uint8Array,
				options?: {
					httpMetadata?: { contentType?: string };
					customMetadata?: Record<string, string>;
				},
			) => {
				puts.push({
					key,
					size: value.byteLength,
					contentType: options?.httpMetadata?.contentType,
				});
				bodies.set(key, value);
				metadata.push({ key, customMetadata: options?.customMetadata });
				return { key };
			},
		};
		return { env, calls, puts, bodies, metadata };
	}

	it("renders, prints, stores, and links a PDF export of the current revision", async () => {
		const { env, calls, puts } = exportEnv({
			pdfBytes: new Uint8Array([37, 80, 68, 70]),
		});
		const client = createRouterClient(osWorkspacesContractRouter, {
			context: userContext(env, "org-1"),
		});
		const { output } = await client.outputs.create({
			kind: "document",
			title: "Launch <brief>",
			content: {
				kind: "document",
				blocks: [{ type: "paragraph", text: "Ship the Tedix OS." }],
			},
		});

		const exported = await client.outputs.export({
			outputId: output.id,
			format: "pdf",
		});
		expect(exported).toMatchObject({
			key: `os-exports/org-1/${output.id}/rev-1.pdf`,
			format: "pdf",
			revision: 1,
			sizeBytes: 4,
			url: `https://api.tedix.test/os-exports/${output.id}/rev-1.pdf`,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.action).toBe("pdf");
		const html = String(calls[0]?.payload.html);
		// The Browser Rendering payload is the escaped, self-contained document.
		expect(html).toContain("Launch &lt;brief&gt;");
		expect(html).toContain("Ship the Tedix OS.");
		expect(puts).toEqual([
			{
				key: `os-exports/org-1/${output.id}/rev-1.pdf`,
				size: 4,
				contentType: "application/pdf",
			},
		]);
	});

	it("exports a PNG through the screenshot action with image validation", async () => {
		const { env, calls, puts } = exportEnv({});
		const client = createRouterClient(osWorkspacesContractRouter, {
			context: userContext(env, "org-1"),
		});
		const { output } = await client.outputs.create({
			kind: "sheet",
			title: "Pipeline",
			content: { kind: "sheet", columns: ["Deal"], rows: [["Acme"]] },
		});

		const exported = await client.outputs.export({
			outputId: output.id,
			format: "png",
		});
		expect(exported.key).toBe(`os-exports/org-1/${output.id}/rev-1.png`);
		expect(exported.format).toBe("png");
		expect(calls[0]?.action).toBe("screenshot");
		expect(puts[0]?.contentType).toBe("image/png");

		// Non-image screenshot bytes are refused instead of stored.
		const broken = exportEnv({ pngBytes: new Uint8Array([1, 2, 3]) });
		const brokenClient = createRouterClient(osWorkspacesContractRouter, {
			context: userContext(broken.env, "org-1"),
		});
		const other = await brokenClient.outputs.create({
			kind: "sheet",
			title: "Broken",
			content: { kind: "sheet", columns: ["A"], rows: [] },
		});
		await expect(
			brokenClient.outputs.export({ outputId: other.output.id, format: "png" }),
		).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
		expect(broken.puts).toHaveLength(0);
	});

	it("writes a real xlsx from the sheet model, without Browser Rendering", async () => {
		// No BROWSER binding at all: an Office export is generated from the
		// content model, so it must not depend on the rendering path.
		const { env, calls, puts, bodies, metadata } = exportEnv({
			withBrowser: false,
		});
		const client = createRouterClient(osWorkspacesContractRouter, {
			context: userContext(env, "org-1"),
		});
		const { output } = await client.outputs.create({
			kind: "sheet",
			title: "Pipeline",
			content: {
				kind: "sheet",
				columns: ["Deal", "Amount"],
				rows: [
					["Acme", 1_200],
					["Globex", 800],
				],
			},
		});

		const exported = await client.outputs.export({
			outputId: output.id,
			format: "xlsx",
		});
		expect(calls).toHaveLength(0);
		expect(exported).toMatchObject({
			key: `os-exports/org-1/${output.id}/rev-1.xlsx`,
			format: "xlsx",
			revision: 1,
			url: `https://api.tedix.test/os-exports/${output.id}/rev-1.xlsx`,
		});
		expect(puts[0]?.contentType).toBe(
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		);
		expect(metadata[0]?.customMetadata).toMatchObject({
			organizationId: "org-1",
			outputId: output.id,
			revision: "1",
		});

		// Read the stored bytes back as a workbook: the cells have to be there.
		const parts = unzipSync(bodies.get(exported.key)!);
		const sheet = new TextDecoder().decode(parts["xl/worksheets/sheet1.xml"]!);
		expect(sheet).toContain('<t xml:space="preserve">Acme</t>');
		expect(sheet).toContain("<v>1200</v>");
		expect(new TextDecoder().decode(parts["xl/workbook.xml"]!)).toContain(
			'name="Sheet1"',
		);
	});

	it("writes a docx from a document and a pptx from a deck", async () => {
		const { env, bodies, puts } = exportEnv({ withBrowser: false });
		const client = createRouterClient(osWorkspacesContractRouter, {
			context: userContext(env, "org-1"),
		});
		const { output: document } = await client.outputs.create({
			kind: "document",
			title: "Launch brief",
			content: {
				kind: "document",
				blocks: [{ type: "paragraph", text: "Ship the Tedix OS." }],
			},
		});
		const docxExport = await client.outputs.export({
			outputId: document.id,
			format: "docx",
		});
		expect(docxExport.key).toBe(`os-exports/org-1/${document.id}/rev-1.docx`);
		expect(
			new TextDecoder().decode(
				unzipSync(bodies.get(docxExport.key)!)["word/document.xml"]!,
			),
		).toContain("Ship the Tedix OS.");

		const { output: deck } = await client.outputs.create({
			kind: "presentation",
			title: "Quarterly",
			content: {
				kind: "presentation",
				slides: [{ title: "Q3", bullets: ["Up 12%"] }],
			},
		});
		const pptxExport = await client.outputs.export({
			outputId: deck.id,
			format: "pptx",
		});
		expect(pptxExport.key).toBe(`os-exports/org-1/${deck.id}/rev-1.pptx`);
		expect(
			new TextDecoder().decode(
				unzipSync(bodies.get(pptxExport.key)!)["ppt/slides/slide1.xml"]!,
			),
		).toContain("<a:t>Up 12%</a:t>");
		expect(puts.map((put) => put.contentType)).toEqual([
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		]);
	});

	it("refuses a format that does not apply to the output kind", async () => {
		const { env, puts } = exportEnv({});
		const client = createRouterClient(osWorkspacesContractRouter, {
			context: userContext(env, "org-1"),
		});
		const { output: sheet } = await client.outputs.create({
			kind: "sheet",
			title: "Pipeline",
			content: { kind: "sheet", columns: ["Deal"], rows: [] },
		});
		// A deck export of a spreadsheet is a category error, and hiding the
		// button in one client is not a refusal.
		await expect(
			client.outputs.export({ outputId: sheet.id, format: "pptx" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			client.outputs.export({ outputId: sheet.id, format: "docx" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		const { output: document } = await client.outputs.create({
			kind: "document",
			title: "Brief",
			content: { kind: "document", blocks: [] },
		});
		await expect(
			client.outputs.export({ outputId: document.id, format: "xlsx" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		// Nothing was stored for any refused export.
		expect(puts).toHaveLength(0);

		// The renderings stay available for every kind.
		const rendered = await client.outputs.export({
			outputId: sheet.id,
			format: "pdf",
		});
		expect(rendered.format).toBe("pdf");
	});

	it("fails BAD_REQUEST without the BROWSER binding and NOT_FOUND across tenants", async () => {
		const { env } = exportEnv({ withBrowser: false });
		const client = createRouterClient(osWorkspacesContractRouter, {
			context: userContext(env, "org-1"),
		});
		const { output } = await client.outputs.create({
			kind: "document",
			title: "No browser",
			content: { kind: "document", blocks: [] },
		});
		await expect(
			client.outputs.export({ outputId: output.id, format: "pdf" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		const otherTenant = createRouterClient(osWorkspacesContractRouter, {
			context: userContext(env, "org-2"),
		});
		await expect(
			otherTenant.outputs.export({ outputId: output.id, format: "pdf" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			client.outputs.export({
				outputId: "0b90b0e2-14da-4a34-bd35-a416ab604f25",
				format: "pdf",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("blueprints", () => {
	let c: ReturnType<typeof clients>;
	beforeEach(() => {
		c = clients();
	});

	it("drafts, revises with CAS, and publishes the current revision", async () => {
		const { blueprint } = await c.org1.blueprints.create({
			name: "Sales Pod",
		});
		expect(blueprint).toMatchObject({
			status: "draft",
			currentRevisionId: null,
		});

		// Publishing an empty draft is a caller error, not a conflict.
		await expect(
			c.org1.blueprints.publish({ blueprintId: blueprint.id }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		const revised = await c.org1.blueprints.revise({
			blueprintId: blueprint.id,
			definition: {
				gadgets: [{ name: "CRM", manifest: { entry: "crm.ts" } }],
			},
			expectedRevision: 0,
		});
		expect(revised.revision).toMatchObject({ revision: 1, publishedAt: null });
		expect(revised.blueprint.currentRevisionId).toBe(revised.revision.id);

		await expect(
			c.org1.blueprints.revise({
				blueprintId: blueprint.id,
				definition: { gadgets: [] },
				expectedRevision: 0,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { expectedRevision: 0, currentRevision: 1 },
		});

		const published = await c.org1.blueprints.publish({
			blueprintId: blueprint.id,
		});
		expect(published.blueprint.status).toBe("published");
		expect(published.revision.publishedAt).toEqual(expect.any(String));

		// Cross-tenant reads and writes stay closed.
		await expect(
			c.org2.blueprints.get({ blueprintId: blueprint.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			c.org2.blueprints.revise({
				blueprintId: blueprint.id,
				definition: { gadgets: [] },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		await expect(
			c.org1.blueprints.create({ name: "Sales Pod" }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		const listed = await c.org1.blueprints.list({ status: "published" });
		expect(listed.items).toHaveLength(1);

		await expect(
			c.org1.blueprints.delete({ blueprintId: blueprint.id }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			c.org2.blueprints.archive({ blueprintId: blueprint.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			c.org1.blueprints.archive({ blueprintId: blueprint.id }),
		).resolves.toMatchObject({
			blueprint: { status: "archived", visibility: "org" },
		});
		await expect(
			c.org1.blueprints.delete({ blueprintId: blueprint.id }),
		).resolves.toEqual({ deleted: true });
		await expect(
			c.org1.blueprints.get({ blueprintId: blueprint.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("instantiates a published revision as a workspace with pinned provenance", async () => {
		const { blueprint } = await c.org1.blueprints.create({ name: "Sales Pod" });

		// A draft cannot instantiate.
		await expect(
			c.org1.blueprints.instantiate({
				blueprintId: blueprint.id,
				workspaceName: "Sales EU",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		await c.org1.blueprints.revise({
			blueprintId: blueprint.id,
			definition: {
				gadgets: [
					{
						name: "CRM",
						manifest: { entry: "crm.ts", capabilities: ["email:read"] },
					},
					{
						name: "Pipeline",
						manifest: { entry: "pipe.ts", capabilities: [] },
					},
				],
			},
		});
		const published = await c.org1.blueprints.publish({
			blueprintId: blueprint.id,
		});

		const instantiated = await c.org1.blueprints.instantiate({
			blueprintId: blueprint.id,
			workspaceName: "Sales EU",
			description: "EU pod",
		});
		expect(instantiated.workspace).toMatchObject({
			name: "Sales EU",
			sourceBlueprintId: blueprint.id,
			sourceBlueprintRevisionId: published.revision.id,
			createdByKind: "user",
		});
		expect(instantiated.revision.id).toBe(published.revision.id);
		expect(instantiated.gadgets).toHaveLength(2);
		const crm = instantiated.gadgets.find((g) => g.gadget.name === "CRM");
		expect(crm?.revision).toMatchObject({
			revision: 1,
			manifest: { entry: "crm.ts", capabilities: ["email:read"] },
		});
		expect(crm?.gadget.currentRevisionId).toBe(crm?.revision.id);

		// The instantiated gadget is a first-class gadget on the canonical surface.
		const instantiatedGadget = await c.org1.gadgets.get({
			workspaceId: instantiated.workspace.id,
			gadgetId: crm?.gadget.id ?? "",
		});
		expect(instantiatedGadget.currentRevision?.manifest.capabilities).toEqual([
			"email:read",
		]);

		// A taken workspace name fails CONFLICT and materializes nothing new.
		await expect(
			c.org1.blueprints.instantiate({
				blueprintId: blueprint.id,
				workspaceName: "Sales EU",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		const workspaces = await c.org1.workspaces.list({});
		expect(workspaces.items).toHaveLength(1);

		// Cross-tenant blueprints are unreachable.
		await expect(
			c.org2.blueprints.instantiate({
				blueprintId: blueprint.id,
				workspaceName: "Sales EU",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("blueprint dependency preflight", () => {
	let c: ReturnType<typeof clients>;

	const TEDI_ID = "1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9";
	const RUNTIME_PROFILE_ID = "2a3b4c5d-6e7f-4081-9203-a4b5c6d7e8f9";
	// Fields mirror the producers exactly: `skill_entries` supplies
	// id/slug/revision/lifecycleState/files (packages/db/src/schema/cognitive.ts),
	// `policy_packs` supplies id/slug/scope/status/version
	// (schema/control-plane.ts), `runtime_profiles` supplies
	// id/slug/status/version/config (same file).
	const SKILL = {
		id: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
		slug: "lead-triage",
		revision: 4,
		lifecycleState: "active",
		files: { "scripts/workflow.ts": "export default async () => ({})" },
	};
	const POLICY_PACK = {
		id: "4d5e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f7a",
		slug: "revenue-ops",
		scope: "organization",
		status: "active",
		version: 2,
	};

	function requirements(overrides: Record<string, unknown> = {}) {
		return {
			version: 1 as const,
			skills: [
				{
					role: "skill" as const,
					skillId: SKILL.id,
					slug: SKILL.slug,
					revision: SKILL.revision,
					workflowSha256: null,
				},
			],
			connections: [],
			policies: [],
			runtime: null,
			layout: null,
			outputs: [],
			...overrides,
		};
	}

	/** A published one-gadget blueprint in org-1 carrying `requirements`. */
	async function publishPinned(
		definitionRequirements: Record<string, unknown> | null,
		name = "Sales Pod",
	): Promise<string> {
		const { blueprint } = await c.org1.blueprints.create({ name });
		await c.org1.blueprints.revise({
			blueprintId: blueprint.id,
			definition: {
				gadgets: [
					{ name: "CRM", manifest: { entry: "crm.ts", capabilities: [] } },
				],
				requirements: definitionRequirements,
			},
		});
		await c.org1.blueprints.publish({ blueprintId: blueprint.id });
		return blueprint.id;
	}

	beforeEach(() => {
		c = clients();
		mocks.getSkillEntryBySlug.mockReset();
		mocks.getPolicyPackBySlugForOrganization.mockReset();
		mocks.getRuntimeProfileById.mockReset();
		mocks.getTediById.mockReset();
		mocks.resolveConnectionAvailability.mockReset();
		mocks.authorizeDerivedOutputSources.mockReset().mockResolvedValue(true);
	});

	it("reports not_configured — never satisfied — for a revision with no requirements", async () => {
		const blueprintId = await publishPinned(null);
		const { preflight } = await c.org1.blueprints.preflight({ blueprintId });
		expect(preflight).toMatchObject({
			status: "not_configured",
			instantiateAllowed: true,
			requirements: null,
			decisions: [],
			blockingReasons: [],
			consentReasons: [],
			revision: 1,
		});
		expect(mocks.getSkillEntryBySlug).not.toHaveBeenCalled();
	});

	it("allows only the EXACT pin and carries the pin it read as evidence", async () => {
		mocks.getSkillEntryBySlug.mockResolvedValue(SKILL);
		const blueprintId = await publishPinned(requirements());

		const { preflight } = await c.org1.blueprints.preflight({ blueprintId });
		expect(preflight.status).toBe("ready");
		expect(preflight.instantiateAllowed).toBe(true);
		expect(preflight.decisions).toEqual([
			{
				kind: "skill",
				subject: "skill:lead-triage",
				verdict: "allowed",
				reason: "skill lead-triage resolved at the pinned revision 4",
				declaredPin: { id: SKILL.id, revision: 4, digest: null },
				resolvedPin: { id: SKILL.id, revision: 4, digest: null },
			},
		]);
		// The slug was resolved inside the caller's organization, positionally.
		expect(mocks.getSkillEntryBySlug).toHaveBeenCalledWith(
			expect.anything(),
			"org-1",
			"lead-triage",
		);
	});

	it("separates a moved revision (incompatible) from a missing slug (missing)", async () => {
		const blueprintId = await publishPinned(requirements());

		mocks.getSkillEntryBySlug.mockResolvedValue({ ...SKILL, revision: 6 });
		const moved = await c.org1.blueprints.preflight({ blueprintId });
		expect(moved.preflight.status).toBe("blocked");
		expect(moved.preflight.instantiateAllowed).toBe(false);
		expect(moved.preflight.decisions[0]).toMatchObject({
			verdict: "incompatible",
			declaredPin: { revision: 4 },
			resolvedPin: { id: SKILL.id, revision: 6 },
		});

		mocks.getSkillEntryBySlug.mockResolvedValue(undefined);
		const gone = await c.org1.blueprints.preflight({ blueprintId });
		expect(gone.preflight.decisions[0]).toMatchObject({
			verdict: "missing",
			// Nothing resolved, so nothing is claimed to have resolved.
			resolvedPin: null,
		});
	});

	it("denies when the slug is owned by a different skill row, and when it is archived", async () => {
		const blueprintId = await publishPinned(requirements());

		mocks.getSkillEntryBySlug.mockResolvedValue({
			...SKILL,
			id: "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a",
		});
		const impostor = await c.org1.blueprints.preflight({ blueprintId });
		expect(impostor.preflight.decisions[0]).toMatchObject({
			verdict: "denied",
			resolvedPin: { id: "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a" },
		});
		expect(impostor.preflight.decisions[0]?.reason).toContain(
			"is owned by a different skill",
		);

		mocks.getSkillEntryBySlug.mockResolvedValue({
			...SKILL,
			lifecycleState: "archived",
		});
		const archived = await c.org1.blueprints.preflight({ blueprintId });
		expect(archived.preflight.decisions[0]).toMatchObject({
			verdict: "denied",
			reason: "skill lead-triage is archived",
		});
	});

	it("treats a moved workflow digest as incompatible even at the pinned revision", async () => {
		const digest = await sha256Hex(SKILL.files["scripts/workflow.ts"]);
		const blueprintId = await publishPinned(
			requirements({
				skills: [
					{
						role: "flow",
						skillId: SKILL.id,
						slug: SKILL.slug,
						revision: SKILL.revision,
						workflowSha256: digest,
					},
				],
			}),
		);

		mocks.getSkillEntryBySlug.mockResolvedValue(SKILL);
		const matching = await c.org1.blueprints.preflight({ blueprintId });
		expect(matching.preflight.decisions[0]).toMatchObject({
			subject: "flow:lead-triage",
			verdict: "allowed",
			resolvedPin: { digest },
		});

		mocks.getSkillEntryBySlug.mockResolvedValue({
			...SKILL,
			files: { "scripts/workflow.ts": "export default async () => ({ v: 2 })" },
		});
		const drifted = await c.org1.blueprints.preflight({ blueprintId });
		expect(drifted.preflight.decisions[0]?.verdict).toBe("incompatible");
		expect(drifted.preflight.decisions[0]?.resolvedPin?.digest).not.toBe(
			digest,
		);
	});

	it("binds a policy-pack pin to the caller's organization and its version", async () => {
		const blueprintId = await publishPinned(
			requirements({
				skills: [],
				policies: [{ scope: "organization", slug: "revenue-ops", version: 2 }],
			}),
		);

		mocks.getPolicyPackBySlugForOrganization.mockResolvedValue(POLICY_PACK);
		const ready = await c.org1.blueprints.preflight({ blueprintId });
		expect(ready.preflight.decisions[0]).toMatchObject({
			kind: "policy_pack",
			subject: "organization:revenue-ops",
			verdict: "allowed",
			resolvedPin: { id: POLICY_PACK.id, revision: 2 },
		});
		expect(mocks.getPolicyPackBySlugForOrganization).toHaveBeenCalledWith(
			expect.anything(),
			"org-1",
			{ scope: "organization", slug: "revenue-ops", version: 2 },
		);

		mocks.getPolicyPackBySlugForOrganization.mockResolvedValue({
			...POLICY_PACK,
			version: 5,
		});
		const drifted = await c.org1.blueprints.preflight({ blueprintId });
		expect(drifted.preflight.decisions[0]?.verdict).toBe("incompatible");

		mocks.getPolicyPackBySlugForOrganization.mockResolvedValue({
			...POLICY_PACK,
			status: "draft",
		});
		const inactive = await c.org1.blueprints.preflight({ blueprintId });
		expect(inactive.preflight.decisions[0]?.verdict).toBe("denied");

		mocks.getPolicyPackBySlugForOrganization.mockResolvedValue(null);
		const absent = await c.org1.blueprints.preflight({ blueprintId });
		expect(absent.preflight.decisions[0]).toMatchObject({
			verdict: "missing",
			resolvedPin: null,
		});
	});

	it("resolves model compatibility against a tedi's profile, and stays `missing` without one", async () => {
		const blueprintId = await publishPinned(
			requirements({
				skills: [],
				runtime: {
					modelRef: null,
					minTier: "frontier",
					requiresReasoning: true,
				},
			}),
		);

		// No tedi supplied: nothing could be read, so nothing is assumed.
		const unresolved = await c.org1.blueprints.preflight({ blueprintId });
		expect(unresolved.preflight.decisions[0]).toMatchObject({
			kind: "model",
			verdict: "missing",
			resolvedPin: null,
		});
		expect(unresolved.preflight.status).toBe("blocked");

		mocks.getTediById.mockResolvedValue({
			id: TEDI_ID,
			organizationId: "org-1",
			slug: "cto",
			runtimeProfileId: RUNTIME_PROFILE_ID,
		});
		mocks.getRuntimeProfileById.mockResolvedValue({
			id: RUNTIME_PROFILE_ID,
			slug: "balanced",
			status: "active",
			version: 3,
			config: { modelPolicy: { chatModelRef: "azure-openai/gpt-5.6-terra" } },
		});
		const tooLow = await c.org1.blueprints.preflight({
			blueprintId,
			tediId: TEDI_ID,
		});
		expect(tooLow.preflight.decisions[0]).toMatchObject({
			kind: "model",
			verdict: "incompatible",
			resolvedPin: { id: "azure-openai/gpt-5.6-terra", revision: 3 },
		});

		mocks.getRuntimeProfileById.mockResolvedValue({
			id: RUNTIME_PROFILE_ID,
			slug: "frontier",
			status: "active",
			version: 3,
			config: { modelPolicy: { chatModelRef: "azure-openai/gpt-5.6-sol" } },
		});
		const satisfied = await c.org1.blueprints.preflight({
			blueprintId,
			tediId: TEDI_ID,
		});
		expect(satisfied.preflight.decisions[0]?.verdict).toBe("allowed");
		expect(satisfied.preflight.targetTediId).toBe(TEDI_ID);

		// An off-catalog ref cannot prove either verdict: unknown stays unknown.
		mocks.getRuntimeProfileById.mockResolvedValue({
			id: RUNTIME_PROFILE_ID,
			slug: "custom",
			status: "active",
			version: 3,
			config: { modelPolicy: { chatModelRef: "azure-openai/not-in-catalog" } },
		});
		const unknown = await c.org1.blueprints.preflight({
			blueprintId,
			tediId: TEDI_ID,
		});
		expect(unknown.preflight.decisions[0]?.verdict).toBe("missing");
	});

	it("checks layout and output declarations against the gadgets the same revision declares", async () => {
		const blueprintId = await publishPinned(
			requirements({
				skills: [],
				layout: {
					columns: 12,
					placements: [
						{ gadget: "CRM", column: 1, row: 1, width: 6, height: 1 },
					],
				},
				outputs: [{ gadget: "CRM", kind: "sheet", title: "Pipeline" }],
			}),
		);
		const ok = await c.org1.blueprints.preflight({ blueprintId });
		expect(ok.preflight.status).toBe("ready");
		expect(ok.preflight.decisions.map((d) => [d.kind, d.verdict])).toEqual([
			["layout", "allowed"],
			["output", "allowed"],
		]);

		const strayId = await publishPinned(
			requirements({
				skills: [],
				layout: {
					columns: 4,
					placements: [
						{ gadget: "CRM", column: 1, row: 1, width: 2, height: 1 },
						{ gadget: "Ghost", column: 3, row: 1, width: 1, height: 1 },
					],
				},
				outputs: [{ gadget: "Ghost", kind: "document", title: "Notes" }],
			}),
			"Stray Pod",
		);
		const stray = await c.org1.blueprints.preflight({ blueprintId: strayId });
		expect(stray.preflight.status).toBe("blocked");
		expect(stray.preflight.decisions.map((d) => d.verdict)).toEqual([
			"incompatible",
			"incompatible",
		]);
	});

	it("reports an unconnected connection as consent_required WITHOUT blocking instantiation", async () => {
		mocks.resolveConnectionAvailability.mockResolvedValue({
			connected: false,
			cause: "no_token",
			reason: "no active tenant connection satisfies the requested scopes",
		});
		mocks.getSkillEntryBySlug.mockResolvedValue(SKILL);
		const blueprintId = await publishPinned(
			requirements({
				connections: [
					{ providerId: "gmail", tokenScope: "tenant", scopes: ["gmail.send"] },
				],
			}),
		);

		const { preflight } = await c.org1.blueprints.preflight({ blueprintId });
		expect(preflight.status).toBe("needs_consent");
		expect(preflight.instantiateAllowed).toBe(true);
		expect(preflight.blockingReasons).toEqual([]);
		expect(preflight.consentReasons).toHaveLength(1);
		const connection = preflight.decisions.find((d) => d.kind === "connection");
		expect(connection).toMatchObject({
			subject: "gmail",
			verdict: "consent_required",
		});
		expect(connection?.reason).toContain("Adaptive Connect");

		// A platform gap no consent repairs stays `missing`, still non-blocking.
		mocks.resolveConnectionAvailability.mockResolvedValue({
			connected: false,
			cause: "provider_unregistered",
			reason: "connection provider gmail is not registered with Descope",
		});
		const unregistered = await c.org1.blueprints.preflight({ blueprintId });
		expect(unregistered.preflight.status).toBe("needs_consent");
		expect(unregistered.preflight.instantiateAllowed).toBe(true);
		expect(
			unregistered.preflight.decisions.find((d) => d.kind === "connection"),
		).toMatchObject({ verdict: "missing" });
	});

	it("distinguishes provider consent from concrete resource selection and materializes named slots", async () => {
		mocks.getSkillEntryBySlug.mockResolvedValue(SKILL);
		mocks.resolveConnectionAvailability.mockResolvedValue({
			connected: true,
			cause: "connected",
			reason: "active tenant connection satisfies the requested scopes",
		});
		const blueprintId = await publishPinned(
			requirements({
				resources: [
					{
						slot: "customer_repo",
						providerId: "github",
						tokenScope: "tenant",
						scopes: ["repo:read"],
						resourceType: "repository",
						label: "Customer repository",
					},
				],
			}),
			"Resource Pod",
		);

		const unresolved = await c.org1.blueprints.preflight({ blueprintId });
		expect(unresolved.preflight.status).toBe("needs_configuration");
		expect(unresolved.preflight.instantiateAllowed).toBe(false);
		expect(unresolved.preflight.decisions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "connection", verdict: "allowed" }),
				expect.objectContaining({
					kind: "workspace_resource",
					verdict: "missing",
				}),
			]),
		);

		const resourceBindings = [
			{
				slot: "customer_repo",
				selection: {
					providerId: "github",
					connectionScope: "tenant" as const,
					requiredScopes: ["repo:read"],
					resourceType: "repository",
					providerResourceId: "tedix-hq/tedix",
					name: "tedix-hq/tedix",
					metadata: { url: "https://github.com/tedix-hq/tedix" },
				},
			},
		];
		const resolved = await c.org1.blueprints.preflight({
			blueprintId,
			resourceBindings,
		});
		expect(resolved.preflight.status).toBe("ready");
		const result = await c.org1.blueprints.instantiate({
			blueprintId,
			workspaceName: "Resource Workspace",
			resourceBindings,
		});
		expect(result.resources).toEqual([
			expect.objectContaining({
				slot: "customer_repo",
				providerResourceId: "tedix-hq/tedix",
			}),
		]);
	});

	it("records the resolution as workspace provenance and refuses a blocked pin atomically", async () => {
		mocks.getSkillEntryBySlug.mockResolvedValue(SKILL);
		const blueprintId = await publishPinned(requirements());

		const instantiated = await c.org1.blueprints.instantiate({
			blueprintId,
			workspaceName: "Sales EU",
		});
		expect(instantiated.workspace).toMatchObject({
			sourceBlueprintId: blueprintId,
			sourceBlueprintRevisionId: instantiated.revision.id,
			sourceBlueprintRevisionNumber: 1,
		});
		// Persisted, then read back through the workspace read path.
		const readBack = await c.org1.workspaces.get({
			workspaceId: instantiated.workspace.id,
		});
		expect(readBack.workspace.instantiationPreflight).toEqual(
			instantiated.preflight,
		);
		expect(
			readBack.workspace.instantiationPreflight?.decisions[0],
		).toMatchObject({
			kind: "skill",
			verdict: "allowed",
			resolvedPin: { revision: 4 },
		});
		// Per-gadget lineage points at the exact declaring revision.
		expect(instantiated.gadgets[0]?.gadget.sourceBlueprintRevisionId).toBe(
			instantiated.revision.id,
		);

		// The pin then moves. Instantiation refuses and writes nothing.
		mocks.getSkillEntryBySlug.mockResolvedValue({ ...SKILL, revision: 9 });
		await expect(
			c.org1.blueprints.instantiate({
				blueprintId,
				workspaceName: "Sales APAC",
			}),
		).rejects.toMatchObject({ code: "UNPROCESSABLE_CONTENT" });
		const workspaces = await c.org1.workspaces.list({});
		expect(workspaces.items.map((item) => item.name)).toEqual(["Sales EU"]);
	});
});

describe("blueprint gallery", () => {
	let c: ReturnType<typeof clients>;
	beforeEach(() => {
		c = clients();
	});

	/** org-2 publishes a one-gadget blueprint to the cross-organization catalog. */
	async function publishGalleryBlueprint(name = "Sales Pod"): Promise<string> {
		const { blueprint } = await c.org2.blueprints.create({
			name,
			description: "Shared sales pod",
		});
		await c.org2.blueprints.revise({
			blueprintId: blueprint.id,
			definition: {
				gadgets: [
					{
						name: "CRM",
						manifest: { entry: "crm.ts", capabilities: ["email:read"] },
					},
				],
			},
		});
		await c.org2.blueprints.publish({ blueprintId: blueprint.id });
		await c.org2.blueprints.setVisibility({
			blueprintId: blueprint.id,
			visibility: "catalog",
		});
		return blueprint.id;
	}

	it("gates visibility on publish and binds the write to the owning tenant", async () => {
		const { blueprint } = await c.org1.blueprints.create({ name: "Draft Pod" });
		expect(blueprint.visibility).toBe("org");

		// A draft cannot enter the catalog.
		await expect(
			c.org1.blueprints.setVisibility({
				blueprintId: blueprint.id,
				visibility: "catalog",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		await c.org1.blueprints.revise({
			blueprintId: blueprint.id,
			definition: { gadgets: [] },
		});
		await c.org1.blueprints.publish({ blueprintId: blueprint.id });

		// Another tenant cannot flip the flag on a blueprint it does not own.
		await expect(
			c.org2.blueprints.setVisibility({
				blueprintId: blueprint.id,
				visibility: "catalog",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		const updated = await c.org1.blueprints.setVisibility({
			blueprintId: blueprint.id,
			visibility: "catalog",
		});
		expect(updated.blueprint.visibility).toBe("catalog");
		// The flag round-trips through ordinary reads.
		const listed = await c.org1.blueprints.list({});
		expect(listed.items[0]?.visibility).toBe("catalog");

		const retracted = await c.org1.blueprints.setVisibility({
			blueprintId: blueprint.id,
			visibility: "org",
		});
		expect(retracted.blueprint.visibility).toBe("org");
	});

	it("lists catalog blueprints across organizations with only the gallery fields", async () => {
		const blueprintId = await publishGalleryBlueprint();
		// A published but org-private blueprint stays out of the gallery.
		await c.org1.blueprints.create({ name: "Private Pod" });
		await c.org1.blueprints.revise({
			blueprintId: (await c.org1.blueprints.list({})).items[0]!.id,
			definition: { gadgets: [] },
		});

		const gallery = await c.org1.blueprints.gallery({});
		expect(gallery.items).toHaveLength(1);
		expect(gallery.items[0]).toEqual({
			id: blueprintId,
			name: "Sales Pod",
			description: "Shared sales pod",
			gadgetCount: 1,
			organizationName: "Second Org",
			publishedAt: expect.any(String),
		});
	});

	it("instantiates a gallery blueprint as a published in-org copy with provenance", async () => {
		const sourceId = await publishGalleryBlueprint();

		const result = await c.org1.blueprints.instantiateFromGallery({
			blueprintId: sourceId,
			workspaceName: "Sales US",
		});
		// The copy is a first-class published blueprint in the CALLER's org…
		expect(result.blueprint).toMatchObject({
			organizationId: "org-1",
			name: "Sales Pod",
			status: "published",
			visibility: "org",
		});
		expect(result.blueprint.id).not.toBe(sourceId);
		expect(result.blueprint.description).toContain(
			`Imported from the blueprint gallery: "Sales Pod" by Second Org (blueprint ${sourceId}, revision 1).`,
		);
		expect(result.blueprint.description).toContain("Shared sales pod");
		// …with the copied revision as its own revision 1…
		expect(result.revision).toMatchObject({
			organizationId: "org-1",
			blueprintId: result.blueprint.id,
			revision: 1,
			definition: {
				gadgets: [
					{
						name: "CRM",
						manifest: { entry: "crm.ts", capabilities: ["email:read"] },
					},
				],
				requirements: null,
			},
		});
		expect(result.revision.publishedAt).toEqual(expect.any(String));
		// …and workspace provenance pins the copy, not the source.
		expect(result.workspace).toMatchObject({
			organizationId: "org-1",
			name: "Sales US",
			sourceBlueprintId: result.blueprint.id,
			sourceBlueprintRevisionId: result.revision.id,
		});
		expect(result.gadgets).toHaveLength(1);
		expect(result.gadgets[0]?.gadget.organizationId).toBe("org-1");

		// The copy shows up in the caller's ordinary blueprint list.
		const listed = await c.org1.blueprints.list({ status: "published" });
		expect(listed.items.map((item) => item.id)).toContain(result.blueprint.id);
	});

	it("copies the PARSED definition, so planted keys cannot cross the tenant boundary", async () => {
		const sourceId = await publishGalleryBlueprint("Planted Pod");
		// Plant keys the schema does not declare, directly in the source org's
		// stored revision — exactly what a malicious or buggy publisher writes.
		// zod strips them from the RESPONSE, so a wire-level assertion is blind
		// to this; only the importing org's ROW can show it.
		const planted = JSON.stringify({
			gadgets: [
				{ name: "CRM", manifest: { entry: "crm.ts", capabilities: [] } },
			],
			requirements: null,
			secretBundle: { apiKey: "sk_live_PLANTED" },
		});
		await c.env.DB.prepare(
			"UPDATE os_blueprint_revisions SET definition = ? WHERE blueprint_id = ?",
		)
			.bind(planted, sourceId)
			.run();

		const result = await c.org1.blueprints.instantiateFromGallery({
			blueprintId: sourceId,
			workspaceName: "Planted US",
		});

		const copied = (await c.env.DB.prepare(
			"SELECT definition FROM os_blueprint_revisions WHERE blueprint_id = ?",
		)
			.bind(result.blueprint.id)
			.first()) as { definition: string };
		expect(copied.definition).not.toContain("secretBundle");
		expect(copied.definition).not.toContain("sk_live_PLANTED");
		// The declared content still crossed intact.
		expect(JSON.parse(copied.definition).gadgets[0].name).toBe("CRM");
	});

	it("dedupes the copied blueprint name when the source name is taken", async () => {
		const sourceId = await publishGalleryBlueprint();
		await c.org1.blueprints.create({ name: "Sales Pod" });

		const result = await c.org1.blueprints.instantiateFromGallery({
			blueprintId: sourceId,
			workspaceName: "Sales US",
		});
		expect(result.blueprint.name).toBe("Sales Pod (2)");
	});

	it("keeps non-catalog and retracted blueprints unreachable across orgs", async () => {
		// A published but org-private blueprint from another org must 404.
		const { blueprint } = await c.org2.blueprints.create({
			name: "Private Pod",
		});
		await c.org2.blueprints.revise({
			blueprintId: blueprint.id,
			definition: { gadgets: [] },
		});
		await c.org2.blueprints.publish({ blueprintId: blueprint.id });
		await expect(
			c.org1.blueprints.instantiateFromGallery({
				blueprintId: blueprint.id,
				workspaceName: "Exfil",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		// Retracting a catalog blueprint closes the door again.
		const sourceId = await publishGalleryBlueprint();
		await c.org2.blueprints.setVisibility({
			blueprintId: sourceId,
			visibility: "org",
		});
		await expect(
			c.org1.blueprints.instantiateFromGallery({
				blueprintId: sourceId,
				workspaceName: "Sales US",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect((await c.org1.blueprints.gallery({})).items).toHaveLength(0);
		expect((await c.org1.workspaces.list({})).items).toHaveLength(0);
	});

	it("fails CONFLICT on a taken workspace name", async () => {
		const sourceId = await publishGalleryBlueprint();
		await c.org1.workspaces.create({ name: "Sales US" });
		await expect(
			c.org1.blueprints.instantiateFromGallery({
				blueprintId: sourceId,
				workspaceName: "Sales US",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("fails CONFLICT on a taken workspace name without leaving the copied blueprint behind", async () => {
		const sourceId = await publishGalleryBlueprint();
		await c.org1.workspaces.create({ name: "Sales US" });
		await expect(
			c.org1.blueprints.instantiateFromGallery({
				blueprintId: sourceId,
				workspaceName: "Sales US",
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			// The violation is attributed to the table that actually lost the race,
			// not renumbered as a blueprint-name collision.
			message: "A workspace with this name already exists in the organization",
		});
		// The copy and the workspace ride one D1 batch, so the rollback takes the
		// blueprint with it: no orphan is committed in the importing organization.
		expect((await c.org1.blueprints.list({})).items).toHaveLength(0);
	});

	it("never binds a foreign pin to a same-slug local row: it reports missing/denied and writes nothing", async () => {
		// org-2 publishes a blueprint pinning ITS OWN skill row by id+revision.
		const foreignSkillId = "5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c";
		const { blueprint } = await c.org2.blueprints.create({ name: "Ops Pod" });
		await c.org2.blueprints.revise({
			blueprintId: blueprint.id,
			definition: {
				gadgets: [
					{ name: "CRM", manifest: { entry: "crm.ts", capabilities: [] } },
				],
				requirements: {
					version: 1,
					skills: [
						{
							role: "skill",
							skillId: foreignSkillId,
							slug: "lead-triage",
							revision: 7,
							workflowSha256: null,
						},
					],
					connections: [],
					policies: [
						{ scope: "organization", slug: "revenue-ops", version: 2 },
					],
					runtime: null,
					layout: null,
					outputs: [],
				},
			},
		});
		await c.org2.blueprints.publish({ blueprintId: blueprint.id });
		await c.org2.blueprints.setVisibility({
			blueprintId: blueprint.id,
			visibility: "catalog",
		});

		// org-1 happens to own a DIFFERENT skill on the same slug — the exact
		// silent-bind hazard a slug-only reference would walk into — and does not
		// have the publisher's org-scoped policy pack at all.
		mocks.getSkillEntryBySlug.mockResolvedValue({
			id: "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d",
			slug: "lead-triage",
			revision: 1,
			lifecycleState: "active",
			files: { "scripts/workflow.ts": "export default async () => ({})" },
		});
		mocks.getPolicyPackBySlugForOrganization.mockResolvedValue(null);

		const failure = await c.org1.blueprints
			.instantiateFromGallery({
				blueprintId: blueprint.id,
				workspaceName: "Ops US",
			})
			.catch((error: unknown) => error as { code: string; data?: unknown });
		expect(failure).toMatchObject({ code: "UNPROCESSABLE_CONTENT" });
		const preflight = (
			failure as { data: { preflight: { decisions: unknown[] } } }
		).data.preflight;
		expect(preflight).toMatchObject({
			status: "blocked",
			instantiateAllowed: false,
		});
		expect(preflight.decisions).toEqual([
			expect.objectContaining({
				kind: "skill",
				verdict: "denied",
				resolvedPin: expect.objectContaining({
					id: "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d",
				}),
			}),
			expect.objectContaining({
				kind: "policy_pack",
				verdict: "missing",
				resolvedPin: null,
			}),
		]);
		// Resolution happened in the IMPORTING organization.
		expect(mocks.getSkillEntryBySlug).toHaveBeenCalledWith(
			expect.anything(),
			"org-1",
			"lead-triage",
		);
		expect(mocks.getPolicyPackBySlugForOrganization).toHaveBeenCalledWith(
			expect.anything(),
			"org-1",
			{ scope: "organization", slug: "revenue-ops", version: 2 },
		);
		// Nothing was created: no blueprint copy, no workspace, no gadget.
		expect((await c.org1.blueprints.list({})).items).toHaveLength(0);
		expect((await c.org1.workspaces.list({})).items).toHaveLength(0);
	});

	it("cannot carry a credential across the tenant boundary", async () => {
		// The requirement schemas are `.strict()` over structured references, so a
		// token cannot be written into a blueprint in the first place.
		await expect(
			c.org2.blueprints.create({ name: "Leaky Pod" }).then(({ blueprint }) =>
				c.org2.blueprints.revise({
					blueprintId: blueprint.id,
					definition: {
						gadgets: [],
						requirements: {
							version: 1,
							skills: [],
							connections: [
								{
									providerId: "gmail",
									tokenScope: "tenant",
									scopes: [],
									accessToken: "ya29.super-secret",
								},
							],
							policies: [],
							runtime: null,
							layout: null,
							outputs: [],
						},
					},
				} as never),
			),
		).rejects.toBeDefined();

		// And the definition that DOES cross names a provider, never a secret.
		const sourceId = await publishGalleryBlueprint("Connected Pod");
		const imported = await c.org1.blueprints.instantiateFromGallery({
			blueprintId: sourceId,
			workspaceName: "Connected US",
		});
		const wire = JSON.stringify(imported);
		expect(wire).not.toMatch(/accessToken|refreshToken|Bearer |sk_/);
	});
});

describe("governed gadget dispatch", () => {
	const TEDI_ID = "3d1a6a2e-8a4f-4b6e-9c1d-0f2e3a4b5c6d";
	const WORK_ITEM_ID = "9b8c7d6e-5f4a-4b3c-8d2e-1f0a9b8c7d6e";

	const SKILL = {
		id: "b4a3c2d1-e0f9-4a8b-9c7d-6e5f4a3b2c1d",
		slug: "inbox-triage",
		revision: 3,
		files: { "scripts/workflow.ts": "export default async () => ({})" },
		content: "# Inbox Triage\n\nGoverned gadget executable.",
	};

	function readyPreflight(
		overrides: Record<string, unknown> = {},
	): Record<string, unknown> {
		return {
			workItemId: WORK_ITEM_ID,
			status: "ready",
			dispatchAllowed: true,
			manifest: null,
			targetTedi: { id: TEDI_ID, slug: "cto", name: "CTO" },
			runtimeProfile: {
				id: "7c6b5a49-3d2e-4f1a-8b9c-0d1e2f3a4b5c",
				slug: "default",
				name: "Default",
				status: "active",
			},
			policyPack: {
				id: "5e4d3c2b-1a09-4f8e-9d7c-6b5a4e3d2c1b",
				slug: "default",
				name: "Default",
				status: "active",
				requiresApproval: false,
			},
			executionRequirement: null,
			decisions: [
				{
					kind: "assignment",
					subject: "cto",
					verdict: "allowed",
					reason: "the capability bundle explicitly selects this tedi",
				},
			],
			blockingReasons: [],
			resolvedAt: "2026-08-15T00:00:00.000Z",
			...overrides,
		};
	}

	/** createEnv + a SKILL_RUNTIME binding that records every /run dispatch body. */
	function governedEnv() {
		const env = createEnv();
		const dispatches: Array<Record<string, unknown>> = [];
		(env as Record<string, unknown>).SKILL_RUNTIME = {
			fetch: async (_url: unknown, init?: { body?: BodyInit }) => {
				const body = JSON.parse(String(init?.body ?? "{}")) as Record<
					string,
					unknown
				>;
				dispatches.push(body);
				return Response.json({
					runId: body.runId,
					workflowInstanceId: `wf-${dispatches.length}`,
					status: "queued",
					executionEpoch: 0,
					deduplicated: dispatches.length > 1,
				});
			},
		};
		return { env, dispatches };
	}

	function governedClient(env: CloudflareEnv) {
		const context = userContext(env, "org-1");
		(context as Record<string, unknown>).externalAgentSessionId =
			"claude:sess-1";
		return createRouterClient(osWorkspacesContractRouter, { context });
	}

	async function seedRunnableGadget(
		client: ReturnType<typeof governedClient>,
		manifest: Record<string, unknown> = {
			entry: "surface.tsx",
			skillSlug: "inbox-triage",
			capabilities: ["email:read"],
		},
		workspaceName = "Ops",
	) {
		const { workspace } = await client.workspaces.create({
			name: workspaceName,
		});
		const { gadget } = await client.gadgets.create({
			workspaceId: workspace.id,
			name: "Inbox Triage",
		});
		await client.gadgets.revise({
			workspaceId: workspace.id,
			gadgetId: gadget.id,
			manifest: manifest as never,
		});
		return { workspaceId: workspace.id, gadgetId: gadget.id };
	}

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getTediOrganizationId.mockResolvedValue("org-1");
		mocks.getTediById.mockResolvedValue({
			id: TEDI_ID,
			organizationId: "org-1",
			runtimeProfileId: "7c6b5a49-3d2e-4f1a-8b9c-0d1e2f3a4b5c",
		});
		mocks.getSkillEntryBySlug.mockResolvedValue(SKILL);
		mocks.getRuntimeProfileById.mockResolvedValue({
			config: { modelPolicy: { chatModelRef: "azure-openai/gpt-5.6-terra" } },
		});
		mocks.resolveWorkItemExecutionPreflight.mockResolvedValue(readyPreflight());
		mocks.authorizeRuntimeBudget.mockResolvedValue({
			allowed: true,
			settlementMode: "external",
			attributionVersion: 1,
			reservationId: "resv-1",
			expiresAt: null,
			estimatedChargeMicros: null,
		});
		mocks.getWorkItemById.mockResolvedValue({
			id: WORK_ITEM_ID,
			orgId: "org-1",
		});
		mocks.createApprovalRequest.mockImplementation(
			async (_db: unknown, data: Record<string, unknown>) => ({
				...data,
				status: "pending",
			}),
		);
		mocks.getApprovalRequestById.mockResolvedValue(undefined);
	});

	it("dispatches the manifest's skill through skill-runtime with the template call shape", async () => {
		const { env, dispatches } = governedEnv();
		const client = governedClient(env);
		const seeded = await seedRunnableGadget(client);

		const { execution } = await client.gadgets.run({
			...seeded,
			tediId: TEDI_ID,
			workItemId: WORK_ITEM_ID,
			input: {
				query: "newest",
				_tedixContext: { token: "caller-controlled" },
			},
			idempotencyKey: "gadget-run-1",
		});

		// The /run body follows skillsRunWorkflow: pinned source, provenance
		// ladder, run identity = the receipt id.
		expect(dispatches).toHaveLength(1);
		expect(dispatches[0]).toMatchObject({
			runId: execution.id,
			createdBy: "user:user-1",
			workItemId: WORK_ITEM_ID,
			idempotencyKey: "gadget-run-1",
			skillId: SKILL.id,
			skillSlug: SKILL.slug,
			skillRevision: SKILL.revision,
			orgId: "org-1",
			tediId: TEDI_ID,
			params: {
				query: "newest",
				_tedixContext: {
					version: 1,
					organizationId: "org-1",
					workspace: { id: seeded.workspaceId, name: "Ops" },
					gadget: {
						id: seeded.gadgetId,
						name: "Inbox Triage",
						revisionId: expect.any(String),
						revision: 1,
					},
					resources: [],
				},
			},
			workflowSource: SKILL.files["scripts/workflow.ts"],
			skillDoc: SKILL.content,
		});
		expect(dispatches[0]).toHaveProperty("capabilityManifest");

		expect(execution).toMatchObject({
			status: "queued",
			grantedCapabilities: ["email:read"],
			policyDecision: {
				allowed: true,
				reasons: [],
				decisions: [expect.objectContaining({ kind: "assignment" })],
			},
			lineage: {
				runId: execution.id,
				workflowInstanceId: "wf-1",
				tediId: TEDI_ID,
				workItemId: WORK_ITEM_ID,
				billingReservationId: "resv-1",
				approvalRequestId: null,
				runtimeEnvironment: "test",
				agentSessionId: "claude:sess-1",
				executionEpoch: 0,
				traceBundleId: null,
			},
		});

		// Budget admission carried the gadget source and the profile's model ref.
		expect(mocks.authorizeRuntimeBudget).toHaveBeenCalledWith(
			expect.objectContaining({
				request: expect.objectContaining({
					source: "gadget",
					provider: "azure-openai",
					model: "gpt-5.6-terra",
					tediId: TEDI_ID,
					estimatedInputTokens: 1,
					estimatedOutputTokens: 4096,
				}),
			}),
		);
	});

	it("mints a short-lived attachment only for an export declared by the pinned revision", async () => {
		const { env } = governedEnv();
		const client = governedClient(env);
		const seeded = await seedRunnableGadget(client, {
			entry: "calendar-builder",
			skillSlug: "inbox-triage",
			capabilities: [],
			exports: [
				{
					version: 1,
					id: "calendar",
					label: "Calendar (.ics)",
					artifactPath: "outputs/calendar.json",
					mimeType: "text/calendar",
					extension: "ics",
				},
			],
		});
		const { execution } = await client.gadgets.run({
			...seeded,
			tediId: TEDI_ID,
			idempotencyKey: "calendar-export",
		});
		await env.DB.prepare(
			"UPDATE os_gadget_executions SET status = 'completed', completed_at = datetime('now') WHERE id = ?",
		)
			.bind(execution.id)
			.run();
		await recordRunArtifact(createDbClient(env.DB), {
			runId: execution.id,
			path: "outputs/calendar.json",
			value: {
				bytesBase64Encoded: btoa("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"),
				mimeType: "text/calendar",
			},
			outcome: "success",
		});

		const exported = await client.executions.export({
			...seeded,
			executionId: execution.id,
			exportId: "calendar",
		});
		expect(exported).toMatchObject({
			descriptor: { id: "calendar", version: 1 },
			fileName: expect.stringMatching(/\.ics$/),
			sizeBytes: 32,
		});
		const url = new URL(exported.url);
		expect(url.pathname).toBe(
			`/skill-media/${execution.id}/outputs/calendar.json`,
		);
		expect(url.searchParams.get("download")).toBe(exported.fileName);
		expect(url.searchParams.get("sig")).toBeTruthy();

		await expect(
			client.executions.export({
				...seeded,
				executionId: execution.id,
				exportId: "undeclared",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("refuses to turn source-derived Gadget bytes into a bearer export", async () => {
		const { env } = governedEnv();
		const client = governedClient(env);
		const seeded = await seedRunnableGadget(client, {
			entry: "calendar-builder",
			skillSlug: "inbox-triage",
			capabilities: [],
			exports: [
				{
					version: 1,
					id: "calendar",
					label: "Calendar (.ics)",
					artifactPath: "outputs/calendar.json",
					mimeType: "text/calendar",
					extension: "ics",
				},
			],
		});
		const { execution } = await client.gadgets.run({
			...seeded,
			tediId: TEDI_ID,
			idempotencyKey: "source-derived-export",
		});
		await env.DB.prepare(
			"UPDATE os_gadget_executions SET status = 'completed', resource_access_envelope = ?, completed_at = datetime('now') WHERE id = ?",
		)
			.bind(
				JSON.stringify({
					version: 1,
					sources: [
						{
							workspaceResourceId: "11111111-1111-4111-8111-111111111111",
							workspaceId: seeded.workspaceId,
							providerId: "google",
							resourceType: "calendar",
							providerResourceId: "primary",
							connectionScope: "tenant",
							requiredScopes: ["calendar.read"],
							operations: ["read"],
						},
					],
				}),
				execution.id,
			)
			.run();

		await expect(
			client.executions.export({
				...seeded,
				executionId: execution.id,
				exportId: "calendar",
			}),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: expect.stringContaining("bearer"),
		});
	});

	it("denies a background tedi when a Gadget slot is missing or bound to a personal grant", async () => {
		const { env, dispatches } = governedEnv();
		const client = governedClient(env);
		const seeded = await seedRunnableGadget(
			client,
			{
				entry: "lead-triage",
				capabilities: [],
				resourceGrants: [{ slot: "customer_repo", operations: ["read"] }],
			},
			"Personal resource run",
		);

		const missing = await client.gadgets.run({ ...seeded, tediId: TEDI_ID });
		expect(missing.execution).toMatchObject({
			status: "denied",
			policyDecision: {
				reasons: ["resource slot customer_repo has no active selection"],
			},
		});

		await client.resources.create({
			workspaceId: seeded.workspaceId,
			selection: {
				providerId: "github",
				connectionScope: "user",
				resourceType: "repository",
				providerResourceId: "tedix-hq/tedix",
				name: "tedix-hq/tedix",
				metadata: {},
			},
		});
		// Manual attachments are intentionally un-slotted. Blueprint binding owns
		// named slots, so a personal object cannot acquire authority by attachment.
		const stillMissing = await client.gadgets.run({
			...seeded,
			tediId: TEDI_ID,
			idempotencyKey: "personal-resource-second-attempt",
		});
		expect(stillMissing.execution.status).toBe("denied");
		expect(dispatches).toHaveLength(0);
	});

	it("settles a dispatched receipt from run evidence at read time", async () => {
		const { env } = governedEnv();
		const client = governedClient(env);
		const seeded = await seedRunnableGadget(client);

		const { execution } = await client.gadgets.run({
			...seeded,
			tediId: TEDI_ID,
			idempotencyKey: "settle-1",
		});
		expect(execution.status).toBe("queued");

		// The runtime terminated the run; only its skill_runs evidence knows.
		await env.DB.prepare(
			"UPDATE os_gadget_executions SET runtime_environment = 'production' WHERE id = ?",
		)
			.bind(execution.id)
			.run();
		await env.DB.prepare(
			`INSERT INTO skill_runs (
				id, organization_id, skill_id, tedi_id, workflow_instance_id,
				execution_epoch, runtime_environment, status, result, cost_summary
			) VALUES (?, 'org-1', ?, ?, 'wf-1', 2, 'production', 'completed', ?, ?)`,
		)
			.bind(
				execution.id,
				SKILL.id,
				TEDI_ID,
				JSON.stringify({ ok: 1 }),
				JSON.stringify({ schemaVersion: 1, wallMs: 12 }),
			)
			.run();

		const { execution: settled } = await client.executions.get({
			...seeded,
			executionId: execution.id,
		});
		expect(settled.status).toBe("completed");
		expect(settled.output).toEqual({ ok: 1 });
		expect(settled.costs).toEqual({ schemaVersion: 1, wallMs: 12 });
		expect(settled.completedAt).not.toBeNull();
		expect(settled.lineage.executionEpoch).toBe(2);

		// Terminal receipts are immutable audit evidence: mutate the run and
		// prove a re-read keeps the settled receipt byte-stable.
		await env.DB.prepare(
			"UPDATE skill_runs SET status = 'failed', error = 'late mutation' WHERE id = ?",
		)
			.bind(execution.id)
			.run();
		const { execution: reread } = await client.executions.get({
			...seeded,
			executionId: execution.id,
		});
		expect(reread).toEqual(settled);

		// The list surface settles through the same read path.
		const { items } = await client.executions.list({ ...seeded, limit: 10 });
		expect(items.find((item) => item.id === execution.id)?.status).toBe(
			"completed",
		);
	});

	it("syncs a dispatched receipt to the run's lifecycle status without settling it", async () => {
		const { env } = governedEnv();
		const client = governedClient(env);
		const seeded = await seedRunnableGadget(client);

		const { execution } = await client.gadgets.run({
			...seeded,
			tediId: TEDI_ID,
			idempotencyKey: "sync-1",
		});
		await env.DB.prepare(
			"UPDATE os_gadget_executions SET runtime_environment = 'production' WHERE id = ?",
		)
			.bind(execution.id)
			.run();
		await env.DB.prepare(
			`INSERT INTO skill_runs (
				id, organization_id, skill_id, tedi_id, workflow_instance_id,
				execution_epoch, runtime_environment, status
			) VALUES (?, 'org-1', ?, ?, 'wf-1', 0, 'production', 'running')`,
		)
			.bind(execution.id, SKILL.id, TEDI_ID)
			.run();

		const { execution: synced } = await client.executions.get({
			...seeded,
			executionId: execution.id,
		});
		expect(synced.status).toBe("running");
		expect(synced.completedAt).toBeNull();
		expect(synced.output).toBeNull();
	});

	it("returns the recorded receipt for a duplicate idempotencyKey without re-admitting", async () => {
		const { env, dispatches } = governedEnv();
		const client = governedClient(env);
		const seeded = await seedRunnableGadget(client);

		const first = await client.gadgets.run({
			...seeded,
			tediId: TEDI_ID,
			idempotencyKey: "stable-key",
		});
		const second = await client.gadgets.run({
			...seeded,
			tediId: TEDI_ID,
			idempotencyKey: "stable-key",
		});
		expect(second.execution.id).toBe(first.execution.id);
		expect(second.execution.lineage.runId).toBe(first.execution.lineage.runId);
		// One dispatch, one budget admission: the duplicate short-circuited.
		expect(dispatches).toHaveLength(1);
		expect(mocks.authorizeRuntimeBudget).toHaveBeenCalledTimes(1);
		// A stricter caller posture is a distinct logical request. Reusing a key
		// from a policy-mode dispatch must never bypass the required approval.
		const required = await client.gadgets.run({
			...seeded,
			tediId: TEDI_ID,
			approvalMode: "required",
			idempotencyKey: "stable-key",
		});
		expect(required.execution.id).not.toBe(first.execution.id);
		expect(required.execution.status).toBe("awaiting_approval");
		expect(dispatches).toHaveLength(1);
		// A different key admits a fresh execution.
		const third = await client.gadgets.run({
			...seeded,
			tediId: TEDI_ID,
			idempotencyKey: "another-key",
		});
		expect(third.execution.id).not.toBe(first.execution.id);
	});

	it("denies with gadget_not_executable when the manifest resolves no runnable skill", async () => {
		const { env, dispatches } = governedEnv();
		const client = governedClient(env);

		// No skillSlug and a non-slug entry: nothing to dispatch.
		const pathSeeded = await seedRunnableGadget(client, {
			entry: "widgets/surface.tsx",
			capabilities: [],
		});
		const noSlug = await client.gadgets.run({
			...pathSeeded,
			tediId: TEDI_ID,
		});
		expect(noSlug.execution.status).toBe("denied");
		expect(noSlug.execution.policyDecision.reasons[0]).toMatch(
			/^gadget_not_executable:/,
		);

		// A slug that resolves no skill.
		mocks.getSkillEntryBySlug.mockResolvedValue(undefined);
		const seeded = await seedRunnableGadget(client, undefined, "Ops 2");
		const missing = await client.gadgets.run({ ...seeded, tediId: TEDI_ID });
		expect(missing.execution.status).toBe("denied");
		expect(missing.execution.policyDecision.reasons).toEqual([
			"gadget_not_executable: no skill exists for slug inbox-triage",
		]);

		// A skill without the executable workflow source.
		mocks.getSkillEntryBySlug.mockResolvedValue({ ...SKILL, files: {} });
		const inert = await client.gadgets.run({ ...seeded, tediId: TEDI_ID });
		expect(inert.execution.status).toBe("denied");
		expect(inert.execution.policyDecision.reasons[0]).toContain(
			"has no files['scripts/workflow.ts']",
		);

		expect(dispatches).toHaveLength(0);
		expect(mocks.authorizeRuntimeBudget).not.toHaveBeenCalled();
	});

	it("denies before governed resolution on an undeclared capability", async () => {
		const { env, dispatches } = governedEnv();
		const client = governedClient(env);
		const seeded = await seedRunnableGadget(client);

		const { execution } = await client.gadgets.run({
			...seeded,
			tediId: TEDI_ID,
			capabilities: ["email:read", "files:write"],
		});
		expect(execution.status).toBe("denied");
		expect(execution.policyDecision.reasons).toEqual([
			"undeclared capability: files:write",
		]);
		expect(mocks.resolveWorkItemExecutionPreflight).not.toHaveBeenCalled();
		expect(dispatches).toHaveLength(0);
	});

	it("records a denied receipt with the preflight decisions when preflight blocks", async () => {
		const { env, dispatches } = governedEnv();
		const client = governedClient(env);
		const seeded = await seedRunnableGadget(client);

		mocks.resolveWorkItemExecutionPreflight.mockResolvedValue(
			readyPreflight({
				status: "blocked",
				dispatchAllowed: false,
				blockingReasons: ["runtime profile default is archived"],
				decisions: [
					{
						kind: "runtime_profile",
						subject: "default",
						verdict: "denied",
						reason: "runtime profile default is archived",
					},
				],
			}),
		);

		const { execution } = await client.gadgets.run({
			...seeded,
			tediId: TEDI_ID,
		});
		expect(execution.status).toBe("denied");
		expect(execution.policyDecision).toMatchObject({
			allowed: false,
			reasons: ["runtime profile default is archived"],
			decisions: [expect.objectContaining({ kind: "runtime_profile" })],
		});
		expect(dispatches).toHaveLength(0);
		expect(mocks.authorizeRuntimeBudget).not.toHaveBeenCalled();
	});

	it("records a denied receipt carrying the billing denial code", async () => {
		const { env, dispatches } = governedEnv();
		const client = governedClient(env);
		const seeded = await seedRunnableGadget(client);

		mocks.authorizeRuntimeBudget.mockResolvedValue({
			allowed: false,
			code: "monthly_allowance_exhausted",
			entitlement: null,
		});

		const { execution } = await client.gadgets.run({
			...seeded,
			tediId: TEDI_ID,
		});
		expect(execution.status).toBe("denied");
		expect(execution.policyDecision.reasons).toEqual([
			"billing_denied: monthly_allowance_exhausted",
		]);
		expect(execution.lineage.billingReservationId).toBeNull();
		expect(dispatches).toHaveLength(0);
	});

	it("parks a needs_approval run and the approval settlement resumes it automatically once", async () => {
		const { env, dispatches } = governedEnv();
		const client = governedClient(env);
		const seeded = await seedRunnableGadget(client);

		mocks.resolveWorkItemExecutionPreflight.mockResolvedValue(
			readyPreflight({
				status: "needs_approval",
				dispatchAllowed: false,
				decisions: [
					{
						kind: "policy",
						subject: "default",
						verdict: "approval_required",
						reason:
							"the active policy requires human approval before autonomous dispatch",
					},
				],
			}),
		);

		const parked = await client.gadgets.run({
			...seeded,
			tediId: TEDI_ID,
			input: { query: "newest" },
		});
		expect(parked.execution.status).toBe("awaiting_approval");
		expect(parked.execution.lineage.runId).toBeNull();
		const approvalRequestId = parked.execution.lineage.approvalRequestId;
		expect(approvalRequestId).toEqual(expect.any(String));
		expect(dispatches).toHaveLength(0);
		expect(mocks.createApprovalRequest).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				id: approvalRequestId,
				tediId: TEDI_ID,
				orgId: "org-1",
				actionType: "os_gadget_execution",
				payload: expect.objectContaining({
					executionId: parked.execution.id,
					skillSlug: "inbox-triage",
				}),
			}),
		);

		const approval = {
			id: approvalRequestId,
			tediId: TEDI_ID,
			orgId: "org-1",
			actionType: "os_gadget_execution",
			description: "Dispatch Inbox Triage",
			payload: {
				executionId: parked.execution.id,
				gadgetId: seeded.gadgetId,
				skillSlug: "inbox-triage",
			},
			status: "approved",
			createdAt: "2026-08-17T00:00:00.000Z",
			expiresAt: "2026-08-20T00:00:00.000Z",
			resolvedAt: "2026-08-17T00:01:00.000Z",
			resolvedBy: "approver-1",
			resolution: "Approved in Activity",
			workflowId: `approval-${approvalRequestId}`,
		} as const;
		const resumed = await settleOsGadgetApproval(
			userContext(env, "org-1"),
			approval,
		);
		expect(resumed.execution).toMatchObject({
			status: "queued",
			runId: parked.execution.id,
			workflowInstanceId: "wf-1",
			billingReservationId: "resv-1",
			approvalRequestId,
		});
		expect(resumed.dispatched).toBe(true);
		expect(dispatches).toHaveLength(1);
		expect(dispatches[0]).toMatchObject({
			runId: parked.execution.id,
			createdBy: "user:approver-1",
			tediId: TEDI_ID,
			params: { query: "newest" },
			idempotencyKey: `gadget-approval:${approvalRequestId}:${parked.execution.id}`,
		});

		// Duplicate resolution/event replay observes the durable lineage and
		// performs no second runtime call or billing reservation.
		const replay = await settleOsGadgetApproval(
			userContext(env, "org-1"),
			approval,
		);
		expect(replay.dispatched).toBe(false);
		expect(dispatches).toHaveLength(1);
		expect(mocks.authorizeRuntimeBudget).toHaveBeenCalledTimes(1);
	});

	it("settles rejection and approval-time budget expiry without dispatch", async () => {
		for (const scenario of ["rejected", "budget_expired"] as const) {
			vi.clearAllMocks();
			mocks.getTediOrganizationId.mockResolvedValue("org-1");
			mocks.getTediById.mockResolvedValue({
				id: TEDI_ID,
				organizationId: "org-1",
				runtimeProfileId: "7c6b5a49-3d2e-4f1a-8b9c-0d1e2f3a4b5c",
			});
			mocks.getSkillEntryBySlug.mockResolvedValue(SKILL);
			mocks.getRuntimeProfileById.mockResolvedValue({ config: {} });
			mocks.resolveWorkItemExecutionPreflight.mockResolvedValue(
				readyPreflight({ status: "needs_approval", dispatchAllowed: false }),
			);
			mocks.authorizeRuntimeBudget.mockResolvedValue(
				scenario === "budget_expired"
					? {
							allowed: false,
							code: "monthly_allowance_exhausted",
							entitlement: null,
						}
					: {
							allowed: true,
							settlementMode: "external",
							attributionVersion: 1,
							reservationId: null,
							expiresAt: null,
							estimatedChargeMicros: null,
						},
			);
			mocks.createApprovalRequest.mockImplementation(
				async (_db: unknown, data: Record<string, unknown>) => ({
					...data,
					status: "pending",
				}),
			);

			const { env, dispatches } = governedEnv();
			const client = governedClient(env);
			const seeded = await seedRunnableGadget(
				client,
				undefined,
				`Ops ${scenario}`,
			);
			const parked = await client.gadgets.run({
				...seeded,
				tediId: TEDI_ID,
			});
			const approvalRequestId = parked.execution.lineage.approvalRequestId;
			expect(approvalRequestId).toEqual(expect.any(String));
			const approval = {
				id: approvalRequestId as string,
				tediId: TEDI_ID,
				orgId: "org-1",
				actionType: "os_gadget_execution",
				description: "Dispatch Gadget",
				payload: { executionId: parked.execution.id },
				status: scenario === "rejected" ? "rejected" : "approved",
				createdAt: "2026-08-17T00:00:00.000Z",
				expiresAt: "2026-08-20T00:00:00.000Z",
				resolvedAt: "2026-08-17T00:01:00.000Z",
				resolvedBy: "approver-1",
				resolution: scenario,
				workflowId: `approval-${approvalRequestId}`,
			} as const;
			const settled = await settleOsGadgetApproval(
				userContext(env, "org-1"),
				approval,
			);
			expect(settled.execution).toMatchObject({
				status: "denied",
				completedAt: expect.any(String),
			});
			expect(settled.execution?.error).toContain(
				scenario === "rejected"
					? "approval_rejected"
					: "billing_denied: monthly_allowance_exhausted",
			);
			expect(dispatches).toHaveLength(0);
		}
	});

	it("retries a failed dispatch with one deterministic run and can terminalize it", async () => {
		const { env } = governedEnv();
		const attempts: Array<Record<string, unknown>> = [];
		(env as Record<string, unknown>).SKILL_RUNTIME = {
			fetch: async (_url: unknown, init?: { body?: BodyInit }) => {
				attempts.push(JSON.parse(String(init?.body ?? "{}")));
				throw new Error("skill runtime unavailable");
			},
		};
		const client = governedClient(env);
		const seeded = await seedRunnableGadget(
			client,
			undefined,
			"Ops failed dispatch",
		);
		mocks.resolveWorkItemExecutionPreflight.mockResolvedValue(
			readyPreflight({ status: "needs_approval", dispatchAllowed: false }),
		);
		const parked = await client.gadgets.run({
			...seeded,
			tediId: TEDI_ID,
		});
		const approvalRequestId = parked.execution.lineage
			.approvalRequestId as string;
		const approval = {
			id: approvalRequestId,
			tediId: TEDI_ID,
			orgId: "org-1",
			actionType: "os_gadget_execution",
			description: "Dispatch Gadget",
			payload: { executionId: parked.execution.id },
			status: "approved",
			createdAt: "2026-08-17T00:00:00.000Z",
			expiresAt: "2026-08-20T00:00:00.000Z",
			resolvedAt: "2026-08-17T00:01:00.000Z",
			resolvedBy: "approver-1",
			resolution: "approved",
			workflowId: `approval-${approvalRequestId}`,
		} as const;
		const context = userContext(env, "org-1");
		await expect(settleOsGadgetApproval(context, approval)).rejects.toThrow(
			"skill runtime unavailable",
		);
		await expect(settleOsGadgetApproval(context, approval)).rejects.toThrow(
			"skill runtime unavailable",
		);
		expect(attempts).toHaveLength(2);
		expect(attempts[0]).toMatchObject({
			runId: parked.execution.id,
			idempotencyKey: `gadget-approval:${approvalRequestId}:${parked.execution.id}`,
		});
		expect(attempts[1]).toEqual(attempts[0]);

		const failed = await failOsGadgetApprovalDispatch(
			context,
			approval,
			new Error("dispatch retries exhausted"),
		);
		expect(failed).toMatchObject({
			status: "failed",
			error: "dispatch retries exhausted",
			completedAt: expect.any(String),
		});
		expect(
			await failOsGadgetApprovalDispatch(context, approval, "replay"),
		).toBe(null);
	});

	it("parks a policy-ready run when the caller explicitly requires approval", async () => {
		const { env, dispatches } = governedEnv();
		const client = governedClient(env);
		const seeded = await seedRunnableGadget(client);

		const { execution } = await client.gadgets.run({
			...seeded,
			tediId: TEDI_ID,
			approvalMode: "required",
			input: { query: "newest" },
		});
		expect(execution).toMatchObject({
			status: "awaiting_approval",
			grantedCapabilities: ["email:read"],
			policyDecision: {
				allowed: false,
				reasons: [
					"the caller requires explicit human approval before dispatch",
				],
			},
		});
		expect(execution.lineage.runId).toBeNull();
		expect(execution.lineage.tediId).toBe(TEDI_ID);
		expect(execution.lineage.approvalRequestId).toEqual(expect.any(String));
		expect(dispatches).toHaveLength(0);
		expect(mocks.resolveWorkItemExecutionPreflight).toHaveBeenCalledOnce();
		expect(mocks.authorizeRuntimeBudget).not.toHaveBeenCalled();
	});
});

describe("blueprint export and import", () => {
	let c: ReturnType<typeof clients>;

	beforeEach(() => {
		c = clients();
		mocks.getSkillEntryBySlug.mockReset();
		mocks.getPolicyPackBySlugForOrganization.mockReset();
		// Match the connected result from services/connection-availability.
		mocks.resolveConnectionAvailability.mockResolvedValue({
			connected: true,
			cause: "connected",
			reason: "tenant connection is active",
		});
	});

	const DEFINITION = {
		gadgets: [
			{
				name: "CRM",
				manifest: { entry: "crm.ts", capabilities: ["email:read"] },
			},
		],
		requirements: {
			version: 1 as const,
			skills: [],
			connections: [
				{ providerId: "gmail", tokenScope: "tenant", scopes: ["gmail.send"] },
			],
			policies: [],
			runtime: null,
			layout: null,
			outputs: [{ gadget: "CRM", kind: "sheet", title: "Pipeline" }],
		},
	};

	/** A published blueprint carrying DEFINITION, owned by the given client. */
	async function publish(
		client: ReturnType<typeof clients>["org1"],
		name = "Sales Pod",
		definition: Record<string, unknown> = DEFINITION,
	): Promise<string> {
		const { blueprint } = await client.blueprints.create({
			name,
			description: "Shared sales pod",
		});
		await client.blueprints.revise({
			blueprintId: blueprint.id,
			definition: definition as never,
		});
		await client.blueprints.publish({ blueprintId: blueprint.id });
		return blueprint.id;
	}

	function storedDefinition(blueprintId: string): Promise<{
		definition: string;
	} | null> {
		return c.env.DB.prepare(
			"SELECT definition FROM os_blueprint_revisions WHERE blueprint_id = ?",
		)
			.bind(blueprintId)
			.first() as Promise<{ definition: string } | null>;
	}

	it("projects an explicit allowlist: no principal, no tenant row identity beyond the origin, no adjacent state", async () => {
		const blueprintId = await publish(c.org1);
		// Adjacent state that MUST NOT travel, created for real beside the
		// blueprint: an instantiated workspace (which carries the org-specific
		// preflight envelope), a gadget, an execution receipt, and an output body.
		const instantiated = await c.org1.blueprints.instantiate({
			blueprintId,
			workspaceName: "Sales US",
		});
		const { execution } = await c.org1.gadgets.run({
			workspaceId: instantiated.workspace.id,
			gadgetId: instantiated.gadgets[0]!.gadget.id,
			tediId: "3d1a6a2e-8a4f-4b6e-9c1d-0f2e3a4b5c6d",
			capabilities: ["os-parity:undeclared"],
		});
		expect(execution.status).toBe("denied");
		const { output } = await c.org1.outputs.create({
			workspaceId: instantiated.workspace.id,
			kind: "document",
			title: "Private Brief",
			content: {
				kind: "document",
				blocks: [{ type: "paragraph", text: "internal-only-body" }],
			},
		});

		const { export: envelope } = await c.org1.blueprints.export({
			blueprintId,
		});

		expect(Object.keys(envelope).sort()).toEqual([
			"blueprint",
			"definition",
			"envelopeVersion",
			"exportedAt",
			"exportedByKind",
			"lineage",
			"revision",
			"source",
		]);
		expect(envelope.blueprint).toEqual({
			name: "Sales Pod",
			description: "Shared sales pod",
			status: "published",
		});
		expect(envelope.definition).toEqual(DEFINITION);
		expect(envelope.exportedByKind).toBe("user");
		expect(envelope.lineage).toBeNull();

		const serialized = JSON.stringify(envelope);
		// The caller's principal id (`user-1`, the Descope sub on the context) is
		// on both source rows and travels nowhere.
		expect(serialized).not.toContain("user-1");
		// No workspace, gadget, execution receipt, or output body.
		expect(serialized).not.toContain(instantiated.workspace.id);
		expect(serialized).not.toContain(execution.id);
		expect(serialized).not.toContain(output.id);
		expect(serialized).not.toContain("internal-only-body");
		// No instantiation evidence: it is org-specific and lives on the workspace.
		expect(serialized).not.toContain("instantiationPreflight");
		// The connection requirement names a provider and its scopes, never a token.
		expect(serialized).not.toMatch(/accessToken|refreshToken|Bearer |sk_/);
	});

	it("strips planted keys from the exported artifact AND from the imported row", async () => {
		const sourceId = await publish(c.org2, "Planted Pod");
		// Keys the schema does not declare, planted directly in the stored
		// revision — what a malicious or buggy writer leaves behind. zod strips
		// them from the RESPONSE, so only the row can show whether they crossed.
		await c.env.DB.prepare(
			"UPDATE os_blueprint_revisions SET definition = ? WHERE blueprint_id = ?",
		)
			.bind(
				JSON.stringify({
					gadgets: [
						{
							name: "CRM",
							manifest: {
								entry: "crm.ts",
								capabilities: [],
								apiKey: "sk_live_PLANTED_IN_MANIFEST",
							},
						},
					],
					requirements: null,
					secretBundle: { accessToken: "ya29.PLANTED_AT_ROOT" },
				}),
				sourceId,
			)
			.run();

		const { export: envelope } = await c.org2.blueprints.export({
			blueprintId: sourceId,
		});
		const serialized = JSON.stringify(envelope);
		expect(serialized).not.toContain("secretBundle");
		expect(serialized).not.toContain("sk_live_PLANTED_IN_MANIFEST");
		expect(serialized).not.toContain("ya29.PLANTED_AT_ROOT");
		// The declared content survived intact.
		expect(envelope.definition.gadgets[0]).toEqual({
			name: "CRM",
			manifest: { entry: "crm.ts", capabilities: [] },
		});

		const imported = await c.org1.blueprints.import({ export: envelope });
		const row = await storedDefinition(imported.blueprint.id);
		expect(row?.definition).not.toContain("secretBundle");
		expect(row?.definition).not.toContain("PLANTED");
		expect(row?.definition).not.toContain("ya29.");
		expect(JSON.parse(row!.definition).gadgets[0].name).toBe("CRM");
	});

	it("persists the PARSED definition when the ENVELOPE itself carries planted keys", async () => {
		// The previous test plants in a source this platform wrote. This one is
		// the hostile case the import path actually faces: an envelope handed in
		// by a caller, whose declared digest is computed over the CLEAN definition
		// so verification passes and the planted keys ride along beside it.
		const clean = {
			gadgets: [
				{ name: "CRM", manifest: { entry: "crm.ts", capabilities: [] } },
			],
			requirements: null,
		};
		const envelope = {
			envelopeVersion: 1,
			exportedAt: "2026-08-17T12:00:00.000Z",
			exportedByKind: "user",
			source: {
				organizationId: "org-hostile",
				organizationName: "Hostile Org",
				blueprintId: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b",
				blueprintName: "Hostile Pod",
				revisionId: "6f7a8b9c-0d1e-4f2a-8b3c-4d5e6f7a8b9c",
				revision: 2,
				definitionSha256: await canonicalDigest(clean),
				forkedAt: "2026-08-17T12:00:00.000Z",
				via: "export",
				// A hostile importer can claim anything here, including this.
				attested: true,
			},
			blueprint: {
				name: "Hostile Pod",
				description: null,
				status: "published",
			},
			revision: {
				revision: 2,
				createdAt: "2026-08-17T11:00:00.000Z",
				publishedAt: "2026-08-17T11:30:00.000Z",
				createdByKind: "user",
			},
			definition: {
				...clean,
				secretBundle: { accessToken: "ya29.PLANTED_IN_ENVELOPE" },
			},
			lineage: null,
		};

		const imported = await c.org1.blueprints.import({
			export: envelope as never,
		});
		const row = await storedDefinition(imported.blueprint.id);
		expect(row?.definition).not.toContain("secretBundle");
		expect(row?.definition).not.toContain("PLANTED_IN_ENVELOPE");
		expect(JSON.parse(row!.definition)).toEqual({
			gadgets: clean.gadgets,
			requirements: null,
		});
	});

	it("refuses an envelope whose digest does not describe the definition it carries", async () => {
		const sourceId = await publish(c.org2, "Digest Pod");
		const { export: envelope } = await c.org2.blueprints.export({
			blueprintId: sourceId,
		});
		const swapped = {
			...envelope,
			definition: {
				gadgets: [
					{
						name: "Backdoor",
						manifest: { entry: "backdoor.ts", capabilities: [] },
					},
				],
				requirements: null,
			},
		};

		await expect(
			c.org1.blueprints.import({ export: swapped as never }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		// Validation happens BEFORE anything is persisted.
		expect((await c.org1.blueprints.list({})).items).toHaveLength(0);
	});

	it("lands as a private draft regardless of the source's lifecycle and catalog decision", async () => {
		const sourceId = await publish(c.org2, "Catalog Pod");
		await c.org2.blueprints.setVisibility({
			blueprintId: sourceId,
			visibility: "catalog",
		});
		const { export: envelope } = await c.org2.blueprints.export({
			blueprintId: sourceId,
		});
		expect(envelope.blueprint.status).toBe("published");

		const imported = await c.org1.blueprints.import({ export: envelope });
		// An import never republishes another organization's blueprint.
		expect(imported.blueprint).toMatchObject({
			organizationId: "org-1",
			name: "Catalog Pod",
			status: "draft",
			visibility: "org",
		});
		expect(imported.revision).toMatchObject({
			revision: 1,
			publishedAt: null,
			definition: DEFINITION,
		});
		expect(
			(await c.env.DB.prepare(
				"SELECT status, visibility FROM os_blueprints WHERE id = ?",
			)
				.bind(imported.blueprint.id)
				.first()) as Record<string, unknown>,
		).toEqual({ status: "draft", visibility: "org" });
	});

	it("records fork lineage that names the origin after the source becomes unreachable", async () => {
		const sourceId = await publish(c.org2, "Origin Pod");
		const { export: envelope } = await c.org2.blueprints.export({
			blueprintId: sourceId,
		});
		// The source organization is gone by the time the envelope is imported.
		await c.env.DB.prepare("DELETE FROM os_blueprints WHERE id = ?")
			.bind(sourceId)
			.run();
		await c.env.DB.prepare(
			"DELETE FROM organizations WHERE id = 'org-2'",
		).run();

		const imported = await c.org1.blueprints.import({ export: envelope });
		expect(imported.blueprint.lineage).toEqual({
			version: 1,
			chain: [
				{
					organizationId: "org-2",
					organizationName: "Second Org",
					blueprintId: sourceId,
					blueprintName: "Origin Pod",
					revisionId: envelope.source.revisionId,
					revision: 1,
					definitionSha256: await canonicalDigest(DEFINITION),
					forkedAt: envelope.exportedAt,
					// The import records the claim as UNVERIFIED, whatever the
					// envelope asserted: its digest proves self-consistency, not that
					// the named organization ever published that revision.
					via: "export",
					attested: false,
				},
			],
			truncated: false,
		});
		// The digest identifies the ancestor's content without any read of it.
		expect(imported.blueprint.lineage?.chain[0]?.definitionSha256).toBe(
			await canonicalDigest(imported.revision.definition),
		);
		// Persisted on the row, and it survives an ordinary read.
		const stored = (await c.env.DB.prepare(
			"SELECT lineage FROM os_blueprints WHERE id = ?",
		)
			.bind(imported.blueprint.id)
			.first()) as { lineage: string };
		expect(JSON.parse(stored.lineage).chain[0].organizationId).toBe("org-2");
		const read = await c.org1.blueprints.get({
			blueprintId: imported.blueprint.id,
		});
		expect(read.blueprint.lineage).toEqual(imported.blueprint.lineage);
	});

	it("chains a fork of a fork, newest ancestor first", async () => {
		const sourceId = await publish(c.org2, "Origin Pod");
		const first = await c.org1.blueprints.import({
			export: (await c.org2.blueprints.export({ blueprintId: sourceId }))
				.export,
		});
		// org-1 re-exports its own copy and imports it again under a new name.
		const second = await c.org1.blueprints.import({
			export: (
				await c.org1.blueprints.export({ blueprintId: first.blueprint.id })
			).export,
			name: "Origin Pod (fork)",
		});

		expect(second.blueprint.lineage?.chain).toHaveLength(2);
		expect(
			second.blueprint.lineage?.chain.map((entry) => [
				entry.organizationId,
				entry.blueprintId,
			]),
		).toEqual([
			["org-1", first.blueprint.id],
			["org-2", sourceId],
		]);
		expect(second.blueprint.lineage?.truncated).toBe(false);
	});

	it("binds export to the owning organization and to the named blueprint", async () => {
		const blueprintId = await publish(c.org1);
		const otherId = await publish(c.org1, "Other Pod");
		const other = await c.org1.blueprints.export({ blueprintId: otherId });

		// A blueprint another tenant owns is unreachable.
		await expect(
			c.org2.blueprints.export({ blueprintId }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		// A revision of a DIFFERENT blueprint in the SAME organization is not this
		// blueprint's revision, even though the org predicate is satisfied.
		await expect(
			c.org1.blueprints.export({
				blueprintId,
				revisionId: other.export.source.revisionId,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		// A blueprint with no revision has nothing to project.
		const { blueprint: empty } = await c.org1.blueprints.create({
			name: "Empty Pod",
		});
		await expect(
			c.org1.blueprints.export({ blueprintId: empty.id }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("fails CONFLICT when the imported name is taken, and accepts an explicit rename", async () => {
		const sourceId = await publish(c.org2, "Sales Pod");
		const { export: envelope } = await c.org2.blueprints.export({
			blueprintId: sourceId,
		});
		await c.org1.blueprints.create({ name: "Sales Pod" });

		await expect(
			c.org1.blueprints.import({ export: envelope }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(
			c.org1.blueprints.import({ export: envelope, name: "Sales Pod (EU)" }),
		).resolves.toMatchObject({ blueprint: { name: "Sales Pod (EU)" } });
	});

	it("records structured lineage on a gallery import too, beside the prose provenance", async () => {
		const sourceId = await publish(c.org2, "Gallery Pod");
		await c.org2.blueprints.setVisibility({
			blueprintId: sourceId,
			visibility: "catalog",
		});

		const result = await c.org1.blueprints.instantiateFromGallery({
			blueprintId: sourceId,
			workspaceName: "Gallery US",
		});
		expect(result.blueprint.lineage).toEqual({
			version: 1,
			chain: [
				expect.objectContaining({
					organizationId: "org-2",
					organizationName: "Second Org",
					blueprintId: sourceId,
					revision: 1,
					definitionSha256: await canonicalDigest(DEFINITION),
					via: "gallery",
				}),
			],
			truncated: false,
		});
		// The free-text provenance is still there; lineage is the machine-readable
		// record beside it, not a replacement.
		expect(result.blueprint.description).toContain(
			"Imported from the blueprint gallery",
		);
	});
});

describe("blueprint upgrade preview and decision", () => {
	let c: ReturnType<typeof clients>;

	const SKILL = {
		id: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d",
		slug: "lead-triage",
		revision: 4,
		lifecycleState: "active",
		files: { "scripts/workflow.ts": "export default async () => ({})" },
	};

	function requirements(revision: number) {
		return {
			version: 1 as const,
			skills: [
				{
					role: "skill" as const,
					skillId: SKILL.id,
					slug: SKILL.slug,
					revision,
					workflowSha256: null,
				},
			],
			connections: [],
			policies: [],
			runtime: null,
			layout: null,
			outputs: [],
		};
	}

	/** Revision 1: gadgets Keep + Drop, skill pinned at revision 4. */
	const REVISION_1 = {
		gadgets: [
			{ name: "Keep", manifest: { entry: "keep.ts", capabilities: [] } },
			{ name: "Drop", manifest: { entry: "drop.ts", capabilities: [] } },
		],
		requirements: requirements(4),
	};
	/** Revision 2: Keep's manifest moved, Drop is gone, New arrives, pin moved to 5. */
	const REVISION_2 = {
		gadgets: [
			{
				name: "Keep",
				manifest: { entry: "keep-v2.ts", capabilities: ["email:read"] },
			},
			{ name: "New", manifest: { entry: "new.ts", capabilities: [] } },
		],
		requirements: requirements(5),
	};

	beforeEach(() => {
		c = clients();
		mocks.getSkillEntryBySlug.mockReset();
		mocks.getPolicyPackBySlugForOrganization.mockReset();
		mocks.resolveConnectionAvailability.mockReset();
	});

	/** Publish revision 1, instantiate a workspace from it, then publish revision 2. */
	async function seedUpgrade() {
		mocks.getSkillEntryBySlug.mockResolvedValue(SKILL);
		const { blueprint } = await c.org1.blueprints.create({ name: "Sales Pod" });
		await c.org1.blueprints.revise({
			blueprintId: blueprint.id,
			definition: REVISION_1 as never,
		});
		await c.org1.blueprints.publish({ blueprintId: blueprint.id });
		const instantiated = await c.org1.blueprints.instantiate({
			blueprintId: blueprint.id,
			workspaceName: "Sales US",
		});
		const revised = await c.org1.blueprints.revise({
			blueprintId: blueprint.id,
			definition: REVISION_2 as never,
		});
		await c.org1.blueprints.publish({ blueprintId: blueprint.id });
		return {
			blueprintId: blueprint.id,
			workspaceId: instantiated.workspace.id,
			pinnedRevisionId: instantiated.revision.id,
			candidateRevisionId: revised.revision.id,
			instantiationPreflight: instantiated.preflight,
		};
	}

	it("resolves the candidate against THIS org and reports drift under the unchanged pin separately", async () => {
		const seeded = await seedUpgrade();
		// The skill row moved to revision 5 AFTER instantiation. That satisfies the
		// candidate's pin and breaks the pinned one — drift the report must not
		// blame on the upgrade.
		mocks.getSkillEntryBySlug.mockResolvedValue({ ...SKILL, revision: 5 });

		const { report } = await c.org1.workspaces.previewBlueprintUpgrade({
			workspaceId: seeded.workspaceId,
		});

		expect(report).toMatchObject({
			workspaceId: seeded.workspaceId,
			blueprintId: seeded.blueprintId,
			pinnedRevisionId: seeded.pinnedRevisionId,
			pinnedRevision: 1,
			candidateRevisionId: seeded.candidateRevisionId,
			candidateRevision: 2,
			upToDate: false,
			applyAllowed: true,
		});
		// All three columns are real resolutions, not reconstructions.
		expect(report.preflightAtInstantiation).toEqual(
			seeded.instantiationPreflight,
		);
		expect(report.pinnedPreflightNow.revisionId).toBe(seeded.pinnedRevisionId);
		expect(report.candidatePreflightNow.revisionId).toBe(
			seeded.candidateRevisionId,
		);
		expect(report.pinnedPreflightNow.status).toBe("blocked");
		expect(report.candidatePreflightNow.status).toBe("ready");

		expect(report.requirementChanges).toEqual([
			{
				kind: "skill",
				subject: "skill:lead-triage",
				change: "repinned",
				verdictAtInstantiation: "allowed",
				pinnedVerdict: "incompatible",
				candidateVerdict: "allowed",
				driftedSinceInstantiation: true,
				pinnedDeclaredPin: { id: SKILL.id, revision: 4, digest: null },
				candidateDeclaredPin: { id: SKILL.id, revision: 5, digest: null },
				candidateResolvedPin: { id: SKILL.id, revision: 5, digest: null },
				reason: expect.any(String),
			},
		]);
		expect(report.gadgetChanges).toEqual([
			{ name: "Keep", change: "changed" },
			{ name: "New", change: "added" },
			{ name: "Drop", change: "removed" },
		]);
		// Resolution happened in the CALLER's organization, both times.
		expect(mocks.getSkillEntryBySlug).toHaveBeenCalledWith(
			expect.anything(),
			"org-1",
			"lead-triage",
		);
	});

	it("refuses to report on a workspace that came from no blueprint", async () => {
		const { workspace } = await c.org1.workspaces.create({ name: "Hand Made" });
		await expect(
			c.org1.workspaces.previewBlueprintUpgrade({
				workspaceId: workspace.id,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("applies: re-pins, reconciles gadgets, and keeps the revision it left as the rollback reference", async () => {
		const seeded = await seedUpgrade();
		mocks.getSkillEntryBySlug.mockResolvedValue({ ...SKILL, revision: 5 });

		const applied = await c.org1.workspaces.decideBlueprintUpgrade({
			workspaceId: seeded.workspaceId,
			decision: "apply",
			candidateRevisionId: seeded.candidateRevisionId,
			reason: "the new pin resolves here",
		});

		expect(applied.workspace).toMatchObject({
			sourceBlueprintRevisionId: seeded.candidateRevisionId,
			sourceBlueprintRevisionNumber: 2,
		});
		// The workspace can name the revision it would return to, WITH the
		// evidence recorded while it was pinned there.
		expect(applied.workspace.rollbackReference).toEqual({
			revisionId: seeded.pinnedRevisionId,
			revision: 1,
			preflight: seeded.instantiationPreflight,
		});
		// The pinned envelope was replaced with the candidate's, not the stale one.
		expect(applied.workspace.instantiationPreflight).toEqual(
			applied.report.candidatePreflightNow,
		);
		expect(applied.decision).toMatchObject({
			version: 1,
			decision: "applied",
			decidedByKind: "user",
			reviewedRevisionId: seeded.candidateRevisionId,
			reviewedRevision: 2,
			pinnedRevisionId: seeded.candidateRevisionId,
			pinnedRevision: 2,
			reason: "the new pin resolves here",
			summary: {
				candidateStatus: "ready",
				applyAllowed: true,
				requirementsChanged: 1,
				gadgetsAdded: 1,
				gadgetsChanged: 1,
				gadgetsRemoved: 1,
			},
		});

		// Gadget reconcile: Keep appended a revision and moved its pointer, New
		// arrived at revision 1, Drop was archived rather than deleted.
		const gadgets = await c.org1.gadgets.list({
			workspaceId: seeded.workspaceId,
		});
		const byName = new Map(gadgets.items.map((item) => [item.name, item]));
		expect(byName.get("Keep")).toMatchObject({
			status: "active",
			sourceBlueprintRevisionId: seeded.candidateRevisionId,
		});
		expect(byName.get("New")).toMatchObject({
			status: "active",
			sourceBlueprintRevisionId: seeded.candidateRevisionId,
		});
		expect(byName.get("Drop")).toMatchObject({ status: "archived" });
		// Keep serves revision 2, and revision 1 is still there: gadget revisions
		// are append-only, so an applied upgrade destroys nothing.
		const keep = await c.org1.gadgets.get({
			workspaceId: seeded.workspaceId,
			gadgetId: byName.get("Keep")!.id,
		});
		expect(keep.currentRevision).toMatchObject({
			revision: 2,
			manifest: { entry: "keep-v2.ts", capabilities: ["email:read"] },
		});
		const keepRevisions = (await c.env.DB.prepare(
			"SELECT revision, manifest FROM os_gadget_revisions WHERE gadget_id = ? ORDER BY revision",
		)
			.bind(byName.get("Keep")!.id)
			.all()) as { results: { revision: number; manifest: string }[] };
		expect(
			keepRevisions.results.map((row) => [
				row.revision,
				JSON.parse(row.manifest).entry,
			]),
		).toEqual([
			[1, "keep.ts"],
			[2, "keep-v2.ts"],
		]);
		expect(
			(
				await c.org1.gadgets.get({
					workspaceId: seeded.workspaceId,
					gadgetId: byName.get("New")!.id,
				})
			).currentRevision,
		).toMatchObject({ revision: 1, manifest: { entry: "new.ts" } });

		// And on the row, where the retained envelope actually lives.
		const row = (await c.env.DB.prepare(
			"SELECT source_blueprint_revision_id, previous_blueprint_revision_id, previous_blueprint_revision_number, previous_instantiation_preflight FROM os_workspaces WHERE id = ?",
		)
			.bind(seeded.workspaceId)
			.first()) as Record<string, unknown>;
		expect(row).toMatchObject({
			source_blueprint_revision_id: seeded.candidateRevisionId,
			previous_blueprint_revision_id: seeded.pinnedRevisionId,
			previous_blueprint_revision_number: 1,
		});
		expect(JSON.parse(String(row.previous_instantiation_preflight))).toEqual(
			seeded.instantiationPreflight,
		);
	});

	it("records a stay_pinned review that moves nothing, and is distinguishable from never having looked", async () => {
		const seeded = await seedUpgrade();
		mocks.getSkillEntryBySlug.mockResolvedValue({ ...SKILL, revision: 5 });

		// Before any review: no decision is recorded at all.
		const before = await c.org1.workspaces.get({
			workspaceId: seeded.workspaceId,
		});
		expect(before.workspace.blueprintDecision).toBeNull();

		const stayed = await c.org1.workspaces.decideBlueprintUpgrade({
			workspaceId: seeded.workspaceId,
			decision: "stay_pinned",
			candidateRevisionId: seeded.candidateRevisionId,
			reason: "waiting for the quarter to close",
		});

		expect(stayed.decision).toMatchObject({
			decision: "stay_pinned",
			reviewedRevisionId: seeded.candidateRevisionId,
			reviewedRevision: 2,
			// The pin AFTER the decision — unchanged.
			pinnedRevisionId: seeded.pinnedRevisionId,
			pinnedRevision: 1,
			reason: "waiting for the quarter to close",
		});
		// The evidence recorded beside the decision came from the report that was
		// actually resolved, so "we looked" is a claim a read supports.
		expect(stayed.decision.summary).toMatchObject({
			candidateStatus: "ready",
			requirementsChanged: 1,
			gadgetsAdded: 1,
			gadgetsRemoved: 1,
		});

		// Nothing moved: same pin, no rollback reference, gadgets untouched.
		expect(stayed.workspace).toMatchObject({
			sourceBlueprintRevisionId: seeded.pinnedRevisionId,
			sourceBlueprintRevisionNumber: 1,
			rollbackReference: null,
		});
		const gadgets = await c.org1.gadgets.list({
			workspaceId: seeded.workspaceId,
		});
		expect(gadgets.items.map((item) => item.name).sort()).toEqual([
			"Drop",
			"Keep",
		]);
		// The decision survives an ordinary read: a later reader can tell this
		// workspace was reviewed from one that never was.
		const after = await c.org1.workspaces.get({
			workspaceId: seeded.workspaceId,
		});
		expect(after.workspace.blueprintDecision).toEqual(stayed.decision);
	});

	it("refuses an apply whose candidate does not resolve here, and still allows staying pinned", async () => {
		const seeded = await seedUpgrade();
		// Neither pin resolves: the skill slug is gone from this organization.
		mocks.getSkillEntryBySlug.mockResolvedValue(undefined);

		const failure = await c.org1.workspaces
			.decideBlueprintUpgrade({
				workspaceId: seeded.workspaceId,
				decision: "apply",
				candidateRevisionId: seeded.candidateRevisionId,
			})
			.catch((error: unknown) => error as { code: string; data?: unknown });
		expect(failure).toMatchObject({ code: "UNPROCESSABLE_CONTENT" });
		expect(
			(failure as { data: { preflight: { status: string } } }).data.preflight,
		).toMatchObject({ status: "blocked", instantiateAllowed: false });

		// Nothing was written by the refused apply.
		const untouched = await c.org1.workspaces.get({
			workspaceId: seeded.workspaceId,
		});
		expect(untouched.workspace).toMatchObject({
			sourceBlueprintRevisionId: seeded.pinnedRevisionId,
			blueprintDecision: null,
			rollbackReference: null,
		});

		// A blocked candidate is exactly when an operator records a stay.
		const stayed = await c.org1.workspaces.decideBlueprintUpgrade({
			workspaceId: seeded.workspaceId,
			decision: "stay_pinned",
			candidateRevisionId: seeded.candidateRevisionId,
			reason: "the candidate does not resolve in our tenant",
		});
		expect(stayed.decision.summary).toMatchObject({
			candidateStatus: "blocked",
			applyAllowed: false,
		});
		expect(stayed.decision.summary.blockingReasons.length).toBeGreaterThan(0);
	});

	it("refuses an apply that names the revision the workspace is already pinned to", async () => {
		const seeded = await seedUpgrade();
		mocks.getSkillEntryBySlug.mockResolvedValue(SKILL);

		const { report } = await c.org1.workspaces.previewBlueprintUpgrade({
			workspaceId: seeded.workspaceId,
			candidateRevisionId: seeded.pinnedRevisionId,
		});
		expect(report.upToDate).toBe(true);
		expect(
			report.requirementChanges.every((c) => c.change === "unchanged"),
		).toBe(true);
		expect(report.gadgetChanges.every((c) => c.change === "unchanged")).toBe(
			true,
		);

		await expect(
			c.org1.workspaces.decideBlueprintUpgrade({
				workspaceId: seeded.workspaceId,
				decision: "apply",
				candidateRevisionId: seeded.pinnedRevisionId,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("binds both verbs to the owning organization and to the workspace's own blueprint", async () => {
		const seeded = await seedUpgrade();
		mocks.getSkillEntryBySlug.mockResolvedValue(SKILL);
		// A revision of a different blueprint in the same organization.
		const { blueprint: other } = await c.org1.blueprints.create({
			name: "Other Pod",
		});
		const otherRevision = await c.org1.blueprints.revise({
			blueprintId: other.id,
			definition: { gadgets: [] } as never,
		});

		await expect(
			c.org2.workspaces.previewBlueprintUpgrade({
				workspaceId: seeded.workspaceId,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			c.org1.workspaces.previewBlueprintUpgrade({
				workspaceId: seeded.workspaceId,
				candidateRevisionId: otherRevision.revision.id,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			c.org2.workspaces.decideBlueprintUpgrade({
				workspaceId: seeded.workspaceId,
				decision: "stay_pinned",
				candidateRevisionId: seeded.candidateRevisionId,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
