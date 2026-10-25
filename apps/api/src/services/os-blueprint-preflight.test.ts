import { COGNITION_MODEL_CATALOG } from "@tedix/api-contract/schemas/model-catalog";
import type {
	OsBlueprintDefinition,
	OsBlueprintRequirements,
	OsBlueprintResourceBinding,
} from "@tedix/api-contract/schemas/os-workspaces";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// An in-memory, organization-keyed world stands in for the D1 reads, so each
// lookup can only see rows of the organization it is asked about.
const world = vi.hoisted(() => ({
	skills: new Map<string, Record<string, unknown>>(),
	policies: new Map<string, Record<string, unknown>>(),
	tedis: new Map<string, Record<string, unknown>>(),
	profiles: new Map<string, Record<string, unknown>>(),
	// key: `${org}|${owner ?? "-"}|${provider}` → availability
	connections: new Map<string, Record<string, unknown>>(),
	connectionCalls: [] as Record<string, unknown>[],
}));
vi.mock("@tedix/db/queries/cognitive/skill-crud", () => ({
	getSkillEntryBySlug: async (_db: unknown, org: string, slug: string) =>
		world.skills.get(`${org}|${slug}`) ?? null,
}));
vi.mock("@tedix/db/queries/control-plane/definitions", () => ({
	getPolicyPackBySlugForOrganization: async (
		_db: unknown,
		org: string,
		ref: { scope: string; slug: string },
	) => world.policies.get(`${org}|${ref.scope}|${ref.slug}`) ?? null,
	getRuntimeProfileById: async (_db: unknown, id: string) =>
		world.profiles.get(id) ?? null,
}));
vi.mock("@tedix/db/queries/tedis", () => ({
	getTediBySlug: async (_db: unknown, org: string, slug: string) =>
		[...world.tedis.values()].find(
			(tedi) => tedi.organizationId === org && tedi.slug === slug,
		) ?? null,
	getTediById: async (_db: unknown, id: string) => world.tedis.get(id) ?? null,
}));
vi.mock("./connection-availability", () => ({
	resolveConnectionAvailability: async (input: {
		organizationId: string;
		ownerUserId: string | null;
		providerId: string;
		tokenScope: string;
	}) => {
		world.connectionCalls.push(input);
		const tenant = world.connections.get(
			`${input.organizationId}|-|${input.providerId}`,
		);
		const user = input.ownerUserId
			? world.connections.get(
					`${input.organizationId}|${input.ownerUserId}|${input.providerId}`,
				)
			: undefined;
		const found =
			(input.tokenScope !== "user" && tenant) ||
			(input.tokenScope !== "tenant" && user);
		return (
			found || {
				connected: false,
				cause: "no_token",
				reason: `no active ${input.tokenScope} connection satisfies the requested scopes`,
			}
		);
	},
}));

import { resolveOsBlueprintPreflight } from "./os-blueprint-preflight";

const ORG = "org-fictional";
const OTHER_ORG = "org-elsewhere";
const NOW = "2026-10-25T12:00:00.000Z";
const WORKFLOW = "export default async function run() {}";
const SKILL_ID = "skill-digest";
const economy = COGNITION_MODEL_CATALOG.find(
	(entry) => entry.tier === "economy" && !entry.reasoning,
)!;
const frontier = COGNITION_MODEL_CATALOG.find(
	(entry) => entry.tier === "frontier" && entry.reasoning,
)!;

