import * as calendarAccounts from "../../services/calendar-coordinator/credentials";
import * as namedVault from "./connections/policy-resolution";
/**
 * Tedix OS workspace-domain router: tenant binding, creator accountability,
 * revision optimistic concurrency surfacing, and the blueprint publish gate —
 * exercised end to end against a real D1 facade (`createD1Facade` rejects the
 * two Drizzle idioms that break on production D1).
 */

import {
	osGadgetCode,
	osWorkspaceResources,
	osWorkspaces,
} from "@tedix/db/schema/os-workspaces";
import { createDbQueryClient } from "@tedix/db/query-client";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
// The same digest the export path records, so a lineage assertion compares
// against the real producer rather than a hand-copied constant.
import { canonicalDigest } from "../../lib/blueprint-digest";
import { sha256Hex } from "@tedix/worker-kit/crypto";

import { clients } from "./__tests__/os-workspaces-env";

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

	it("resolves the declared steward tedi in the caller's organization and checks the model against it", async () => {
		const blueprintId = await publishPinned(
			requirements({
				skills: [],
				steward: { tediSlug: "cto" },
				runtime: {
					modelRef: null,
					minTier: "frontier",
					requiresReasoning: false,
				},
			}),
		);

		mocks.getTediBySlug.mockResolvedValue(undefined);
		const absent = await c.org1.blueprints.preflight({ blueprintId });
		expect(absent.preflight.decisions[0]).toMatchObject({
			kind: "assignment",
			subject: "steward:cto",
			verdict: "missing",
		});
		expect(absent.preflight.configurationReasons).toContain(
			"no tedi cto exists in this organization to steward the blueprint",
		);
		expect(mocks.getTediBySlug).toHaveBeenCalledWith(
			expect.anything(),
			"org-1",
			"cto",
		);

		const steward = {
			id: TEDI_ID,
			organizationId: "org-1",
			slug: "cto",
			status: "active",
			runtimeProfileId: RUNTIME_PROFILE_ID,
		};
		mocks.getTediBySlug.mockResolvedValue(steward);
		mocks.getTediById.mockResolvedValue(steward);
		mocks.getRuntimeProfileById.mockResolvedValue({
			id: RUNTIME_PROFILE_ID,
			slug: "frontier",
			status: "active",
			version: 3,
			config: { modelPolicy: { chatModelRef: "azure-openai/gpt-5.6-sol" } },
		});
		const ready = await c.org1.blueprints.preflight({ blueprintId });
		expect(ready.preflight.status).toBe("ready");
		expect(ready.preflight.targetTediId).toBe(TEDI_ID);
		expect(ready.preflight.decisions.map((d) => [d.kind, d.verdict])).toEqual([
			["assignment", "allowed"],
			["model", "allowed"],
		]);

		mocks.getTediBySlug.mockResolvedValue({ ...steward, status: "paused" });
		const paused = await c.org1.blueprints.preflight({ blueprintId });
		expect(paused.preflight.decisions[0]?.verdict).toBe("denied");
		expect(paused.preflight.status).toBe("needs_configuration");
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

	it("materializes only canonical personal calendar bindings and checks them again at install", async () => {
		mocks.getSkillEntryBySlug.mockResolvedValue(SKILL);
		mocks.resolveConnectionAvailability.mockResolvedValue({
			connected: true,
			cause: "connected",
			reason: "connected",
		});
		const instanceId = "00000000-0000-4000-8000-000000000003";
		const root = "https://www.googleapis.com/auth/calendar";
		vi.spyOn(calendarAccounts, "supportedCalendarAccounts").mockResolvedValue([
			{
				providerId: "google-drive",
				connectionInstanceId: instanceId,
				adapter: "google",
			},
		] as never);
		const listCalendars = vi
			.fn()
			.mockResolvedValue([{ id: "calendar-a", canRead: true, canWrite: true }]);
		vi.spyOn(calendarAccounts, "resolveCalendarAdapter").mockResolvedValue({
			adapter: { listCalendars },
		} as never);
		vi.spyOn(namedVault, "fetchNamedConnection").mockResolvedValue({
			id: "grant",
			tokenSub: "subject",
			scopes: [root],
			accessToken: "secret",
		});
		const blueprintId = await publishPinned(
			requirements({
				resources: [
					{
						slot: "calendar",
						providerId: "google-drive",
						tokenScope: "user",
						scopes: [`${root}.events`, `${root}.calendarlist.readonly`],
						resourceType: "calendar",
						label: "Calendar",
					},
				],
			}),
			"Personal Calendar Pod",
		);
		const resourceBindings = [
			{
				slot: "calendar",
				selection: {
					providerId: "google-drive",
					connectionScope: "user" as const,
					connectionInstanceId: instanceId,
					resourceType: "calendar",
					providerResourceId: "calendar-a",
					name: "Calendar",
					requiredScopes: [],
					metadata: {},
				},
			},
		];
		const result = await c.org1.blueprints.instantiate({
			blueprintId,
			workspaceName: "Personal calendar workspace",
			resourceBindings,
		});
		expect(result.resources[0]).toMatchObject({
			personalOwnerUserId: "user-1",
			connectionInstanceId: instanceId,
			providerAccess: { canRead: true, canWrite: true },
			requiredScopes: [root],
		});
		const listed = await c.org1.resources.list({
			workspaceId: result.workspace.id,
		});
		expect(listed.items[0]).toMatchObject({
			personalOwnerUserId: "user-1",
			connectionInstanceId: instanceId,
			providerAccess: { canRead: true, canWrite: true },
		});
		listCalendars.mockResolvedValue([]);
		await expect(
			c.org1.blueprints.preflight({ blueprintId, resourceBindings }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			c.org1.blueprints.instantiate({
				blueprintId,
				workspaceName: "Invalid",
				resourceBindings,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		vi.mocked(namedVault.fetchNamedConnection).mockRestore();
		vi.mocked(calendarAccounts.resolveCalendarAdapter).mockRestore();
		vi.mocked(calendarAccounts.supportedCalendarAccounts).mockRestore();
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
			featured: false,
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

describe("save workspace as blueprint", () => {
	it("freezes committed runtime files and installs independent apps without workspace data", async () => {
		mocks.resolveConnectionAvailability.mockResolvedValue({
			connected: false,
			cause: "no_token",
			missingScopes: [],
		});
		const c = clients();
		const { workspace } = await c.org1.workspaces.create({ name: "Research" });
		await c.org1.outputs.create({
			workspaceId: workspace.id,
			kind: "document",
			title: "Private document",
			content: {
				kind: "document",
				blocks: [
					{ type: "paragraph", text: "Fictional private document body" },
				],
			},
		});
		const { gadget } = await c.org1.gadgets.create({
			workspaceId: workspace.id,
			name: "Counter",
		});
		const manifest = {
			entry: "tedix:runtime/v1",
			config: { version: 1 },
			capabilities: [],
			resourceGrants: [{ slot: "source", operations: ["outputs.read"] }],
		};
		const files = {
			"server.js":
				"import { DurableObject } from 'cloudflare:workers'; export class App extends DurableObject { count() { const n = (this.ctx.storage.kv.get('n') ?? 0) + 1; this.ctx.storage.kv.put('n', n); return n; } }",
			"client.js": "document.body.textContent = 'Counter';",
			"help.txt": "Counter help",
		};
		const { revision: current } = await c.org1.gadgets.revise({
			workspaceId: workspace.id,
			gadgetId: gadget.id,
			manifest,
			files,
		});
		const db = createDbQueryClient(c.env.DB);
		await db.insert(osWorkspaceResources).values({
			id: crypto.randomUUID(),
			organizationId: "org-1",
			workspaceId: workspace.id,
			slot: "source",
			providerId: "tedix",
			connectionScope: "tenant",
			resourceType: "output",
			providerResourceId: "private-output-id",
			name: "Private source title",
			requiredScopes: '["outputs:read"]',
			metadata: '{"private":"data"}',
			createdByKind: "user",
			createdById: "user-1",
		});
		const saved = await c.org1.blueprints.saveWorkspace({
			workspaceId: workspace.id,
			name: "Counter kit",
		});
		expect(saved.blueprint).toMatchObject({
			status: "draft",
			visibility: "org",
			currentRevisionId: saved.revision.id,
		});
		expect(saved.revision.definition.gadgets).toEqual([
			{ name: "Counter", manifest, files },
		]);
		expect(saved.revision.definition.requirements?.resources).toEqual([
			{
				slot: "source",
				providerId: "tedix",
				tokenScope: "tenant",
				scopes: ["outputs:read"],
				resourceType: "output",
				label: "source",
			},
		]);
		const serialized = JSON.stringify(saved.revision.definition);
		for (const excluded of [
			"private-output-id",
			"Fictional private document body",
			"Private source title",
			"private",
			workspace.id,
			gadget.id,
			current.id,
		])
			expect(serialized).not.toContain(excluded);
		await c.org1.gadgets.revise({
			workspaceId: workspace.id,
			gadgetId: gadget.id,
			manifest,
			files: {
				...files,
				"client.js": "document.body.textContent = 'changed after snapshot';",
			},
		});
		await c.org1.blueprints.publish({ blueprintId: saved.blueprint.id });
		await expect(
			c.org1.blueprints.instantiate({
				blueprintId: saved.blueprint.id,
				workspaceName: "Unbound copy",
			}),
		).rejects.toMatchObject({ code: "UNPROCESSABLE_CONTENT" });
		const bindings = (providerResourceId: string) => [
			{
				slot: "source",
				selection: {
					providerId: "tedix",
					connectionScope: "tenant" as const,
					resourceType: "output",
					providerResourceId,
					name: "Selected source",
					requiredScopes: ["outputs:read"],
				},
			},
		];
		const first = await c.org1.blueprints.instantiate({
			blueprintId: saved.blueprint.id,
			workspaceName: "First copy",
			resourceBindings: bindings("first-selected-output"),
		});
		const second = await c.org1.blueprints.instantiate({
			blueprintId: saved.blueprint.id,
			workspaceName: "Second copy",
			resourceBindings: bindings("second-selected-output"),
		});
		const ids = [
			gadget.id,
			first.gadgets[0].gadget.id,
			second.gadgets[0].gadget.id,
		];
		expect(new Set(ids).size).toBe(3);
		for (const copy of [first, second]) {
			const app = copy.gadgets[0].gadget;
			const code = await c.org1.gadgets.getCode({
				workspaceId: copy.workspace.id,
				gadgetId: app.id,
			});
			expect(code.code?.files).toEqual(files);
			expect(code.code?.revisionId).toBe(app.currentRevisionId);
			expect(copy.resources).toHaveLength(1);
			expect(copy.resources[0].providerResourceId).toBe(
				copy === first ? "first-selected-output" : "second-selected-output",
			);
			expect(
				(await c.org1.outputs.list({ workspaceId: copy.workspace.id })).items,
			).toEqual([]);
		}
		await c.org1.gadgets.revise({
			workspaceId: first.workspace.id,
			gadgetId: first.gadgets[0].gadget.id,
			manifest,
			files: {
				...files,
				"client.js": "document.body.textContent = 'first copy only';",
			},
		});
		expect(
			(
				await c.org1.gadgets.getCode({
					workspaceId: second.workspace.id,
					gadgetId: second.gadgets[0].gadget.id,
				})
			).code?.files,
		).toEqual(files);
		await expect(
			c.org1.blueprints.saveWorkspace({
				workspaceId: workspace.id,
				name: "Counter kit",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect((await c.org1.blueprints.list({})).items).toHaveLength(1);
		await expect(
			c.org2.blueprints.saveWorkspace({
				workspaceId: workspace.id,
				name: "Stolen",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("refuses missing committed runtime code without leaving a blueprint", async () => {
		const c = clients();
		const { workspace } = await c.org1.workspaces.create({
			name: "Broken source",
		});
		const { gadget } = await c.org1.gadgets.create({
			workspaceId: workspace.id,
			name: "Uncommitted",
		});
		await expect(
			c.org1.blueprints.saveWorkspace({
				workspaceId: workspace.id,
				name: "Missing",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		const { revision } = await c.org1.gadgets.revise({
			workspaceId: workspace.id,
			gadgetId: gadget.id,
			manifest: { entry: "tedix:runtime/v1", config: { version: 1 } },
			files: { "server.js": "export class App {}", "client.js": "" },
		});
		await createDbQueryClient(c.env.DB)
			.delete(osGadgetCode)
			.where(eq(osGadgetCode.revisionId, revision.id));
		await expect(
			c.org1.blueprints.saveWorkspace({
				workspaceId: workspace.id,
				name: "Missing",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect((await c.org1.blueprints.list({})).items).toEqual([]);
	});
});

describe("workspace blueprint requirements", () => {
	it("retains pinned requirements and unbound shapes from the workspace's source revision", async () => {
		const c = clients();
		const { blueprint } = await c.org1.blueprints.create({
			name: "Pinned source",
		});
		const { revision } = await c.org1.blueprints.revise({
			blueprintId: blueprint.id,
			definition: {
				gadgets: [],
				requirements: {
					version: 1,
					connections: [
						{
							providerId: "fictional-provider",
							tokenScope: "tenant",
							scopes: ["read"],
						},
					],
					resources: [
						{
							slot: "sheet",
							providerId: "fictional-provider",
							resourceType: "sheet",
							tokenScope: "tenant",
							scopes: ["read"],
							label: "Source sheet",
						},
					],
					skills: [],
					policies: [],
					runtime: null,
					layout: null,
					outputs: [],
				},
			},
		});
		const { workspace } = await c.org1.workspaces.create({
			name: "Unbound workspace",
		});
		await createDbQueryClient(c.env.DB)
			.update(osWorkspaces)
			.set({
				sourceBlueprintId: blueprint.id,
				sourceBlueprintRevisionId: revision.id,
				sourceBlueprintRevisionNumber: 1,
			})
			.where(eq(osWorkspaces.id, workspace.id));
		const saved = await c.org1.blueprints.saveWorkspace({
			workspaceId: workspace.id,
			name: "Saved pins",
		});
		expect(saved.revision.definition.requirements).toEqual(
			revision.definition.requirements,
		);
	});
});
