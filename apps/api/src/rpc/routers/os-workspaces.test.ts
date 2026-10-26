import * as calendarAccounts from "../../services/calendar-coordinator/credentials";
import * as namedVault from "./connections/policy-resolution";
import {
	kernelConversations,
	kernelRuntimeRuns,
} from "@tedix/db/schema/cognitive-runtime";
/**
 * Tedix OS workspace-domain router: tenant binding, creator accountability,
 * revision optimistic concurrency surfacing, and the blueprint publish gate —
 * exercised end to end against a real D1 facade (`createD1Facade` rejects the
 * two Drizzle idioms that break on production D1).
 */

import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
// The same digest the export path records, so a lineage assertion compares
// against the real producer rather than a hand-copied constant.
import { osWorkspacesContractRouter } from "./os-workspaces";

import { userContext, clients } from "./__tests__/os-workspaces-env";

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
	getTediBySlug: vi.fn(),
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
	getTediBySlug: mocks.getTediBySlug,
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

describe("workspaces", () => {
	let c: ReturnType<typeof clients>;
	beforeEach(() => {
		c = clients();
	});

	it("saves a chat as a workspace with the outputs it made, once", async () => {
		const db = createDbClient(c.env.DB);
		const { workspace: general } = await c.org1.workspaces.create({
			name: "General",
		});
		const made = await c.org1.outputs.create({
			kind: "document",
			title: "Trip notes",
			workspaceId: general.id,
		});
		const unrelated = await c.org1.outputs.create({
			kind: "sheet",
			title: "Unrelated",
			workspaceId: general.id,
		});
		await db.insert(kernelRuntimeRuns).values({
			id: "chat-run",
			organizationId: "org-1",
			conversationId: "home:os:chat-1",
			status: "completed",
			createdAt: "2026-10-16",
			updatedAt: "2026-10-16",
			outputRevisionId: made.revision.id,
		});
		await db.insert(kernelConversations).values({
			id: "org-1:home:os:chat-1",
			organizationId: "org-1",
			conversationId: "home:os:chat-1",
			lastMessageAt: "2026-10-16",
			createdAt: "2026-10-16",
			updatedAt: "2026-10-16",
		});

		await expect(
			c.org2.workspaces.createFromConversation({
				conversationId: "home:os:chat-1",
				name: "Trip",
			}),
		).rejects.toThrow(/not found/i);
		const saved = await c.org1.workspaces.createFromConversation({
			conversationId: "home:os:chat-1",
			name: "General",
		});
		// The taken name gets a suffix instead of failing the save.
		expect(saved.workspace.name).toMatch(/^General · [0-9a-f]{8}$/);
		// The saving member's chat stays theirs.
		expect(saved.workspace).toMatchObject({
			visibility: "private",
			ownerUserId: "user-1",
		});
		expect(saved.movedOutputIds).toEqual([made.output.id]);
		expect(
			(await c.org1.outputs.get({ outputId: made.output.id })).output
				.workspaceId,
		).toBe(saved.workspace.id);
		expect(
			(await c.org1.outputs.get({ outputId: unrelated.output.id })).output
				.workspaceId,
		).toBe(general.id);
		const [conversation] = await db
			.select()
			.from(kernelConversations)
			.where(eq(kernelConversations.conversationId, "home:os:chat-1"));
		expect(conversation?.workspaceId).toBe(saved.workspace.id);
		await expect(
			c.org1.workspaces.createFromConversation({
				conversationId: "home:os:chat-1",
				name: "Again",
			}),
		).rejects.toThrow(/already belongs to a workspace/);
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

	it("restores an archived workspace with its gadgets and outputs intact", async () => {
		const { workspace } = await c.org1.workspaces.create({ name: "Revived" });
		const { output } = await c.org1.outputs.create({
			workspaceId: workspace.id,
			kind: "document",
			title: "Kept draft",
			content: { kind: "document", blocks: [] },
		});
		await c.org1.workspaces.archive({ workspaceId: workspace.id });
		expect(
			(await c.org1.workspaces.list({ status: "archived" })).items.map(
				({ id }) => id,
			),
		).toContain(workspace.id);

		await expect(
			c.org2.workspaces.restore({ workspaceId: workspace.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		const restored = await c.org1.workspaces.restore({
			workspaceId: workspace.id,
		});
		expect(restored.workspace).toMatchObject({
			id: workspace.id,
			name: "Revived",
			status: "active",
		});
		expect(
			(await c.org1.workspaces.list({ status: "active" })).items.map(
				({ id }) => id,
			),
		).toContain(workspace.id);
		expect(
			(await c.org1.outputs.list({ workspaceId: workspace.id })).items.map(
				({ id }) => id,
			),
		).toContain(output.id);
		// Restoring an active workspace is a no-op, not an error.
		await expect(
			c.org1.workspaces.restore({ workspaceId: workspace.id }),
		).resolves.toMatchObject({ workspace: { status: "active" } });
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
		const nextPage = await c.org1.workspaces.list({ limit: 2, offset: 2 });
		expect(nextPage.items.map((row) => row.id)).toEqual(
			all.items.slice(2).map((row) => row.id),
		);
		expect(nextPage.truncated).toBe(false);
		expect([...page.items, ...nextPage.items]).toEqual(all.items);
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
	it("creates and edits unique resource slots with tenant and stale-edit fences", async () => {
		const c = clients();
		const { workspace } = await c.org1.workspaces.create({ name: "Resources" });
		const selection = {
			providerId: "github",
			connectionScope: "tenant" as const,
			requiredScopes: ["contents:read"],
			resourceType: "repository",
			providerResourceId: "example/repository",
			name: "Repository",
			metadata: {},
		};
		const { resource } = await c.org1.resources.create({
			workspaceId: workspace.id,
			selection,
			slot: "opportunities",
		});
		expect(resource.slot).toBe("opportunities");
		await expect(
			c.org1.resources.create({
				workspaceId: workspace.id,
				selection: { ...selection, providerResourceId: "example/another" },
				slot: "opportunities",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		const { resource: manual } = await c.org1.resources.create({
			workspaceId: workspace.id,
			selection: { ...selection, providerResourceId: "example/manual" },
		});
		expect(manual.slot).toBeNull();
		const input = {
			workspaceId: workspace.id,
			resourceId: manual.id,
			expectedUpdatedAt: manual.updatedAt,
			slot: "opportunities",
		};
		await expect(c.org1.resources.rename(input)).rejects.toMatchObject({
			code: "CONFLICT",
		});
		await expect(c.org2.resources.rename(input)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(
			c.org1.resources.rename({
				...input,
				expectedUpdatedAt: "stale",
				slot: "other",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		const cleared = await c.org1.resources.rename({
			...input,
			resourceId: resource.id,
			expectedUpdatedAt: resource.updatedAt,
			slot: null,
		});
		expect(cleared.resource).toMatchObject({
			slot: null,
			name: selection.name,
		});
		const assigned = await c.org1.resources.rename(input);
		expect(assigned.resource).toMatchObject({
			slot: "opportunities",
			name: selection.name,
		});
		const renamed = await c.org1.resources.rename({
			workspaceId: workspace.id,
			resourceId: manual.id,
			expectedUpdatedAt: assigned.resource.updatedAt,
			name: "Renamed",
		});
		expect(renamed.resource).toMatchObject({
			slot: "opportunities",
			name: "Renamed",
		});
		const removed = await c.org1.resources.remove({
			workspaceId: workspace.id,
			resourceId: manual.id,
			expectedUpdatedAt: renamed.resource.updatedAt,
		});
		await expect(
			c.org1.resources.rename({
				...input,
				expectedUpdatedAt: removed.resource.updatedAt,
				slot: null,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("verifies exact calendar existence, ACL and scopes instead of accepting caller metadata", async () => {
		const c = clients();
		const { workspace } = await c.org1.workspaces.create({
			name: "Calendar binding",
		});
		const instanceId = "00000000-0000-4000-8000-000000000003";
		vi.spyOn(calendarAccounts, "supportedCalendarAccounts").mockResolvedValue([
			{
				providerId: "google-drive",
				connectionInstanceId: instanceId,
				adapter: "google",
			},
		] as never);
		const listCalendars = vi
			.fn()
			.mockResolvedValue([
				{ id: "calendar-a", canRead: true, canWrite: false },
			]);
		vi.spyOn(calendarAccounts, "resolveCalendarAdapter").mockResolvedValue({
			adapter: { listCalendars },
		} as never);
		vi.spyOn(namedVault, "fetchNamedConnection").mockResolvedValue({
			id: "grant",
			tokenSub: "subject",
			scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
			accessToken: "secret",
		});
		const selection = {
			providerId: "google-drive",
			connectionScope: "user" as const,
			connectionInstanceId: instanceId,
			resourceType: "calendar",
			providerResourceId: "calendar-a",
			name: "Calendar",
			requiredScopes: [],
		};
		const result = await c.org1.resources.create({
			workspaceId: workspace.id,
			selection,
		});
		expect(result.resource.providerAccess).toEqual({
			canRead: true,
			canWrite: false,
		});
		expect(result.resource.requiredScopes).toEqual([
			"https://www.googleapis.com/auth/calendar.readonly",
		]);
		await expect(
			c.org1.resources.create({
				workspaceId: workspace.id,
				selection: { ...selection, providerResourceId: "not-in-account" },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			c.org1.resources.create({
				workspaceId: workspace.id,
				selection: {
					...selection,
					requiredScopes: ["https://www.googleapis.com/auth/calendar.events"],
				},
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(calendarAccounts.resolveCalendarAdapter).toHaveBeenCalledWith(
			expect.anything(),
			"org-1",
			expect.objectContaining({ connectionInstanceId: instanceId }),
		);
		vi.mocked(namedVault.fetchNamedConnection).mockRestore();
		vi.mocked(calendarAccounts.resolveCalendarAdapter).mockRestore();
		vi.mocked(calendarAccounts.supportedCalendarAccounts).mockRestore();
	});

	it("binds a personal resource to its authenticated owner and refuses another user's slot", async () => {
		const c = clients();
		const { workspace } = await c.org1.workspaces.create({
			name: "Exact account",
		});
		const selection = {
			providerId: "google-drive",
			connectionScope: "user" as const,
			connectionInstanceId: "00000000-0000-4000-8000-000000000003",
			resourceType: "file",
			providerResourceId: "file-a",
			name: "File",
			metadata: {},
		};
		const { resource } = await c.org1.resources.create({
			workspaceId: workspace.id,
			selection,
		});
		expect(resource).toMatchObject({
			personalOwnerUserId: "user-1",
			connectionInstanceId: selection.connectionInstanceId,
		});
		const other = createRouterClient(osWorkspacesContractRouter, {
			context: userContext({
				env: c.env,
				organizationId: "org-1",
				sub: "other-user",
			}),
		});
		await expect(
			other.resources.create({
				workspaceId: workspace.id,
				selection: { ...selection, providerResourceId: "file-b" },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			c.machine.resources.create({
				workspaceId: workspace.id,
				selection: { ...selection, providerResourceId: "file-c" },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("rebinds the connection requirement while preserving exact object identity and author authority", async () => {
		const c = clients();
		const { workspace } = await c.org1.workspaces.create({ name: "CSF" });
		const { resource } = await c.org1.resources.create({
			workspaceId: workspace.id,
			selection: {
				providerId: "google-drive",
				connectionScope: "user",
				connectionInstanceId: "00000000-0000-4000-8000-000000000003",
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
				...userContext({
					env: c.env,
					organizationId: "org-1",
					sub: "reader-1",
				}),
				user: {
					...userContext({
						env: c.env,
						organizationId: "org-1",
						sub: "reader-1",
					}).user!,
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
			context: userContext({
				env: c.env,
				organizationId: "org-1",
				sub: "user-2",
			}),
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

		const renamed = await c.org1.gadgets.rename({
			workspaceId,
			gadgetId: gadget.id,
			name: "Revenue overview",
		});
		expect(renamed.gadget).toMatchObject({
			name: "Revenue overview",
			currentRevisionId: fetched.gadget.currentRevisionId,
		});
		await expect(
			c.org2.gadgets.rename({
				workspaceId,
				gadgetId: gadget.id,
				name: "Nope",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		const archived = await c.org1.gadgets.archive({
			workspaceId,
			gadgetId: gadget.id,
		});
		expect(archived.gadget.status).toBe("archived");
	});

	it("records a runtime app's files with its revision and reads them back by revision", async () => {
		const { gadget } = await c.org1.gadgets.create({
			workspaceId,
			name: "Opportunity cards",
		});
		const manifest = {
			entry: "tedix:runtime/v1",
			capabilities: [],
			config: { version: 1, settings: { sheetTitle: "Opportunities" } },
		};
		// Code without the runtime entry, and the runtime entry without code,
		// are both refused before anything is written.
		await expect(
			c.org1.gadgets.revise({
				workspaceId,
				gadgetId: gadget.id,
				manifest: { entry: "main.ts" },
				files: { "server.js": "export {}", "client.js": "" },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			c.org1.gadgets.revise({ workspaceId, gadgetId: gadget.id, manifest }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(
			await c.org1.gadgets.getCode({ workspaceId, gadgetId: gadget.id }),
		).toEqual({ code: null });

		const first = await c.org1.gadgets.revise({
			workspaceId,
			gadgetId: gadget.id,
			manifest,
			files: { "server.js": "export class App {}", "client.js": "render()" },
			expectedRevision: 0,
		});
		const code = await c.org1.gadgets.getCode({
			workspaceId,
			gadgetId: gadget.id,
		});
		expect(code.code).toMatchObject({
			revisionId: first.revision.id,
			revision: 1,
			files: { "server.js": "export class App {}", "client.js": "render()" },
			codeLength: 27,
		});
		const second = await c.org1.gadgets.revise({
			workspaceId,
			gadgetId: gadget.id,
			manifest,
			files: { "server.js": "export class App2 {}", "client.js": "render()" },
			expectedRevision: 1,
		});
		expect(
			(await c.org1.gadgets.getCode({ workspaceId, gadgetId: gadget.id })).code
				?.revision,
		).toBe(2);
		expect(
			(
				await c.org1.gadgets.getCode({
					workspaceId,
					gadgetId: gadget.id,
					revisionId: first.revision.id,
				})
			).code?.files["server.js"],
		).toBe("export class App {}");
		expect(second.revision.revision).toBe(2);
		await expect(
			c.org2.gadgets.getCode({ workspaceId, gadgetId: gadget.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("Work app entry", () => {
	it("returns current manifests in one read and fences private, archived and foreign workspaces before limiting", async () => {
		const c = clients();
		const other = createRouterClient(osWorkspacesContractRouter, {
			context: userContext({
				env: c.env,
				organizationId: "org-1",
				sub: "user-2",
			}),
		});
		async function install(
			client: typeof c.org1,
			name: string,
			visibility: "private" | "org",
		) {
			const { workspace } = await client.workspaces.create({
				name,
				visibility,
			});
			const { gadget } = await client.gadgets.create({
				workspaceId: workspace.id,
				name: "Deck",
			});
			await client.gadgets.revise({
				workspaceId: workspace.id,
				gadgetId: gadget.id,
				manifest: {
					entry: "tedix:app/decision-deck",
					navigation: { work: "deck", workDefault: true },
					capabilities: [],
					config: { version: 1 },
				},
			});
			return { workspace, gadget };
		}
		const hidden = await install(other, "Private", "private");
		const foreign = await install(c.org2, "Foreign", "org");
		const visible = await install(c.org1, "Mine", "private");
		const shared = await install(c.org1, "Shared", "org");
		const archived = await install(c.org1, "Archived", "org");
		await c.org1.workspaces.archive({ workspaceId: archived.workspace.id });
		const result = await c.org1.gadgets.workApps({ limit: 1 });
		expect(result.items).toHaveLength(1);
		expect(result.truncated).toBe(true);
		const firstVisible = [visible.gadget, shared.gadget].sort(
			(a, b) =>
				a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
		)[0];
		expect(result.items[0].gadget.id).toBe(firstVisible.id);
		expect(result.items[0].currentRevision.manifest.navigation?.work).toBe(
			"deck",
		);
		const all = await c.org1.gadgets.workApps({ limit: 100 });
		expect(all.items.map((row) => row.gadget.id).sort()).toEqual(
			[visible.gadget.id, shared.gadget.id].sort(),
		);
		expect(all.items.map((row) => row.gadget.id)).not.toContain(
			hidden.gadget.id,
		);
		expect(all.items.map((row) => row.gadget.id)).not.toContain(
			foreign.gadget.id,
		);
		expect(
			(await c.machine.gadgets.workApps({ limit: 100 })).items.map(
				(row) => row.gadget.id,
			),
		).toEqual([shared.gadget.id]);
	});
});