function requirements(
	overrides: Partial<OsBlueprintRequirements> = {},
): OsBlueprintRequirements {
	return {
		version: 1,
		skills: [],
		connections: [],
		policies: [],
		runtime: null,
		layout: null,
		outputs: [],
		...overrides,
	};
}
function definition(
	reqs: OsBlueprintRequirements | null,
	gadgets = ["board", "inbox"],
): OsBlueprintDefinition {
	return {
		gadgets: gadgets.map((name) => ({ name, manifest: {} })),
		requirements: reqs,
	} as unknown as OsBlueprintDefinition;
}
function preflight(
	reqs: OsBlueprintRequirements | null,
	extra: {
		organizationId?: string;
		tediId?: string | null;
		ownerUserId?: string | null;
		resourceBindings?: OsBlueprintResourceBinding[];
		gadgets?: string[];
		now?: string;
	} = {},
) {
	return resolveOsBlueprintPreflight({
		db: {} as never,
		env: {} as never,
		organizationId: extra.organizationId ?? ORG,
		blueprintId: "blueprint-1",
		revisionId: "revision-1",
		revision: 3,
		definition: definition(reqs, extra.gadgets),
		tediId: extra.tediId,
		ownerUserId: extra.ownerUserId,
		resourceBindings: extra.resourceBindings,
		now: extra.now ?? NOW,
	});
}
function skillReq(slug: string, revision = 2, workflowSha256?: string) {
	return {
		role: "main",
		slug,
		skillId: slug === "digest" ? SKILL_ID : `skill-${slug}`,
		revision,
		...(workflowSha256 ? { workflowSha256 } : {}),
	} as OsBlueprintRequirements["skills"][number];
}
function tedi(id: string, fields: Record<string, unknown>) {
	world.tedis.set(id, { id, status: "active", ...fields });
}

beforeEach(() => {
	world.skills.clear();
	world.policies.clear();
	world.tedis.clear();
	world.profiles.clear();
	world.connections.clear();
	world.connectionCalls.length = 0;
});

