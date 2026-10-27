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

import { unzipSync } from "fflate";
import { createRouterClient } from "@orpc/server";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { osOutputRevisions } from "@tedix/db/schema/os-workspaces";
import { createDbClient } from "@tedix/db/client";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createOsGadgetExecution } from "@tedix/db/queries/os-workspaces/executions";
import { eq } from "drizzle-orm";
import {
	type CreateSkillRunArgs,
	createSkillRun,
} from "@tedix/db/queries/skill-runs";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
// The same digest the export path records, so a lineage assertion compares
// against the real producer rather than a hand-copied constant.
import { osWorkspacesContractRouter } from "./os-workspaces";

import {
	createEnv,
	userContext,
	apiKeyContext,
	clients,
} from "./__tests__/os-workspaces-env";

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

describe("outputs", () => {
	it("rejects Markdown tables beyond the supported column bound as BAD_REQUEST", async () => {
		const row = "|" + Array.from({ length: 65 }, () => "cell").join("|") + "|";
		const separator =
			"|" + Array.from({ length: 65 }, () => "---").join("|") + "|";
		await expect(
			c.org1.outputs.create({
				kind: "document",
				title: "Too wide",
				content: [row, separator, row].join("\n"),
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("normalizes Markdown create and paragraph revise with exact revision CAS", async () => {
		const made = await c.org1.outputs.create({
			kind: "document",
			title: "Structured",
			content: "## Plan\n\n| Name | Goal |\n| --- | --- |\n| Factory | Ship |",
		});
		expect(made.revision.content).toMatchObject({
			kind: "document",
			blocks: [{ type: "heading" }, { type: "table" }],
		});
		const updated = await c.org1.outputs.revise({
			outputId: made.output.id,
			expectedRevisionId: made.revision.id,
			content: {
				kind: "document",
				blocks: [
					{
						type: "paragraph",
						text: "## Next\n\n| A | B |\n| --- | --- |\n| one | two |",
					},
				],
			},
		});
		const read = await c.org1.outputs.get({ outputId: made.output.id });
		expect(read.currentRevision.id).toBe(updated.revision.id);
		expect(read.currentRevision.content).toMatchObject({
			blocks: [{ type: "heading" }, { type: "table" }],
		});
		await expect(
			c.org1.outputs.revise({
				outputId: made.output.id,
				expectedRevisionId: made.revision.id,
				content: "Stale",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

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
		const context = apiKeyContext({ env: c.env, organizationId: "org-1" });
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

	function skillRunProducer(runId: string) {
		const context = apiKeyContext({ env: c.env, organizationId: "org-1" });
		context.serviceAccount = { clientId: "skill-runtime" };
		context.headers = new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Tedi-Scopes": "apps:write",
			"X-Tedix-Auth-Client-Id": "skill-runtime",
			"X-Tedix-Skill-Run-Id": runId,
		});
		return createRouterClient(osWorkspacesContractRouter, { context });
	}

	async function seedSkillRunWithoutGrants(runId: string) {
		await createSkillRun(createDbClient(c.env.DB), {
			id: runId,
			organizationId: "org-1",
			skillId: "skill-1",
			tediId: "tedi-1",
			workflowInstanceId: `wf-${runId}`,
			runtimeEnvironment: c.env
				.ENVIRONMENT as CreateSkillRunArgs["runtimeEnvironment"],
			status: "running",
		});
	}

	it("writes an empty envelope for a known run that admitted no source grants", async () => {
		const runId = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
		await seedSkillRunWithoutGrants(runId);
		const created = await skillRunProducer(runId).outputs.create({
			kind: "document",
			title: "Internal drift report",
		});
		expect(created.revision.accessEnvelope).toEqual({
			version: 1,
			sources: [],
		});
		expect(created.revision.producedBy).toMatchObject({ skillRunId: runId });
		mocks.authorizeDerivedOutputSources.mockClear();
		const read = await c.org1.outputs.get({ outputId: created.output.id });
		expect(read.currentRevision.accessEnvelope).toEqual({
			version: 1,
			sources: [],
		});
		expect(mocks.authorizeDerivedOutputSources).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				accessEnvelope: { version: 1, sources: [] },
			}),
		);
	});

	it("keeps a null envelope for a run this organization does not know", async () => {
		const created = await skillRunProducer(
			"2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6d",
		).outputs.create({ kind: "document", title: "Unverifiable" });
		expect(created.revision.accessEnvelope).toBeNull();
		await expect(
			c.org1.outputs.get({ outputId: created.output.id }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("re-derives a legacy null envelope from the run that authored the revision", async () => {
		const knownRun = "3c4d5e6f-7081-4b9c-8d1e-2f3a4b5c6d7e";
		const unknownRun = "4d5e6f70-8192-4cad-9e2f-3a4b5c6d7e8f";
		await seedSkillRunWithoutGrants(knownRun);
		const readable = await c.org1.outputs.create({
			kind: "document",
			title: "Legacy readable",
			content: {
				kind: "document",
				blocks: [{ type: "paragraph", text: "internal only" }],
			},
		});
		const closed = await c.org1.outputs.create({
			kind: "document",
			title: "Legacy closed",
		});
		const db = createDbClient(c.env.DB);
		await db
			.update(osOutputRevisions)
			.set({
				accessEnvelope: null,
				skillRunId: knownRun,
				createdByKind: "tedi",
			})
			.where(eq(osOutputRevisions.id, readable.revision.id));
		await db
			.update(osOutputRevisions)
			.set({
				accessEnvelope: null,
				skillRunId: unknownRun,
				createdByKind: "tedi",
			})
			.where(eq(osOutputRevisions.id, closed.revision.id));

		const read = await c.org1.outputs.get({ outputId: readable.output.id });
		expect(read.currentRevision.content).toEqual(readable.revision.content);
		await expect(
			c.org1.outputs.get({ outputId: closed.output.id }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		const library = await c.org1.outputs.library({ limit: 20 });
		const previews = Object.fromEntries(
			library.items.map((item) => [item.output.id, item.preview.kind]),
		);
		expect(previews[readable.output.id]).not.toBe("unavailable");
		expect(previews[closed.output.id]).toBe("unavailable");
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
		const readerContext = userContext({ env: c.env, organizationId: "org-1" });
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
			outputRevisionId: created.revision.id,
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
			c.org2.outputs.restore({ outputId: output.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		const restored = await c.org1.outputs.restore({ outputId: output.id });
		expect(restored.output.status).toBe("active");
		expect(restored.output.currentRevisionId).toBe(
			archived.output.currentRevisionId,
		);
		// Restoring an active output returns it unchanged.
		await expect(
			c.org1.outputs.restore({ outputId: output.id }),
		).resolves.toMatchObject({ output: { status: "active" } });
		await c.org1.outputs.archive({ outputId: output.id });
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
	it("moves an output between workspaces keeping its id, revisions and creator", async () => {
		const { workspace: from } = await c.org1.workspaces.create({
			name: "Drafts",
		});
		const { workspace: to } = await c.org1.workspaces.create({
			name: "Launch",
		});
		const created = await c.machine.outputs.create({
			workspaceId: from.id,
			kind: "document",
			title: "Launch brief",
			content: "First draft",
		});
		const revised = await c.org1.outputs.revise({
			outputId: created.output.id,
			content: "Second draft",
			expectedRevisionId: created.revision.id,
		});
		const moved = await c.org1.outputs.move({
			outputId: created.output.id,
			workspaceId: to.id,
		});
		expect(moved).toMatchObject({
			previousWorkspaceId: from.id,
			output: {
				id: created.output.id,
				workspaceId: to.id,
				createdByKind: created.output.createdByKind,
				createdById: created.output.createdById,
				currentRevisionId: revised.revision.id,
			},
		});
		const history = await c.org1.outputs.history({
			outputId: created.output.id,
		});
		expect(history.revisions.map((item) => item.revision)).toEqual([2, 1]);
		const audit = await createDbClient(c.env.DB)
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.action, "os.output.moved"));
		expect(audit).toHaveLength(1);
		expect(audit[0]?.resourceId).toBe(created.output.id);
		// Same workspace is a no-op; another org's workspace and output stay hidden.
		expect(
			(
				await c.org1.outputs.move({
					outputId: created.output.id,
					workspaceId: to.id,
				})
			).output.updatedAt,
		).toBe(moved.output.updatedAt);
		const { workspace: foreign } = await c.org2.workspaces.create({
			name: "Elsewhere",
		});
		await expect(
			c.org1.outputs.move({
				outputId: created.output.id,
				workspaceId: foreign.id,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			c.org2.outputs.move({
				outputId: created.output.id,
				workspaceId: foreign.id,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("requires external agents to name the output's workspace", async () => {
		await expect(
			c.machineAgent.outputs.create({ kind: "document", title: "Loose" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		const { workspace } = await c.org1.workspaces.create({ name: "Agents" });
		const created = await c.machineAgent.outputs.create({
			kind: "document",
			title: "Grouped",
			workspaceId: workspace.id,
		});
		expect(created.output.workspaceId).toBe(workspace.id);
	});
	it("patches visual slide props and backgrounds while preserving CAS and semantic projection", async () => {
		const created = await c.org1.outputs.create({
			kind: "presentation",
			title: "Visual parity",
		});
		const outputId = created.output.id;
		const element = {
			id: "card",
			type: "card" as const,
			x: 70,
			y: 200,
			width: 300,
			height: 200,
			style: {},
			props: {
				eyebrow: "A",
				title: "Card",
				body: "Body",
				tone: "accent" as const,
				highlight: ["Card"],
			},
		};
		const inserted = await c.org1.outputs.patchSlides({
			outputId,
			expectedRevision: 1,
			ops: [
				{
					op: "insert",
					index: 0,
					slide: {
						title: "Visual",
						canvas: {
							background: "linear-gradient(120deg, #123456, #abcdef)",
							dotGridOpacity: 0.2,
							insetSurface: { color: "#ffffff", inset: 20, radius: 8 },
							elements: [element],
						},
					},
				},
			],
		});
		expect(inserted.revision.content).toMatchObject({
			slides: [{ title: "Visual" }],
			deck: { slides: [{ dotGridOpacity: 0.2, elements: [element] }] },
		});
		const replaced = await c.org1.outputs.patchSlides({
			outputId,
			expectedRevision: 2,
			ops: [
				{
					op: "replace",
					index: 0,
					slide: {
						title: "Updated",
						canvas: {
							backgroundImage: "https://example.org/cover.png",
							elements: [
								{ ...element, props: { ...element.props, title: "Changed" } },
							],
						},
					},
				},
			],
		});
		expect(replaced.revision.content).toMatchObject({
			deck: {
				slides: [
					{
						background: "linear-gradient(120deg, #123456, #abcdef)",
						backgroundImage: "https://example.org/cover.png",
						dotGridOpacity: 0.2,
						elements: [{ props: { title: "Changed" } }],
					},
				],
			},
		});
		await expect(
			c.org1.outputs.patchSlides({
				outputId,
				expectedRevision: 2,
				ops: [{ op: "delete", index: 0 }],
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
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
				...apiKeyContext({ env: c.env, organizationId: "org-1" }),
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

	it("merges a runtime app draft into the manifest and a separate code row", async () => {
		const { workspace } = await c.org1.workspaces.create({ name: "Apps" });
		const { gadget } = await c.org1.gadgets.create({
			workspaceId: workspace.id,
			name: "Opportunity cards",
		});
		const manifest = {
			entry: "tedix:runtime/v1",
			capabilities: [],
			config: { version: 1, settings: { sheetTitle: "Opportunities" } },
		};
		await c.org1.gadgets.revise({
			workspaceId: workspace.id,
			gadgetId: gadget.id,
			manifest,
			files: { "server.js": "export class App {}", "client.js": "render()" },
		});
		const base = {
			workspaceId: workspace.id,
			documentType: "gadget" as const,
			documentId: gadget.id,
			sourceKind: "agent_session" as const,
			sourceId: "codex:session-1",
		};
		// A runtime manifest without files, and files on a non-runtime manifest,
		// are both refused before a proposal exists.
		await expect(
			c.machineAgent.collaboration.create({ ...base, content: manifest }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			c.machineAgent.collaboration.create({
				...base,
				content: {
					manifest: { entry: "main.tsx", capabilities: [] },
					files: { "server.js": "", "client.js": "" },
				},
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		const files = {
			"server.js": "export class App { async list() { return []; } }",
			"client.js": "render(2)",
		};
		const { proposal } = await c.machineAgent.collaboration.create({
			...base,
			content: { manifest, files },
		});
		expect(proposal.content).toEqual({ manifest, files });
		await c.org1.collaboration.accept({
			proposalId: proposal.id,
			expectedSequence: 0,
			rationale: "Draft reviewed in the app panel",
		});
		const merged = await c.org1.collaboration.merge({
			proposalId: proposal.id,
			expectedSequence: 0,
			rationale: "Ship the draft",
		});
		expect(merged.revision).toMatchObject({ revision: 2, manifest });
		expect(merged.revision.manifest).not.toHaveProperty("files");
		const code = await c.org1.gadgets.getCode({
			workspaceId: workspace.id,
			gadgetId: gadget.id,
		});
		expect(code.code).toMatchObject({
			revisionId: merged.revision.id,
			revision: 2,
			files,
		});
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
			richText: {
				type: "doc",
				content: [
					{
						type: "heading",
						attrs: { level: 1 },
						content: [{ type: "text", text: "Launch" }],
					},
					{
						type: "paragraph",
						content: [{ type: "text", text: "New summary." }],
					},
					{
						type: "blockquote",
						content: [
							{
								type: "paragraph",
								content: [{ type: "text", text: "Ship it." }],
							},
						],
					},
				],
			},
		});
	});

	it("keeps a document's file reference and re-derives richText on patch", async () => {
		const file = {
			workspaceId: "00000000-0000-4000-8000-000000000001",
			resourceId: "00000000-0000-4000-8000-000000000002",
		};
		// An OS-edited document: the editor body is richText-primary and blocks
		// are its projection, so the stored pair can carry formatting blocks
		// never spelled out.
		const { output } = await c.org1.outputs.create({
			kind: "document",
			title: "Preview brief",
			content: {
				kind: "document",
				file,
				blocks: [{ type: "paragraph", text: "Intro." }],
				richText: {
					type: "doc",
					content: [
						{
							type: "paragraph",
							content: [
								{ type: "text", text: "Intro with " },
								{
									type: "text",
									text: "emphasis",
									marks: [{ type: "bold" }],
								},
							],
						},
					],
				},
			},
		});

		const patched = await c.org1.outputs.patchDocument({
			outputId: output.id,
			ops: [
				{
					op: "replace",
					index: 0,
					block: { type: "paragraph", text: "Updated **body**." },
				},
			],
		});
		const content = patched.revision.content;
		if (content.kind !== "document") throw new Error("expected a document");
		expect(content.file).toEqual(file);
		expect(content.blocks).toEqual([
			{ type: "paragraph", text: "Updated **body**." },
		]);
		expect(content.richText).toEqual({
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{ type: "text", text: "Updated " },
						{
							type: "text",
							text: "body",
							marks: [{ type: "bold" }],
						},
						{ type: "text", text: "." },
					],
				},
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
			context: userContext({ env, organizationId: "org-1" }),
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
		expect(calls[0]?.payload).toMatchObject({
			allowRequestPattern: expect.arrayContaining([
				expect.stringContaining("tedix"),
			]),
			addScriptTag: [
				{ content: expect.stringContaining("document.fonts.ready") },
			],
			waitForSelector: {
				selector: 'html[data-export-ready="true"]',
				timeout: 20_000,
			},
		});
		expect(puts).toEqual([
			{
				key: `os-exports/org-1/${output.id}/rev-1.pdf`,
				size: 4,
				contentType: "application/pdf",
			},
		]);
	});

	it("prints presentation pages with backgrounds and CSS sizing", async () => {
		const { env, calls } = exportEnv({});
		const client = createRouterClient(osWorkspacesContractRouter, {
			context: userContext({ env, organizationId: "org-1" }),
		});
		const { output } = await client.outputs.create({
			kind: "presentation",
			title: "Conference",
			content: {
				kind: "presentation",
				slides: [
					{ title: "Opening", bullets: [], notes: "Private cue" },
					{ title: "Closing", bullets: [] },
				],
			},
		});
		await client.outputs.export({ outputId: output.id, format: "pdf" });
		expect(calls[0]).toMatchObject({
			action: "pdf",
			payload: {
				pdfOptions: { preferCSSPageSize: true, printBackground: true },
			},
		});
		const html = String(calls[0]?.payload.html);
		expect(html).toContain("@page { size: 1200px 675px; margin: 0; }");
		expect(html.match(/<section class="slide">/g)).toHaveLength(2);
		expect(html).not.toContain("Private cue");
		expect(html).not.toContain('<header class="export-header">');
		await client.outputs.export({ outputId: output.id, format: "png" });
		expect(calls[1]).toMatchObject({
			action: "screenshot",
			payload: {
				viewport: { width: 1200, height: 675 },
				screenshotOptions: { fullPage: true },
			},
		});
	});

	it("exports a PNG through the screenshot action with image validation", async () => {
		const { env, calls, puts } = exportEnv({});
		const client = createRouterClient(osWorkspacesContractRouter, {
			context: userContext({ env, organizationId: "org-1" }),
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
			context: userContext({ env: broken.env, organizationId: "org-1" }),
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

	it("exports stored richText as Markdown and HTML without Browser Rendering", async () => {
		const { env, calls, bodies, puts } = exportEnv({ withBrowser: false });
		const client = createRouterClient(osWorkspacesContractRouter, {
			context: userContext({ env, organizationId: "org-1" }),
		});
		const { output } = await client.outputs.create({
			kind: "document",
			title: "Rich export",
			content: {
				kind: "document",
				blocks: [{ type: "paragraph", text: "old" }],
				richText: {
					type: "doc",
					content: [
						{
							type: "heading",
							attrs: { level: 2 },
							content: [
								{ type: "text", text: "Current", marks: [{ type: "bold" }] },
							],
						},
					],
				},
			},
		});
		for (const format of ["markdown", "html"] as const) {
			const result = await client.outputs.export({
				outputId: output.id,
				format,
			});
			const extension = format === "markdown" ? "md" : "html";
			expect(result.url).toBe(
				`https://api.tedix.test/os-exports/${output.id}/rev-1.${extension}`,
			);
			expect(new TextDecoder().decode(bodies.get(result.key)!)).toContain(
				format === "markdown"
					? "## **Current**"
					: "<h2><strong>Current</strong></h2>",
			);
		}
		expect(calls).toHaveLength(0);
		expect(puts.map((put) => put.contentType)).toEqual([
			"text/markdown; charset=utf-8",
			"text/html; charset=utf-8",
		]);
	});

	it("returns a CSV or an all-sheet ZIP under the existing export response", async () => {
		const { env, bodies, puts, calls } = exportEnv({ withBrowser: false });
		const client = createRouterClient(osWorkspacesContractRouter, {
			context: userContext({ env, organizationId: "org-1" }),
		});
		const { output: single } = await client.outputs.create({
			kind: "sheet",
			title: "Single",
			content: { kind: "sheet", columns: ["Value"], rows: [[42]] },
		});
		const result = await client.outputs.export({
			outputId: single.id,
			format: "csv",
		});
		expect(result.url).toMatch(/rev-1.csv$/);
		expect(new TextDecoder().decode(bodies.get(result.key)!)).toBe(
			"Value\r\n42\r\n",
		);
		const { output: multi } = await client.outputs.create({
			kind: "sheet",
			title: "Multi",
			content: {
				kind: "sheet",
				columns: ["Value"],
				rows: [],
				workbook: {
					activeSheetId: "a",
					sheets: ["a", "b"].map((id) => ({
						id,
						name: id,
						columns: [{ id: "v", label: "Value", width: 120 }],
						rows: [[{ input: "42", value: 42 }]],
						frozenRows: 0,
						frozenColumns: 0,
					})),
				},
			},
		});
		const zipped = await client.outputs.export({
			outputId: multi.id,
			format: "csv",
		});
		expect(zipped.format).toBe("csv");
		expect(zipped.url).toMatch(/rev-1.zip$/);
		expect(Object.keys(unzipSync(bodies.get(zipped.key)!))).toEqual([
			"1-a.csv",
			"2-b.csv",
		]);
		expect(puts.map((put) => put.contentType)).toEqual([
			"text/csv; charset=utf-8",
			"application/zip",
		]);
		expect(calls).toHaveLength(0);
	});

	it("writes a real xlsx from the sheet model, without Browser Rendering", async () => {
		// No BROWSER binding at all: an Office export is generated from the
		// content model, so it must not depend on the rendering path.
		const { env, calls, puts, bodies, metadata } = exportEnv({
			withBrowser: false,
		});
		const client = createRouterClient(osWorkspacesContractRouter, {
			context: userContext({ env, organizationId: "org-1" }),
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
			context: userContext({ env, organizationId: "org-1" }),
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
			context: userContext({ env, organizationId: "org-1" }),
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
			context: userContext({ env, organizationId: "org-1" }),
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
			context: userContext({ env, organizationId: "org-2" }),
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
