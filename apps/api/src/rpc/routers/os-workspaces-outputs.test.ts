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
import {
	workspaceActivity,
	workspaceFeedLedger,
	workspaceOutputIndex,
} from "@tedix/db/schema/workspace-feed";
import { createDbClient } from "@tedix/db/client";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createOsGadgetExecution } from "@tedix/db/queries/os-workspaces/executions";
import { and, eq } from "drizzle-orm";
import {
	type CreateSkillRunArgs,
	createSkillRun,
} from "@tedix/db/queries/skill-runs";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
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

	it("refuses document fields that would be dropped instead of storing an empty body", async () => {
		await expect(
			c.org1.outputs.create({
				kind: "document",
				title: "Evidence",
				content: {
					kind: "document",
					blocks: [],
					markdown: "# Lost",
				} as never,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("stores blocks rebuilt from rich text when blocks arrive empty", async () => {
		const made = await c.org1.outputs.create({
			kind: "document",
			title: "Rich only",
			content: {
				kind: "document",
				blocks: [],
				richText: {
					type: "doc",
					content: [
						{
							type: "codeBlock",
							attrs: { language: "json" },
							content: [{ type: "text", text: '{"ok":true}' }],
						},
					],
				},
			},
		});
		const read = await c.org1.outputs.get({ outputId: made.output.id });
		expect(read.currentRevision.content).toMatchObject({
			blocks: [{ type: "code", text: '{"ok":true}' }],
		});
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
		// A legacy row predates envelopes in both the source table and the
		// projection the library reads (the migration copies what the source has).
		for (const [revisionId, skillRunId] of [
			[readable.revision.id, knownRun],
			[closed.revision.id, unknownRun],
		] as const) {
			await db
				.update(osOutputRevisions)
				.set({ accessEnvelope: null, skillRunId, createdByKind: "tedi" })
				.where(eq(osOutputRevisions.id, revisionId));
			await db
				.update(workspaceOutputIndex)
				.set({
					accessEnvelope: null,
					skillRunId,
					revisionCreatedByKind: "tedi",
				})
				.where(eq(workspaceOutputIndex.revisionId, revisionId));
		}

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

	it("persists an approved Home agent as document creator on the service hop", async () => {
		const { workspace } = await c.org1.workspaces.create({ name: "Scratch" });
		const context = apiKeyContext({ env: c.env, organizationId: "org-1" });
		context.apiKey = undefined;
		context.authType = "service-binding";
		context.headers = new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Org-Id": "org-1",
			"X-Tedix-Tedi-Scopes": "apps:write apps:read",
			"X-Tedix-Kernel": "true",
			"X-Tedix-Actor-Type": "external_agent",
			"X-Tedix-Actor-Id": "5eed0015-0000-4000-8000-000000000015",
		});
		const home = createRouterClient(osWorkspacesContractRouter, { context });
		const { output } = await home.outputs.create({
			workspaceId: workspace.id,
			kind: "document",
			title: "Welcome",
			content: {
				kind: "document",
				blocks: [{ type: "paragraph", text: "Hello" }],
			},
		});
		const saved = await c.org1.outputs.get({ outputId: output.id });
		expect(saved.output).toMatchObject({
			createdByKind: "external_agent",
			createdById: "5eed0015-0000-4000-8000-000000000015",
		});
		expect(saved.currentRevision.content).toMatchObject({
			kind: "document",
			blocks: [{ type: "paragraph", text: "Hello" }],
		});
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

		// A stale save that touched a different slide merges instead.
		const merged = await c.org1.outputs.revise({
			outputId: output.id,
			content: {
				kind: "presentation",
				slides: [{ title: "Q3 results", bullets: ["Revenue"] }],
			},
			expectedRevision: 1,
		});
		expect(merged.revision).toMatchObject({
			revision: 3,
			note: "Saved · merged with revision 2",
		});
		expect(merged.revision.content).toMatchObject({
			slides: [
				{ title: "Q3 results", bullets: ["Revenue", "Churn"] },
				{ title: "Q4 plan", bullets: [] },
			],
		});

		// The format is fixed at creation.
		await expect(
			c.org1.outputs.revise({
				outputId: output.id,
				content: { kind: "document", blocks: [] },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		const fetched = await c.org1.outputs.get({ outputId: output.id });
		expect(fetched.currentRevision.revision).toBe(3);
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
			preview: { kind: "metadata" },
		});
		expect(
			library.items.find((item) => item.output.kind === "sheet"),
		).toMatchObject({
			scope: "organization",
			preview: { kind: "metadata" },
		});
		expect(
			library.items.find((item) => item.output.kind === "presentation"),
		).toMatchObject({
			preview: { kind: "metadata" },
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
		expect(history.revisions.every((item) => !("content" in item))).toBe(true);
		const exact = await c.org1.outputs.history({
			outputId: created.output.id,
			revision: 1,
		});
		expect(exact.revisions[0]?.content).toEqual(created.revision.content);
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
		const outlineEdit = await c.org1.outputs.patchSlides({
			outputId,
			expectedRevision: 3,
			ops: [
				{
					op: "replace",
					index: 0,
					slide: {
						title: "Outline edit",
						bullets: ["Preserve artwork"],
						notes: "Speaker note",
					},
				},
			],
		});
		expect(outlineEdit.revision.content).toMatchObject({
			slides: [
				{
					title: "Outline edit",
					bullets: ["Preserve artwork"],
					notes: "Speaker note",
				},
			],
			deck: {
				slides: [
					{
						background: "linear-gradient(120deg, #123456, #abcdef)",
						backgroundImage: "https://example.org/cover.png",
						elements: expect.arrayContaining([
							expect.objectContaining({
								...element,
								props: expect.objectContaining({
									...element.props,
									title: "Changed",
								}),
							}),
						]),
					},
				],
			},
		});
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

	it("preserves untouched rich writing when an agent patches another paragraph", async () => {
		const untouched = {
			type: "paragraph",
			attrs: { textAlign: "right", indent: 2 },
			content: [
				{
					type: "text",
					text: "Keep the formatting",
					marks: [
						{ type: "bold" },
						{ type: "textStyle", attrs: { color: "#123456" } },
					],
				},
			],
		};
		const { output } = await c.org1.outputs.create({
			kind: "document",
			title: "Rich writing",
			content: {
				kind: "document",
				blocks: [],
				richText: {
					type: "doc",
					content: [
						{
							type: "paragraph",
							content: [{ type: "text", text: "Agent target" }],
						},
						untouched,
					],
				},
			},
		});
		const patched = await c.org1.outputs.patchDocument({
			outputId: output.id,
			expectedRevision: 1,
			ops: [
				{
					op: "replace",
					index: 0,
					block: { type: "paragraph", text: "Agent changed this paragraph" },
				},
			],
		});
		const content = patched.revision.content;
		if (content.kind !== "document") throw new Error("expected a document");
		expect(content.richText?.content[1]).toEqual(untouched);
		expect(content.blocks).toEqual([
			{ type: "paragraph", text: "Agent changed this paragraph" },
			{ type: "paragraph", text: "**Keep the formatting**" },
		]);
		expect(patched.revision.revision).toBe(2);
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
		// The write may extend rows only up to the 50,000-row cap.
		await expect(
			c.org1.outputs.setSheetRange({
				outputId: output.id,
				startRow: 50_000,
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

	it("rejects a moved file before rendering even when its revision is unchanged and both workspaces are readable", async () => {
		const { env, calls, puts } = exportEnv({
			pdfBytes: new Uint8Array([37, 80, 68, 70]),
		});
		const client = createRouterClient(osWorkspacesContractRouter, {
			context: userContext({ env, organizationId: "org-1" }),
		});
		const { workspace: from } = await client.workspaces.create({
			name: "Drafts",
		});
		const { workspace: to } = await client.workspaces.create({
			name: "Launch",
		});
		const { output, revision } = await client.outputs.create({
			workspaceId: from.id,
			kind: "document",
			title: "Moved brief",
			content: "Saved revision",
		});
		await client.outputs.move({ outputId: output.id, workspaceId: to.id });
		await expect(
			client.outputs.export({
				outputId: output.id,
				format: "pdf",
				expectedWorkspaceId: from.id,
				expectedRevision: revision.revision,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(calls).toHaveLength(0);
		expect(puts).toHaveLength(0);
		const exported = await client.outputs.export({
			outputId: output.id,
			format: "pdf",
			expectedWorkspaceId: to.id,
			expectedRevision: revision.revision,
		});
		expect(exported.revision).toBe(revision.revision);
		expect(calls).toHaveLength(1);
	});
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
			expectedRevision: 1,
		});
		expect(exported).toMatchObject({
			key: `os-exports/org-1/${output.id}/rev-1.pdf`,
			format: "pdf",
			revision: 1,
			sizeBytes: 4,
			url: `https://api.tedix.test/os-exports/${output.id}/rev-1.pdf`,
		});

		expect(calls).toHaveLength(1);
		await expect(
			client.outputs.export({
				outputId: output.id,
				format: "pdf",
				expectedRevision: 2,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
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
					sheets: ["a", "b"].map((id, index) => ({
						id,
						name: id,
						columns: [{ id: "v", label: "Value", width: 120 }],
						rows: [[{ input: String(index + 1), value: index + 1 }]],
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
		const tab = await client.outputs.export({
			outputId: multi.id,
			format: "csv",
			sheetId: "b",
		});
		expect(tab.url).toMatch(/rev-1-tab-2.csv$/);
		expect(new TextDecoder().decode(bodies.get(tab.key)!)).toBe(
			"Value\r\n2\r\n",
		);
		await expect(
			client.outputs.export({
				outputId: multi.id,
				format: "csv",
				sheetId: "missing",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			client.outputs.export({
				outputId: multi.id,
				format: "xlsx",
				sheetId: "b",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(puts.map((put) => put.contentType)).toEqual([
			"text/csv; charset=utf-8",
			"application/zip",
			"text/csv; charset=utf-8",
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

describe("output linked images", () => {
	const LINK = "https://example.org/visual.png";
	const BACKGROUND = "https://example.org/cover.png";
	const LOGO = "https://example.org/logo.png";
	let c: ReturnType<typeof clients>;
	let fetcher: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		c = clients();
		fetcher = vi.fn(
			async () =>
				new Response("raster", { headers: { "content-type": "image/png" } }),
		);
		vi.stubGlobal("fetch", fetcher);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	let decks = 0;
	async function deck(elements: Array<Record<string, unknown>>) {
		const { workspace } = await c.org1.workspaces.create({
			name: `Decks ${++decks}`,
		});
		const { output } = await c.org1.outputs.create({
			kind: "presentation",
			title: "Linked images",
			workspaceId: workspace.id,
			content: {
				kind: "presentation",
				slides: [{ title: "Visual", bullets: [] }],
				deck: {
					activeSlideId: "slide-1",
					slides: [
						{
							id: "slide-1",
							name: "Visual",
							backgroundImage: BACKGROUND,
							elements: elements.map((element, index) => ({
								id: `element-${index}`,
								x: 0,
								y: 0,
								width: 100,
								height: 100,
								style: {},
								...element,
							})),
						},
					],
				},
			} as never,
		});
		return { workspaceId: workspace.id, outputId: output.id };
	}

	it("embeds an image or background the saved deck links to", async () => {
		const target = await deck([{ type: "image", src: LINK }]);
		await expect(
			c.org1.outputs.image({ ...target, url: LINK }),
		).resolves.toEqual({ dataUrl: "data:image/png;base64,cmFzdGVy" });
		await expect(
			c.org1.outputs.image({ ...target, url: BACKGROUND }),
		).resolves.toEqual({ dataUrl: "data:image/png;base64,cmFzdGVy" });
		expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
			LINK,
			BACKGROUND,
		]);
	});

	it("embeds the organization logo only for a deck with a logo element", async () => {
		await c.env.DB.prepare(
			"INSERT OR REPLACE INTO organizations (id, name, logo_url) VALUES (?, ?, ?)",
		)
			.bind("org-1", "Example", LOGO)
			.run();
		const plain = await deck([{ type: "image", src: LINK }]);
		await expect(
			c.org1.outputs.image({ ...plain, url: LOGO }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		const branded = await deck([{ type: "logo" }]);
		await expect(
			c.org1.outputs.image({ ...branded, url: LOGO }),
		).resolves.toEqual({ dataUrl: "data:image/png;base64,cmFzdGVy" });
	});

	it("embeds an image a saved document links to", async () => {
		const { workspace } = await c.org1.workspaces.create({ name: "Docs" });
		const { output } = await c.org1.outputs.create({
			kind: "document",
			title: "Illustrated",
			workspaceId: workspace.id,
			content: {
				kind: "document",
				blocks: [],
				richText: {
					type: "doc",
					content: [{ type: "image", attrs: { src: LINK } }],
				},
			},
		});
		await expect(
			c.org1.outputs.image({
				workspaceId: workspace.id,
				outputId: output.id,
				url: LINK,
			}),
		).resolves.toEqual({ dataUrl: "data:image/png;base64,cmFzdGVy" });
	});

	it("refuses a link the saved file does not use, without fetching it", async () => {
		const target = await deck([{ type: "image", src: LINK }]);
		await expect(
			c.org1.outputs.image({ ...target, url: "https://example.org/other.png" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		// A text element's src is not an image source.
		const text = await deck([{ type: "text", text: "Hello", src: LINK }]);
		await expect(
			c.org1.outputs.image({ ...text, url: LINK }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("refuses links that are not https and images above 5 MB", async () => {
		const target = await deck([{ type: "image", src: LINK }]);
		await expect(
			c.org1.outputs.image({ ...target, url: "http://example.org/visual.png" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(fetcher).not.toHaveBeenCalled();
		fetcher.mockResolvedValueOnce(
			new Response("raster", {
				headers: {
					"content-type": "image/png",
					"content-length": String(5 * 1024 * 1024 + 1),
				},
			}),
		);
		await expect(
			c.org1.outputs.image({ ...target, url: LINK }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	const EMBEDDED = `data:image/png;base64,${"QUJD".repeat(800)}`;

	it("stores an embedded image with the file and reads it back by reference", async () => {
		const target = await deck([{ type: "image", src: EMBEDDED }]);
		const { currentRevision } = await c.org1.outputs.get({
			outputId: target.outputId,
		});
		const reference = (
			currentRevision.content as {
				deck: { slides: Array<{ elements: Array<{ src: string }> }> };
			}
		).deck.slides[0]!.elements[0]!.src;
		expect(reference).toMatch(/^tedix-asset:[a-f0-9]{64}$/);
		expect(JSON.stringify(currentRevision.content)).not.toContain("base64");
		await expect(
			c.org1.outputs.image({ ...target, url: reference }),
		).resolves.toEqual({ dataUrl: EMBEDDED });
		await expect(
			c.org1.outputs.image({ outputId: target.outputId, url: reference }),
		).resolves.toEqual({ dataUrl: EMBEDDED });
		// Saving the references back is the same file, not a new image.
		const saved = await c.org1.outputs.revise({
			outputId: target.outputId,
			content: currentRevision.content,
			expectedRevision: 1,
		});
		expect(saved.revision.content).toEqual(currentRevision.content);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("serves a stored image only from the file that holds it", async () => {
		const target = await deck([{ type: "image", src: EMBEDDED }]);
		const other = await deck([{ type: "text", text: "No image" }]);
		const { currentRevision } = await c.org1.outputs.get({
			outputId: target.outputId,
		});
		const reference = (
			currentRevision.content as {
				deck: { slides: Array<{ elements: Array<{ src: string }> }> };
			}
		).deck.slides[0]!.elements[0]!.src;
		await expect(
			c.org2.outputs.image({ ...target, url: reference }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			c.org1.outputs.image({ ...other, url: reference }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			c.org1.outputs.image({
				...target,
				workspaceId: other.workspaceId,
				url: reference,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		// Another file cannot take the image by naming it.
		await expect(
			c.org1.outputs.revise({
				outputId: other.outputId,
				content: currentRevision.content,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("removes a file's images when the file is deleted for good", async () => {
		const target = await deck([{ type: "image", src: EMBEDDED }]);
		const kept = await deck([{ type: "image", src: EMBEDDED }]);
		const { reference } = await c.org1.outputs.uploadImage({
			...target,
			dataUrl: EMBEDDED,
		});
		const { deleteOutputAssets } =
			await import("../../services/os-output-assets");
		await c.org1.outputs.archive({ outputId: target.outputId });
		await c.org1.outputs.delete({ outputId: target.outputId });
		// Nothing is left under the deleted file; the other file keeps its copy.
		expect(
			await deleteOutputAssets({
				organizationId: "org-1",
				outputId: target.outputId,
			}),
		).toBe(0);
		await expect(
			c.org1.outputs.image({ ...kept, url: reference }),
		).resolves.toEqual({ dataUrl: EMBEDDED });
	});

	it("uploads an image for a later save to name", async () => {
		const target = await deck([{ type: "text", text: "Soon a picture" }]);
		const { reference } = await c.org1.outputs.uploadImage({
			...target,
			dataUrl: EMBEDDED,
		});
		expect(reference).toMatch(/^tedix-asset:[a-f0-9]{64}$/);
		await expect(
			c.org1.outputs.uploadImage({ ...target, dataUrl: EMBEDDED }),
		).resolves.toEqual({ reference });
		await expect(
			c.org1.outputs.image({ ...target, url: reference }),
		).resolves.toEqual({ dataUrl: EMBEDDED });
		await expect(
			c.org2.outputs.uploadImage({ ...target, dataUrl: EMBEDDED }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			c.org1.outputs.uploadImage({
				...target,
				dataUrl: "data:image/svg+xml,<svg><script>1</script></svg>",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		const { output: sheet } = await c.org1.outputs.create({
			kind: "sheet",
			title: "Numbers",
			workspaceId: target.workspaceId,
		});
		await expect(
			c.org1.outputs.uploadImage({ outputId: sheet.id, dataUrl: EMBEDDED }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("gives no image to a caller who cannot read the file", async () => {
		const target = await deck([{ type: "image", src: LINK }]);
		await expect(
			c.org2.outputs.image({ ...target, url: LINK }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		const { workspace: other } = await c.org1.workspaces.create({
			name: "Elsewhere",
		});
		await expect(
			c.org1.outputs.image({ ...target, workspaceId: other.id, url: LINK }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(fetcher).not.toHaveBeenCalled();
	});
});

describe("changed-only saves (outputs.patch and outputs.changes)", () => {
	let c: ReturnType<typeof clients>;
	beforeEach(() => {
		c = clients();
	});

	const element = (id: string, text: string) => ({
		id,
		type: "text" as const,
		x: 0,
		y: 0,
		width: 200,
		height: 60,
		text,
	});
	const slide = (id: string, ...ids: string[]) => ({
		id,
		name: id,
		layout: "blank" as const,
		background: "#ffffff",
		elements: ids.map((item) => element(item, item.toUpperCase())),
	});
	async function deck() {
		const { output } = await c.org1.outputs.create({
			kind: "presentation",
			title: "Board deck",
			content: {
				kind: "presentation",
				slides: [],
				deck: {
					width: 1200,
					height: 675,
					activeSlideId: "s1",
					slides: [slide("s1", "a", "b"), slide("s2", "c")],
				},
			},
		});
		return output;
	}
	const text = (slideId: string, elementId: string, value: string) => ({
		kind: "presentation" as const,
		ops: [
			{
				op: "set" as const,
				path: [
					"deck",
					"slides",
					{ id: slideId },
					"elements",
					{ id: elementId },
					"text",
				],
				value,
			},
		],
	});
	const texts = async (outputId: string) => {
		const { currentRevision } = await c.org1.outputs.get({ outputId });
		const content = currentRevision.content;
		if (content.kind !== "presentation") throw new Error("not a deck");
		return content.deck!.slides.flatMap((row) =>
			row.elements.map((item) => item.text),
		);
	};

	it("stores a whole new revision from only the changed part and returns no content", async () => {
		const output = await deck();
		const saved = await c.org1.outputs.patch({
			outputId: output.id,
			baseRevision: 1,
			patch: text("s1", "a", "Edited"),
			note: "typed",
		});
		expect(saved).toMatchObject({
			revision: { revision: 2 },
			mergedWith: null,
			catchUp: null,
		});
		expect(saved.output.currentRevisionId).toBe(saved.revision.id);
		expect(Object.keys(saved.revision).sort()).toEqual([
			"createdAt",
			"id",
			"revision",
		]);
		expect(await texts(output.id)).toEqual(["Edited", "B", "C"]);
		// The slide outline next to the canvas follows it, and history keeps
		// every version whole.
		const history = await c.org1.outputs.history({
			outputId: output.id,
			revision: 1,
		});
		expect(history.revisions[0]?.content).toMatchObject({
			deck: { slides: [{ elements: [{ text: "A" }, { text: "B" }] }, {}] },
		});
		const stored = await createDbClient(c.env.DB)
			.select()
			.from(osOutputRevisions)
			.where(eq(osOutputRevisions.outputId, output.id));
		expect(stored.map((row) => [row.revision, row.note])).toEqual([
			[1, null],
			[2, "typed"],
		]);
	});

	it("lets two people's changes to different parts both land from the same base, and tells each what they lack", async () => {
		const output = await deck();
		const first = await c.org1.outputs.patch({
			outputId: output.id,
			baseRevision: 1,
			patch: text("s1", "a", "First"),
		});
		// The second person still edits revision 1: another element of the
		// same slide. No conflict.
		const second = await c.org1.outputs.patch({
			outputId: output.id,
			baseRevision: 1,
			patch: text("s1", "b", "Second"),
		});
		expect(second.revision.revision).toBe(3);
		expect(second.mergedWith).toBe(first.revision.revision);
		expect(await texts(output.id)).toEqual(["First", "Second", "C"]);
		// What the second person lacks is the first person's change, no more.
		expect(second.catchUp).toEqual(text("s1", "a", "First"));
		// A third, on another slide, from the oldest base.
		const third = await c.org1.outputs.patch({
			outputId: output.id,
			baseRevision: 1,
			patch: text("s2", "c", "Third"),
		});
		expect(third.revision.revision).toBe(4);
		expect(await texts(output.id)).toEqual(["First", "Second", "Third"]);
		const rows = await createDbClient(c.env.DB)
			.select()
			.from(osOutputRevisions)
			.where(eq(osOutputRevisions.outputId, output.id));
		expect(rows.find((row) => row.revision === 3)?.note).toBe(
			"Saved · merged with revision 2",
		);
	});

	it("refuses a change to a part someone else changed since the base, names the part and stores nothing", async () => {
		const output = await deck();
		await c.org1.outputs.patch({
			outputId: output.id,
			baseRevision: 1,
			patch: text("s1", "a", "Theirs"),
		});
		await expect(
			c.org1.outputs.patch({
				outputId: output.id,
				baseRevision: 1,
				patch: text("s1", "a", "Mine"),
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: {
				expectedRevision: 1,
				currentRevision: 2,
				parts: ["/deck/slides/s1/elements/a/text"],
			},
		});
		expect(await texts(output.id)).toEqual(["Theirs", "B", "C"]);
		expect(
			(await c.org1.outputs.get({ outputId: output.id })).currentRevision
				.revision,
		).toBe(2);
		// The same change from the current revision is an ordinary save.
		await c.org1.outputs.patch({
			outputId: output.id,
			baseRevision: 2,
			patch: text("s1", "a", "Mine"),
		});
		expect(await texts(output.id)).toEqual(["Mine", "B", "C"]);
	});

	it("keeps two people's changes to different words of one paragraph and refuses the same word", async () => {
		const paragraph = (value: string) => ({
			type: "paragraph",
			content: [{ type: "text", text: value }],
		});
		const { output } = await c.org1.outputs.create({
			kind: "document",
			title: "Launch note",
			content: {
				kind: "document",
				blocks: [],
				richText: {
					type: "doc",
					content: [paragraph("The launch is on Monday and the owner is Ada.")],
				},
			},
		});
		const rewrite = (value: string) => ({
			kind: "document" as const,
			ops: [
				{
					op: "splice" as const,
					path: ["richText", "content"],
					hunks: [{ at: 0, remove: 1, insert: [paragraph(value)] }],
				},
			],
		});
		const stored = async () => {
			const { currentRevision } = await c.org1.outputs.get({
				outputId: output.id,
			});
			const content = currentRevision.content;
			if (content.kind !== "document") throw new Error("not a document");
			return [content.richText!.content, content.blocks];
		};
		await c.org1.outputs.patch({
			outputId: output.id,
			baseRevision: 1,
			patch: rewrite("The launch is on Friday and the owner is Ada."),
		});
		// The second person still edits revision 1 and changed another word.
		const second = await c.org1.outputs.patch({
			outputId: output.id,
			baseRevision: 1,
			patch: rewrite("The launch is on Monday and the owner is Bob."),
		});
		expect(second.mergedWith).toBe(2);
		const text = "The launch is on Friday and the owner is Bob.";
		expect(await stored()).toEqual([
			[paragraph(text)],
			[{ type: "paragraph", text }],
		]);
		// A third, also from revision 1, changed a word that has changed since.
		await expect(
			c.org1.outputs.patch({
				outputId: output.id,
				baseRevision: 1,
				patch: rewrite("The launch is on Sunday and the owner is Ada."),
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect((await stored())[0]).toEqual([paragraph(text)]);
	});

	it("refuses a base that does not exist, a patch that does not fit and content the schema rejects", async () => {
		const output = await deck();
		await expect(
			c.org1.outputs.patch({
				outputId: output.id,
				baseRevision: 9,
				patch: text("s1", "a", "Early"),
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { expectedRevision: 9, currentRevision: 1 },
		});
		await expect(
			c.org1.outputs.patch({
				outputId: output.id,
				baseRevision: 1,
				patch: text("gone", "a", "Lost"),
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("/deck/slides/gone"),
		});
		await expect(
			c.org1.outputs.patch({
				outputId: output.id,
				baseRevision: 1,
				patch: {
					kind: "presentation",
					ops: [
						{
							op: "set",
							path: ["deck", "slides", { id: "s1" }, "name"],
							value: "",
						},
					],
				},
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("does not fit this file"),
		});
		await expect(
			c.org1.outputs.patch({
				outputId: output.id,
				baseRevision: 1,
				patch: {
					kind: "sheet",
					ops: [{ op: "set", path: ["columns"], value: [] }],
				},
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(
			(await c.org1.outputs.get({ outputId: output.id })).currentRevision
				.revision,
		).toBe(1);
	});

	it("keeps another organization out and refuses a file that moved", async () => {
		const output = await deck();
		await expect(
			c.org2.outputs.patch({
				outputId: output.id,
				baseRevision: 1,
				patch: text("s1", "a", "Intruder"),
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			c.org2.outputs.changes({ outputId: output.id, sinceRevision: 1 }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			c.org1.outputs.patch({
				outputId: output.id,
				baseRevision: 1,
				expectedWorkspaceId: "99999999-9999-4999-8999-999999999999",
				patch: text("s1", "a", "Elsewhere"),
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(await texts(output.id)).toEqual(["A", "B", "C"]);
	});

	it("answers what changed since a revision with a patch, not the file", async () => {
		const output = await deck();
		expect(
			await c.org1.outputs.changes({ outputId: output.id, sinceRevision: 1 }),
		).toMatchObject({ revision: { revision: 1 }, patch: null });
		await c.org1.outputs.patch({
			outputId: output.id,
			baseRevision: 1,
			patch: text("s1", "a", "One"),
		});
		const saved = await c.org1.outputs.patch({
			outputId: output.id,
			baseRevision: 2,
			patch: text("s2", "c", "Two"),
		});
		const changes = await c.org1.outputs.changes({
			outputId: output.id,
			sinceRevision: 1,
		});
		// It also says who saved it, so an editor can offer to undo an agent.
		expect(changes.revision).toMatchObject({
			id: saved.revision.id,
			revision: 3,
			createdByKind: "user",
		});
		expect(changes.content).toBeUndefined();
		expect(changes.patch).toEqual({
			kind: "presentation",
			ops: [...text("s1", "a", "One").ops, ...text("s2", "c", "Two").ops],
		});
		expect(
			(await c.org1.outputs.changes({ outputId: output.id, sinceRevision: 2 }))
				.patch,
		).toEqual(text("s2", "c", "Two"));
		// A revision that was never stored cannot be compared: whole content.
		const unknown = await c.org1.outputs.changes({
			outputId: output.id,
			sinceRevision: 3,
		});
		expect(unknown.patch).toBeNull();
	});

	it("records one activity and one audit entry per burst of auto-saves, and a new one for anything else", async () => {
		const output = await deck();
		const db = createDbClient(c.env.DB);
		const rows = async () => ({
			revisions: (
				await db
					.select()
					.from(osOutputRevisions)
					.where(eq(osOutputRevisions.outputId, output.id))
			).length,
			feed: (
				await db
					.select()
					.from(workspaceFeedLedger)
					.where(eq(workspaceFeedLedger.entityId, output.id))
			).length,
			activity: (
				await db
					.select()
					.from(workspaceActivity)
					.where(eq(workspaceActivity.entityId, output.id))
			).length,
			audit: (
				await db
					.select()
					.from(auditEvents)
					.where(eq(auditEvents.resourceId, output.id))
			).length,
		});
		let revision = 1;
		const save = async (
			client: typeof c.org1,
			value: string,
			options: { autosave?: boolean; note?: string } = { autosave: true },
		) => {
			const saved = await client.outputs.patch({
				outputId: output.id,
				baseRevision: revision,
				patch: text("s1", "a", value),
				...options,
			});
			revision = saved.revision.revision;
			return saved.continuesBurst;
		};
		const before = await rows();
		// The first auto-save starts a burst: one entry of each kind.
		expect(await save(c.org1, "t")).toBe(false);
		expect(await rows()).toEqual({
			revisions: before.revisions + 1,
			feed: before.feed + 1,
			activity: before.activity + 1,
			audit: before.audit + 1,
		});
		// The auto-saves that follow write one row each: the revision.
		for (const value of ["ty", "typ", "type", "typed"])
			expect(await save(c.org1, value)).toBe(true);
		expect(await rows()).toEqual({
			revisions: before.revisions + 5,
			feed: before.feed + 1,
			activity: before.activity + 1,
			audit: before.audit + 1,
		});
		const stored = await db
			.select()
			.from(osOutputRevisions)
			.where(eq(osOutputRevisions.outputId, output.id));
		expect(stored.at(-1)?.note).toBe("Saved automatically");
		// A save someone asked for is an entry of its own, with its own note.
		expect(
			await save(c.org1, "asked", { note: "Saved from workspace app" }),
		).toBe(false);
		// An auto-save after it starts a new burst, and so does another writer.
		expect(await save(c.org1, "again")).toBe(false);
		expect(await save(c.org1, "again!")).toBe(true);
		expect(await save(c.machine, "machine")).toBe(false);
		expect(await save(c.org1, "back")).toBe(false);
		expect(await rows()).toMatchObject({
			revisions: before.revisions + 10,
			feed: before.feed + 5,
			audit: before.audit + 5,
		});
		// A pause of more than a few minutes ends a burst.
		await db
			.update(osOutputRevisions)
			.set({ createdAt: new Date(Date.now() - 10 * 60_000).toISOString() })
			.where(eq(osOutputRevisions.outputId, output.id));
		expect(await save(c.org1, "later")).toBe(false);
	});

	it("copes with a thinned history: gaps in the numbers, whole content when the base is gone, numbers never reused", async () => {
		const output = await deck();
		for (const [index, value] of ["one", "two", "three"].entries())
			await c.org1.outputs.patch({
				outputId: output.id,
				baseRevision: index + 1,
				patch: text("s1", "a", value),
				autosave: true,
			});
		const db = createDbClient(c.env.DB);
		// Revisions 2 and 3 are thinned away; 1 and 4 remain.
		for (const revision of [2, 3])
			await db
				.delete(osOutputRevisions)
				.where(
					and(
						eq(osOutputRevisions.outputId, output.id),
						eq(osOutputRevisions.revision, revision),
					),
				);
		const history = await c.org1.outputs.history({ outputId: output.id });
		expect(history.revisions.map((row) => row.revision)).toEqual([4, 1]);
		// A viewer still holding revision 2 gets the whole current content.
		const changes = await c.org1.outputs.changes({
			outputId: output.id,
			sinceRevision: 2,
		});
		expect(changes).toMatchObject({ revision: { revision: 4 }, patch: null });
		expect(changes.content).toMatchObject({
			deck: { slides: [{ elements: [{ text: "three" }, {}] }, {}] },
		});
		// An edit made from the thinned revision is not applied blindly.
		await expect(
			c.org1.outputs.patch({
				outputId: output.id,
				baseRevision: 2,
				patch: text("s2", "c", "late"),
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { expectedRevision: 2, currentRevision: 4 },
		});
		// The next save takes the next number after the newest, never a gap.
		const next = await c.org1.outputs.patch({
			outputId: output.id,
			baseRevision: 4,
			patch: text("s2", "c", "late"),
		});
		expect(next.revision.revision).toBe(5);
		expect(await texts(output.id)).toEqual(["three", "B", "late"]);
	});

	it("patches a sheet cell by coordinates and a document block by position, rebuilding the plain copies", async () => {
		const sheet = await c.org1.outputs.create({
			kind: "sheet",
			title: "Budget",
			content: {
				kind: "sheet",
				columns: ["A", "B"],
				rows: [
					[1, 2],
					[3, 4],
				],
				workbook: {
					activeSheetId: "one",
					sheets: [
						{
							id: "one",
							name: "One",
							columns: [
								{ id: "a", label: "A" },
								{ id: "b", label: "B" },
							],
							rows: [
								[
									{ input: "1", value: 1 },
									{ input: "2", value: 2 },
								],
								[
									{ input: "3", value: 3 },
									{ input: "4", value: 4 },
								],
							],
						},
					],
				},
			},
		});
		const cell = (row: number, column: number, value: number) => ({
			kind: "sheet" as const,
			ops: [
				{
					op: "set" as const,
					path: ["workbook", "sheets", { id: "one" }, "rows", row, column],
					value: { input: String(value), value },
				},
			],
		});
		await c.org1.outputs.patch({
			outputId: sheet.output.id,
			baseRevision: 1,
			patch: cell(0, 1, 20),
		});
		// A different cell from the same base lands as well.
		await c.org1.outputs.patch({
			outputId: sheet.output.id,
			baseRevision: 1,
			patch: cell(1, 0, 30),
		});
		expect(
			(await c.org1.outputs.get({ outputId: sheet.output.id })).currentRevision
				.content,
		).toMatchObject({
			rows: [
				[1, 20],
				[30, 4],
			],
		});
		await expect(
			c.org1.outputs.patch({
				outputId: sheet.output.id,
				baseRevision: 1,
				patch: cell(0, 1, 99),
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { parts: ["/workbook/sheets/one/rows/0/1/input"] },
		});

		// A document written as plain blocks gains its rich body the way the
		// editor sees it, so the editor's first patch fits.
		const doc = await c.org1.outputs.create({
			kind: "document",
			title: "Notes",
			content: {
				kind: "document",
				blocks: [
					{ type: "paragraph", text: "One" },
					{ type: "paragraph", text: "Two" },
					{ type: "paragraph", text: "Three" },
				],
			},
		});
		const paragraph = (value: string) => ({
			type: "paragraph",
			content: [{ type: "text", text: value }],
		});
		const block = (at: number, value: string) => ({
			kind: "document" as const,
			ops: [
				{
					op: "splice" as const,
					path: ["richText", "content"],
					hunks: [{ at, remove: 1, insert: [paragraph(value)] }],
				},
			],
		});
		await c.org1.outputs.patch({
			outputId: doc.output.id,
			baseRevision: 1,
			patch: block(0, "First"),
		});
		await c.org1.outputs.patch({
			outputId: doc.output.id,
			baseRevision: 1,
			patch: block(2, "Third"),
		});
		const saved = (await c.org1.outputs.get({ outputId: doc.output.id }))
			.currentRevision.content;
		expect(saved).toMatchObject({
			blocks: [
				{ type: "paragraph", text: "First" },
				{ type: "paragraph", text: "Two" },
				{ type: "paragraph", text: "Third" },
			],
		});
		await expect(
			c.org1.outputs.patch({
				outputId: doc.output.id,
				baseRevision: 1,
				patch: block(0, "Clash"),
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { parts: [expect.stringContaining("/richText/content/0")] },
		});
	});
});