describe("resolveOsBlueprintPreflight", () => {
	it("reports a revision without requirements as not configured and allowed", async () => {
		const result = await preflight(null, { tediId: "tedi-x" });
		expect(result).toEqual({
			blueprintId: "blueprint-1",
			revisionId: "revision-1",
			revision: 3,
			status: "not_configured",
			instantiateAllowed: true,
			targetTediId: "tedi-x",
			requirements: null,
			decisions: [],
			blockingReasons: [],
			consentReasons: [],
			configurationReasons: [],
			resolvedAt: NOW,
		});
	});

	it("is ready with an empty declaration and is deterministic for a fixed now", async () => {
		const first = await preflight(requirements());
		const second = await preflight(requirements());
		expect(first).toMatchObject({
			status: "ready",
			instantiateAllowed: true,
			decisions: [],
			resolvedAt: NOW,
		});
		expect(second).toEqual(first);
	});

	it("resolves each skill verdict and blocks instantiation on any failure", async () => {
		world.skills.set(`${ORG}|digest`, {
			id: SKILL_ID,
			revision: 2,
			lifecycleState: "active",
			files: { "scripts/workflow.ts": WORKFLOW },
		});
		world.skills.set(`${ORG}|moved`, { id: "skill-moved", revision: 5 });
		world.skills.set(`${ORG}|archived`, {
			id: "skill-archived",
			revision: 2,
			lifecycleState: "archived",
		});
		world.skills.set(`${ORG}|hijacked`, { id: "skill-other", revision: 2 });
		world.skills.set(`${OTHER_ORG}|absent`, {
			id: "skill-absent",
			revision: 2,
		});
		const digest = await sha256Hex(WORKFLOW);

		const result = await preflight(
			requirements({
				skills: [
					skillReq("digest", 2, digest),
					skillReq("moved"),
					skillReq("archived"),
					skillReq("hijacked"),
					skillReq("absent"),
				],
			}),
		);
		expect(
			result.decisions.map(({ subject, verdict }) => [subject, verdict]),
		).toEqual([
			["main:digest", "allowed"],
			["main:moved", "incompatible"],
			["main:archived", "denied"],
			["main:hijacked", "denied"],
			["main:absent", "missing"],
		]);
		expect(result.decisions[0]!.resolvedPin).toEqual({
			id: SKILL_ID,
			revision: 2,
			digest,
		});
		expect(result.status).toBe("blocked");
		expect(result.instantiateAllowed).toBe(false);
		expect(result.blockingReasons).toHaveLength(4);
		expect(result.configurationReasons).toEqual([]);
		expect(result.consentReasons).toEqual([]);
	});

	it("flags a changed or absent workflow digest as incompatible", async () => {
		world.skills.set(`${ORG}|digest`, {
			id: SKILL_ID,
			revision: 2,
			files: { "scripts/workflow.ts": `${WORKFLOW}\n// edited` },
		});
		const changed = await preflight(
			requirements({ skills: [skillReq("digest", 2, "0".repeat(64))] }),
		);
		expect(changed.decisions[0]!.verdict).toBe("incompatible");
		expect(changed.decisions[0]!.reason).toContain("digest has changed");

		world.skills.set(`${ORG}|digest`, { id: SKILL_ID, revision: 2 });
		const absent = await preflight(
			requirements({ skills: [skillReq("digest", 2, "0".repeat(64))] }),
		);
		expect(absent.decisions[0]!.reason).toContain("carries no files");
	});

	it("resolves policy packs only in the caller's organization", async () => {
		world.policies.set(`${ORG}|organization|ok`, {
			id: "pack-ok",
			version: 1,
			status: "active",
		});
		world.policies.set(`${ORG}|organization|retired`, {
			id: "pack-retired",
			version: 1,
			status: "archived",
		});
		world.policies.set(`${ORG}|organization|newer`, {
			id: "pack-newer",
			version: 2,
			status: "active",
		});
		world.policies.set(`${OTHER_ORG}|organization|theirs`, {
			id: "pack-theirs",
			version: 1,
			status: "active",
		});
		const result = await preflight(
			requirements({
				policies: ["ok", "retired", "newer", "theirs"].map((slug) => ({
					scope: "organization",
					slug,
					version: 1,
				})) as OsBlueprintRequirements["policies"],
			}),
		);
		expect(result.decisions.map(({ verdict }) => verdict)).toEqual([
			"allowed",
			"denied",
			"incompatible",
			"missing",
		]);
		expect(result.status).toBe("blocked");
	});

	it("falls back to the declared steward for the runtime check", async () => {
		tedi("tedi-steward", {
			organizationId: ORG,
			slug: "operator",
			runtimeProfileId: "profile-1",
		});
		world.profiles.set("profile-1", {
			id: "profile-1",
			slug: "standard",
			version: 4,
			status: "active",
			config: { modelPolicy: { chatModelRef: frontier.ref } },
		});
		const reqs = requirements({
			steward: { tediSlug: "operator" },
			runtime: { minTier: "balanced", requiresReasoning: true },
		} as Partial<OsBlueprintRequirements>);

		const result = await preflight(reqs);
		expect(result.targetTediId).toBe("tedi-steward");
		expect(
			result.decisions.map(({ kind, verdict }) => [kind, verdict]),
		).toEqual([
			["assignment", "allowed"],
			["model", "allowed"],
		]);
		expect(result.status).toBe("ready");

		// An explicit tediId wins over the steward.
		tedi("tedi-cheap", {
			organizationId: ORG,
			slug: "cheap",
			runtimeProfileId: "profile-cheap",
		});
		world.profiles.set("profile-cheap", {
			id: "profile-cheap",
			slug: "cheap",
			version: 1,
			status: "active",
			config: { modelPolicy: { chatModelRef: economy.ref } },
		});
		const explicit = await preflight(reqs, { tediId: "tedi-cheap" });
		expect(explicit.targetTediId).toBe("tedi-cheap");
		expect(explicit.decisions[1]).toMatchObject({
			kind: "model",
			verdict: "incompatible",
		});
		expect(explicit.status).toBe("blocked");
	});

	it("needs configuration when the steward is missing or inactive, and never borrows another organization's tedi", async () => {
		tedi("tedi-foreign", {
			organizationId: OTHER_ORG,
			slug: "operator",
			runtimeProfileId: "profile-1",
		});
		const reqs = requirements({
			steward: { tediSlug: "operator" },
			runtime: { minTier: "economy" },
		} as Partial<OsBlueprintRequirements>);

		const missing = await preflight(reqs);
		expect(missing.targetTediId).toBeNull();
		expect(
			missing.decisions.map(({ kind, verdict }) => [kind, verdict]),
		).toEqual([
			["assignment", "missing"],
			["model", "missing"],
		]);
		expect(missing.status).toBe("blocked");
		expect(missing.configurationReasons).toHaveLength(1);

		const foreign = await preflight(reqs, { tediId: "tedi-foreign" });
		expect(foreign.decisions[1]).toMatchObject({
			kind: "model",
			verdict: "denied",
			reason: "the selected tedi does not exist in this organization",
		});

		tedi("tedi-paused", {
			organizationId: ORG,
			slug: "paused",
			status: "paused",
		});
		const paused = await preflight(
			requirements({
				steward: { tediSlug: "paused" },
			} as Partial<OsBlueprintRequirements>),
		);
		expect(paused).toMatchObject({
			status: "needs_configuration",
			instantiateAllowed: false,
			targetTediId: "tedi-paused",
		});
		expect(paused.decisions[0]!.verdict).toBe("denied");
	});

	it("resolves runtime profile gaps and pins", async () => {
		tedi("tedi-1", {
			organizationId: ORG,
			slug: "one",
			runtimeProfileId: null,
		});
		const runtime = {
			modelRef: frontier.ref,
		} as OsBlueprintRequirements["runtime"];
		const noProfile = await preflight(requirements({ runtime }), {
			tediId: "tedi-1",
		});
		expect(noProfile.decisions[0]!.verdict).toBe("missing");

		tedi("tedi-1", {
			organizationId: ORG,
			slug: "one",
			runtimeProfileId: "profile-1",
		});
		world.profiles.set("profile-1", {
			id: "profile-1",
			slug: "p",
			version: 1,
			status: "active",
			config: { modelPolicy: { chatModelRef: economy.ref } },
		});
		const pinned = await preflight(requirements({ runtime }), {
			tediId: "tedi-1",
		});
		expect(pinned.decisions[0]!.verdict).toBe("incompatible");

		const none = await preflight(requirements({ runtime }));
		expect(none.decisions[0]).toMatchObject({ verdict: "missing" });
		expect(none.targetTediId).toBeNull();
	});

	it("checks layout and outputs against the revision's own gadgets", async () => {
		const ok = await preflight(
			requirements({
				layout: {
					columns: 4,
					placements: [
						{ gadget: "board", column: 1, row: 1, width: 2, height: 1 },
						{ gadget: "inbox", column: 3, row: 1, width: 2, height: 1 },
					],
				},
				outputs: [{ gadget: "board", kind: "document", title: "Weekly" }],
			} as Partial<OsBlueprintRequirements>),
		);
		expect(ok.decisions.map(({ verdict }) => verdict)).toEqual([
			"allowed",
			"allowed",
		]);
		expect(ok.status).toBe("ready");

		const bad = await preflight(
			requirements({
				layout: {
					columns: 4,
					placements: [
						{ gadget: "board", column: 1, row: 1, width: 2, height: 1 },
						{ gadget: "inbox", column: 2, row: 1, width: 1, height: 1 },
						{ gadget: "ghost", column: 1, row: 2, width: 1, height: 1 },
						{ gadget: "board", column: 4, row: 3, width: 2, height: 1 },
					],
				},
				outputs: [{ gadget: "ghost", kind: "document", title: "Orphan" }],
			} as Partial<OsBlueprintRequirements>),
		);
		expect(bad.decisions.map(({ verdict }) => verdict)).toEqual([
			"incompatible",
			"incompatible",
		]);
		expect(bad.decisions[0]!.reason).toMatch(/overlap.*ghost.*overflows/);
		expect(bad.status).toBe("blocked");
	});

	it("asks for consent when a connection is missing without blocking instantiation", async () => {
		const result = await preflight(
			requirements({
				connections: [{ providerId: "crm", tokenScope: "tenant", scopes: [] }],
			} as Partial<OsBlueprintRequirements>),
		);
		expect(result.decisions[0]).toMatchObject({
			kind: "connection",
			verdict: "consent_required",
		});
		expect(result.decisions[0]!.reason).toContain("consent is required");
		expect(result).toMatchObject({
			status: "needs_consent",
			instantiateAllowed: true,
		});
		expect(result.consentReasons).toHaveLength(1);
	});

	it("counts a user connection only for its owner and never another organization's connection", async () => {
		world.connections.set(`${ORG}|user-ada|mail`, {
			connected: true,
			cause: "connected",
			reason: "user connection is active",
		});
		world.connections.set(`${OTHER_ORG}|-|mail`, {
			connected: true,
			cause: "connected",
			reason: "tenant connection is active",
		});
		const reqs = requirements({
			connections: [{ providerId: "mail", tokenScope: "either", scopes: [] }],
		} as Partial<OsBlueprintRequirements>);

		const owner = await preflight(reqs, { ownerUserId: "user-ada" });
		expect(owner.decisions[0]!.verdict).toBe("allowed");
		expect(owner.status).toBe("ready");

		const someoneElse = await preflight(reqs, { ownerUserId: "user-grace" });
		expect(someoneElse.decisions[0]!.verdict).toBe("consent_required");

		const nobody = await preflight(reqs);
		expect(nobody.decisions[0]!.verdict).toBe("consent_required");
		expect(world.connectionCalls.at(-1)).toMatchObject({
			organizationId: ORG,
			ownerUserId: null,
		});
	});

	it("reports an unregistered provider as missing rather than a consent prompt", async () => {
		world.connections.set(`${ORG}|-|mail`, {
			connected: false,
			cause: "provider_unregistered",
			reason: "connection provider mail is not registered with Descope",
		});
		const result = await preflight(
			requirements({
				connections: [{ providerId: "mail", tokenScope: "tenant", scopes: [] }],
			} as Partial<OsBlueprintRequirements>),
		);
		expect(result.decisions[0]).toMatchObject({
			verdict: "missing",
			reason: "connection provider mail is not registered with Descope",
		});
		expect(result.consentReasons).toEqual([
			"connection provider mail is not registered with Descope",
		]);
		expect(result.status).toBe("needs_consent");
	});

	it("needs configuration for unbound or mismatched resource slots and dedupes their connection check", async () => {
		const resource = {
			slot: "repo",
			label: "repository",
			providerId: "code-host",
			resourceType: "repository",
			tokenScope: "tenant",
			scopes: ["read"],
		};
		world.connections.set(`${ORG}|-|code-host`, {
			connected: true,
			cause: "connected",
			reason: "tenant connection is active",
		});
		const reqs = requirements({
			connections: [
				{ providerId: "code-host", tokenScope: "tenant", scopes: ["read"] },
			],
			resources: [resource],
		} as Partial<OsBlueprintRequirements>);

		const unbound = await preflight(reqs);
		expect(
			unbound.decisions.map(({ kind, verdict }) => [kind, verdict]),
		).toEqual([
			["connection", "allowed"],
			["workspace_resource", "missing"],
		]);
		expect(world.connectionCalls).toHaveLength(1);
		expect(unbound).toMatchObject({
			status: "needs_configuration",
			instantiateAllowed: false,
		});

		const selection = {
			providerId: "code-host",
			resourceType: "repository",
			connectionScope: "tenant",
			requiredScopes: ["read"],
			name: "fictional/repo",
		};
		const bind = (overrides: Record<string, unknown>) =>
			[
				{ slot: "repo", selection: { ...selection, ...overrides } },
			] as unknown as OsBlueprintResourceBinding[];

		const bound = await preflight(reqs, { resourceBindings: bind({}) });
		expect(bound.decisions[1]!.verdict).toBe("allowed");
		expect(bound.status).toBe("ready");

		for (const wrong of [
			{ providerId: "other-host" },
			{ resourceType: "folder" },
			{ connectionScope: "user" },
			{ requiredScopes: [] },
		]) {
			const mismatched = await preflight(reqs, {
				resourceBindings: bind(wrong),
			});
			expect(mismatched.decisions[1]!.verdict).toBe("denied");
			expect(mismatched.status).toBe("needs_configuration");
		}
	});
});
