/**
 * Tedix OS workspace-domain router: tenant binding, creator accountability,
 * revision optimistic concurrency surfacing, and the blueprint publish gate —
 * exercised end to end against a real D1 facade (`createD1Facade` rejects the
 * two Drizzle idioms that break on production D1).
 */

import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { recordRunArtifact } from "@tedix/db/queries/skill-run-artifacts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
// The same digest the export path records, so a lineage assertion compares
// against the real producer rather than a hand-copied constant.
import {
	failOsGadgetApprovalDispatch,
	settleOsGadgetApproval,
} from "../../services/os-gadget-approval-settlement";
import { osWorkspacesContractRouter } from "./os-workspaces";

import { createEnv, userContext } from "./__tests__/os-workspaces-env";

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
		const context = userContext({ env, organizationId: "org-1" });
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
				connectionInstanceId: "00000000-0000-4000-8000-000000000004",
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
			userContext({ env, organizationId: "org-1" }),
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
			userContext({ env, organizationId: "org-1" }),
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
				userContext({ env, organizationId: "org-1" }),
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
		const context = userContext({ env, organizationId: "org-1" });
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
