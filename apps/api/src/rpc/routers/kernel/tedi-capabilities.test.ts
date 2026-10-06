/**
 * Tedi Capability Card tests.
 *
 * Pins the card shape + fail-safe defaults:
 *   - requiresApproval defaults TRUE unless a governance flag opts out
 *   - a failed per-tedi enrichment / batch read degrades to the thin card
 *     (empty arrays, requiresApproval true) rather than throwing the whole
 *     assembly
 *   - availability + scope-group coarsening derivations
 *
 * `getTediCapabilityCards` runs against a minimal chainable Drizzle stub so the
 * bounded read path (tedis, apps, skill_entries, policy_packs) + grouping can be
 * exercised without a real D1 instance.
 */

import type { DbClient } from "@tedix/db/client";
import type { App } from "@tedix/db/schema/apps";
import { describe, expect, it } from "vite-plus/test";
import { decideDelegationDispatch } from "./delegation-dispatch";
import type { KernelRouteDecision } from "./route-schema";
import {
	deriveAvailability,
	deriveEmbodiedCapability,
	deriveRequiresApproval,
	deriveScopeGroups,
	getTediCapabilityCards,
	hasWorkstationCapability,
	isKernelVisibleTedi,
	readOrgDispatchPolicyLayer,
	type TediCapabilityCard,
} from "./tedi-capabilities";

// ---------------------------------------------------------------------------
// Pure derivations
// ---------------------------------------------------------------------------

describe("deriveAvailability", () => {
	it("maps archived runtimeState and error status to archived", () => {
		expect(deriveAvailability({ runtimeState: "archived" })).toBe("archived");
		expect(deriveAvailability({ status: "error" })).toBe("archived");
	});

	it("ignores stale runtime_status for Agent-runtime tedis", () => {
		// Agent runtime: stale runtime_status must NOT drive availability.
		expect(
			deriveAvailability({
				runtimeKind: "agent",
				runtimeStatus: "sleeping",
			}),
		).toBe("standby");
		// null runtimeKind => Agent runtime: same — ignore runtime_status.
		expect(
			deriveAvailability({
				runtimeKind: null,
				runtimeStatus: "sleeping",
			}),
		).toBe("standby");
		// And an active Agent runtime stays running despite stale runtime_status.
		expect(
			deriveAvailability({
				runtimeKind: "agent",
				runtimeState: "active",
				runtimeStatus: "sleeping",
			}),
		).toBe("running");
	});

	it("maps active runtimeState to running", () => {
		expect(deriveAvailability({ runtimeState: "active" })).toBe("running");
	});

	it("defaults everything else to standby", () => {
		expect(deriveAvailability({ runtimeState: "standby" })).toBe("standby");
		expect(deriveAvailability({})).toBe("standby");
	});
});

describe("isKernelVisibleTedi", () => {
	it("hides paused, provisioning, error, and archived tedis from Home routing", () => {
		expect(isKernelVisibleTedi({ status: "active" })).toBe(true);
		expect(isKernelVisibleTedi({ status: "paused" })).toBe(false);
		expect(isKernelVisibleTedi({ status: "provisioning" })).toBe(false);
		expect(isKernelVisibleTedi({ status: "error" })).toBe(false);
		expect(isKernelVisibleTedi({ runtimeState: "archived" })).toBe(false);
	});
});

describe("deriveEmbodiedCapability", () => {
	it("keeps plain isolate tedis isolate-only", () => {
		expect(deriveEmbodiedCapability({ runtimeKind: "agent" })).toBe(false);
		expect(hasWorkstationCapability({ repoConfig: null })).toBe(false);
	});

	it("marks isolate tedis with a configured repo as workstation-capable", () => {
		const tedi = {
			runtimeKind: "agent",
			repoConfig: { repoUrl: "https://github.com/tedix-hq/tedix" },
		};
		expect(hasWorkstationCapability(tedi)).toBe(true);
		expect(deriveEmbodiedCapability(tedi)).toBe(true);
	});

	it("defaults missing runtime kind to isolate-only unless a workstation is configured", () => {
		expect(deriveEmbodiedCapability({})).toBe(false);
		expect(
			deriveEmbodiedCapability({
				runtimeKind: null,
				repoConfig: { repoUrl: "https://github.com/tedix-hq/tedix" },
			}),
		).toBe(true);
	});

	it("derives embodiment from needs (lease/repo) only — never the runtime kind itself", () => {
		// The product model: a tedi is embodied ONLY via an additive workstation
		// signal; the runtime kind alone grants nothing.
		expect(deriveEmbodiedCapability({ runtimeKind: "agent" })).toBe(false);
		expect(
			deriveEmbodiedCapability({
				runtimeKind: "agent",
				hasWorkstationLease: true,
			}),
		).toBe(true);
		expect(
			deriveEmbodiedCapability({
				runtimeKind: "agent",
				repoConfig: null,
				hasWorkstationLease: false,
			}),
		).toBe(false);
	});

	it("marks an isolate tedi with a warm workstation lease as embodied (no repo needed)", () => {
		// The durable workstation signal: a warm workstation_leases seat. An
		// isolate with neither repo nor lease stays isolate-only.
		expect(
			deriveEmbodiedCapability({
				runtimeKind: "agent",
				hasWorkstationLease: true,
			}),
		).toBe(true);
		expect(
			hasWorkstationCapability({
				repoConfig: null,
				hasWorkstationLease: true,
			}),
		).toBe(true);
		expect(
			deriveEmbodiedCapability({
				runtimeKind: "agent",
				hasWorkstationLease: false,
			}),
		).toBe(false);
	});
});

describe("deriveRequiresApproval (fail-safe default true)", () => {
	it("defaults to true when no policy definition is present", () => {
		expect(deriveRequiresApproval(null)).toBe(true);
		expect(deriveRequiresApproval(undefined)).toBe(true);
		expect(deriveRequiresApproval({})).toBe(true);
	});

	it("defaults to true when governance has no opt-out flag", () => {
		expect(deriveRequiresApproval({ governancePolicy: { foo: 1 } })).toBe(true);
	});

	it("returns false only on an explicit auto-dispatch/approve opt-out", () => {
		expect(
			deriveRequiresApproval({ governancePolicy: { autoDispatch: true } }),
		).toBe(false);
		expect(
			deriveRequiresApproval({ governancePolicy: { autoApprove: true } }),
		).toBe(false);
		expect(
			deriveRequiresApproval({ governancePolicy: { requiresApproval: false } }),
		).toBe(false);
	});

	// ---  Per-tedi governanceOverride ---

	it("override=false makes a GATED-pack tedi autonomous", () => {
		// Pack says gated (requiresApproval defaults true). Override wins.
		expect(
			deriveRequiresApproval(
				{ governancePolicy: {} },
				{ requiresApproval: false },
			),
		).toBe(false);
	});

	it("override=true keeps a tedi gated even when the pack would make it autonomous", () => {
		// Pack would normally auto-dispatch. Override wins and keeps it gated.
		expect(
			deriveRequiresApproval(
				{ governancePolicy: { autoDispatch: true } },
				{ requiresApproval: true },
			),
		).toBe(true);
	});

	it("override=null falls through to pack derivation (revert to pack)", () => {
		// null override → no override — pack wins.
		expect(
			deriveRequiresApproval(
				{ governancePolicy: { autoDispatch: true } },
				null,
			),
		).toBe(false);
		expect(deriveRequiresApproval({ governancePolicy: {} }, null)).toBe(true);
	});

	it("override=undefined falls through to pack derivation", () => {
		expect(
			deriveRequiresApproval(
				{ governancePolicy: { autoDispatch: true } },
				undefined,
			),
		).toBe(false);
	});

	it("malformed override (no requiresApproval field) falls through to pack", () => {
		// Override object exists but has no recognized requiresApproval boolean.
		expect(
			deriveRequiresApproval(
				{ governancePolicy: {} },
				{} as { requiresApproval?: boolean },
			),
		).toBe(true);
	});
});

describe("deriveScopeGroups", () => {
	it("coarsens tedi scopes and merges app capability flags, deduped", () => {
		const groups = deriveScopeGroups("standard", [
			{
				metadata: { capabilities: { vertical: "ecommerce", checkout: true } },
			} as unknown as App,
		]);
		// standard profile contributes coarse mcp capability groups
		expect(groups).toContain("mcp:tedis");
		expect(groups).toContain("ecommerce");
		expect(groups).toContain("checkout");
		// deduped
		expect(new Set(groups).size).toBe(groups.length);
	});

	it("caps the scope-group list", () => {
		const groups = deriveScopeGroups("platform_admin", []);
		expect(groups.length).toBeLessThanOrEqual(12);
	});
});

// ---------------------------------------------------------------------------
// getTediCapabilityCards — chainable Drizzle stub
// ---------------------------------------------------------------------------

interface StubTedi {
	id: string;
	slug: string;
	name: string;
	displayName?: string | null;
	runtimeKind?: string | null;
	runtimeState?: string | null;
	status?: string | null;
	runtimeStatus?: string | null;
	mcpCapabilityProfile?: string | null;
	tags?: string[] | null;
	policyPackId?: string | null;
	repoConfig?: {
		repoUrl: string;
		branch?: string;
		worktreePath?: string;
	} | null;
	governanceOverride?: { requiresApproval?: boolean } | null;
}

/**
 * Build a chainable Drizzle-like stub. The query layer calls:
 *   getTedisByOrganization → select().from(tedis).where()
 *   getAppsByOrganization  → select().from(apps).where()
 *   skill_entries          → select({...}).from(skillEntries).where()
 *   policy_packs           → select({...}).from(policyPacks).where()
 * We dispatch by the FROM table's drizzle name.
 */
function makeStubDb(data: {
	tedis: StubTedi[];
	apps?: unknown[];
	skills?: { tediId: string | null; slug: string | null; title: string }[];
	packs?: { id: string; definition: unknown }[];
	workstationLeases?: { id: string; status?: string }[];
	workstationParticipants?: {
		leaseId: string;
		tediId: string | null;
		status: string;
	}[];
	learned?: {
		tediId: string | null;
		content: string | null;
		sourceCount: number | null;
		updatedAt: string | null;
	}[];
	entrustments?: Array<{
		tediId: string;
		level: string;
		scope: {
			actions: string[];
			toolIds: string[];
			environments: string[];
			spendPermission: "none" | "policy_bound";
			budgetPolicyId: string | null;
			constraints: Record<string, unknown>;
		};
		activityId: string;
		taskFamily: string;
		riskLevel: string;
		actionPatterns: string[];
		activityToolIds: string[];
	}>;
	throwOn?: "skills" | "packs" | "learned";
	/** Records which FROM tables were read — lets tests assert the tedis/apps
	 * re-read is SKIPPED when pre-fetched rows are passed via opts. */
	tablesRead?: string[];
}): DbClient {
	const tableName = (table: unknown): string => {
		const sym = Object.getOwnPropertySymbols(table as object).find((s) =>
			s.description?.includes("Name"),
		);
		return sym ? String((table as Record<symbol, unknown>)[sym]) : "";
	};

	function selectChain(_columns?: unknown) {
		let resolver: () => unknown[] = () => [];
		const chain = {
			from(table: unknown) {
				const name = tableName(table);
				data.tablesRead?.push(name);
				if (name === "tedis") resolver = () => data.tedis;
				else if (name === "apps") resolver = () => data.apps ?? [];
				else if (name === "skill_entries") {
					resolver = () => {
						if (data.throwOn === "skills") throw new Error("skill read boom");
						return data.skills ?? [];
					};
				} else if (name === "policy_packs") {
					resolver = () => {
						if (data.throwOn === "packs") throw new Error("pack read boom");
						return data.packs ?? [];
					};
				} else if (name === "workstation_leases") {
					resolver = () => data.workstationLeases ?? [];
				} else if (name === "workstation_participants") {
					resolver = () => data.workstationParticipants ?? [];
				} else if (name === "knowledge_entries") {
					resolver = () => {
						if (data.throwOn === "learned")
							throw new Error("learned read boom");
						return data.learned ?? [];
					};
				} else if (name === "tedi_entrustment_grants") {
					resolver = () => data.entrustments ?? [];
				}
				return chain;
			},
			innerJoin() {
				return chain;
			},
			leftJoin() {
				return chain;
			},
			// Every call site terminates the builder at `.where()` and awaits it, so
			// resolving here keeps the stub a plain (non-thenable) builder object.
			where(): Promise<unknown[]> {
				return Promise.resolve(resolver());
			},
		};
		return chain;
	}

	return {
		select: (columns?: unknown) => selectChain(columns),
		query: {
			tediEntrustmentGrants: {
				findMany: async () => {
					data.tablesRead?.push("tedi_entrustment_grants");
					return (data.entrustments ?? []).map((row, index) => ({
						id: `grant-${index}`,
						tediId: row.tediId,
						revision: 1,
						lastDecisionId: `decision-${index}`,
						activityVersion: 1,
						expiresAt: null,
						level: row.level,
						scope: row.scope,
						roleAssignmentId: null,
						activity: {
							id: row.activityId,
							version: 1,
							taskFamily: row.taskFamily,
							riskLevel: row.riskLevel,
							actionPatterns: row.actionPatterns,
							toolIds: row.activityToolIds,
						},
					}));
				},
			},
		},
	} as unknown as DbClient;
}

/**
 * Minimal stub for `readOrgDispatchPolicyLayer`: select().from().where().limit()
 * resolves to the supplied rows. Terminates at `.limit()` (unlike makeStubDb,
 * which terminates at `.where()`).
 */
function makeLimitStubDb(rows: { definition: unknown }[]): DbClient {
	const chain = {
		from() {
			return chain;
		},
		where() {
			return chain;
		},
		limit(): Promise<{ definition: unknown }[]> {
			return Promise.resolve(rows);
		},
	};
	return { select: () => chain } as unknown as DbClient;
}

function ecommerceApp(id: string, slug: string) {
	return {
		id,
		slug,
		name: slug,
		metadata: {
			capabilities: { vertical: "ecommerce", checkout: true },
			mcpConfig: {
				assignmentConfig: {
					mode: "profile-default",
					role: "operator",
					capabilityProfiles: ["standard", "platform_admin"],
				},
			},
		},
	};
}

describe("getTediCapabilityCards", () => {
	it("projects complete task-scoped grants instead of a per-tedi authority boolean", async () => {
		const db = makeStubDb({
			tedis: [
				{
					id: "tedi-1",
					slug: "finance",
					name: "Finance",
					runtimeState: "active",
				},
			],
			entrustments: [
				{
					tediId: "tedi-1",
					level: "autonomous",
					activityId: "activity-1",
					taskFamily: "multi_hop_read",
					riskLevel: "medium",
					actionPatterns: ["kernel.receive_delegation"],
					activityToolIds: [],
					scope: {
						actions: ["kernel.receive_delegation"],
						toolIds: [],
						environments: ["production"],
						spendPermission: "none",
						budgetPolicyId: null,
						constraints: { maximumRisk: "medium" },
					},
				},
			],
		});

		const card = (await getTediCapabilityCards(db, "org-1"))[0]!;
		expect(card.delegationEntrustments).toEqual([
			expect.objectContaining({
				activityId: "activity-1",
				taskFamily: "multi_hop_read",
				riskLevel: "medium",
			}),
		]);
		expect(card).not.toHaveProperty("autonomousDelegationEntrusted");
	});

	it("builds a bounded card with apps, scopes, skills, availability", async () => {
		const db = makeStubDb({
			tedis: [
				{
					id: "tedi-1",
					slug: "cto",
					name: "cto",
					displayName: "CTO",
					runtimeKind: "agent",
					runtimeState: "active",
					mcpCapabilityProfile: "standard",
					policyPackId: "pack-1",
				},
			],
			apps: [ecommerceApp("app-1", "github-tedix")],
			skills: [
				{ tediId: "tedi-1", slug: "deploy-audit", title: "Deploy Audit" },
				{ tediId: "tedi-1", slug: null, title: "Untitled Skill" },
			],
			packs: [
				{
					id: "pack-1",
					definition: { governancePolicy: { autoDispatch: true } },
				},
			],
		});

		const cards = await getTediCapabilityCards(db, "org-1");
		expect(cards).toHaveLength(1);
		const card = cards[0]!;
		expect(card).toMatchObject<Partial<TediCapabilityCard>>({
			tediId: "tedi-1",
			slug: "cto",
			name: "CTO",
			runtimeKind: "agent",
			embodied: false,
			availability: "running",
			mcpCapabilityProfile: "standard",
		});
		expect(card.apps).toContain("github-tedix");
		expect(card.scopeGroups).toContain("ecommerce");
		expect(card.skills).toEqual(["deploy-audit", "Untitled Skill"]);
		// pack opted out of approval
		expect(card.requiresApproval).toBe(false);
	});

	it("defaults requiresApproval TRUE when the tedi has no policy pack", async () => {
		const db = makeStubDb({
			tedis: [{ id: "t2", slug: "ops", name: "ops" }],
			apps: [],
		});
		const cards = await getTediCapabilityCards(db, "org-1");
		expect(cards[0]!.requiresApproval).toBe(true);
		// no runtimeKind → Agent-runtime default ("agent"), not implicit OS capability
		expect(cards[0]!.runtimeKind).toBe("agent");
		expect(cards[0]!.embodied).toBe(false);
	});

	it("marks an isolate tedi with repoConfig as embodied via workstation", async () => {
		const db = makeStubDb({
			tedis: [
				{
					id: "tedi-cpo",
					slug: "cpo",
					name: "cpo",
					runtimeKind: "agent",
					runtimeState: "active",
					repoConfig: {
						repoUrl: "https://github.com/tedix-hq/tedix",
						branch: "main",
					},
				},
			],
			apps: [],
		});

		const cards = await getTediCapabilityCards(db, "org-1");

		expect(cards).toHaveLength(1);
		expect(cards[0]).toMatchObject({
			slug: "cpo",
			runtimeKind: "agent",
			embodied: true,
			hasRepository: true,
			hasWarmWorkstationLease: false,
		});
	});

	it("marks a warm-lease-only tedi as embodied without marking it as a configured repository target", async () => {
		const db = makeStubDb({
			tedis: [
				{
					id: "tedi-browser",
					slug: "browser",
					name: "Browser",
					runtimeKind: "agent",
					runtimeState: "active",
					repoConfig: null,
				},
			],
			apps: [],
			workstationLeases: [{ id: "lease-1", status: "active" }],
			workstationParticipants: [
				{ leaseId: "lease-1", tediId: "tedi-browser", status: "active" },
			],
		});

		const cards = await getTediCapabilityCards(db, "org-1");

		expect(cards).toHaveLength(1);
		expect(cards[0]).toMatchObject({
			slug: "browser",
			runtimeKind: "agent",
			embodied: true,
			hasWarmWorkstationLease: true,
			hasRepository: false,
		});
	});

	it("degrades to the thin card (empty skills, no throw) when a batch read fails", async () => {
		const db = makeStubDb({
			tedis: [
				{
					id: "t3",
					slug: "ops",
					name: "ops",
					runtimeState: "active",
					policyPackId: "pack-x",
				},
			],
			apps: [ecommerceApp("a", "shop")],
			throwOn: "skills",
		});
		const cards = await getTediCapabilityCards(db, "org-1");
		expect(cards).toHaveLength(1);
		// skills read threw → degraded to []
		expect(cards[0]!.skills).toEqual([]);
		// rest of the card still assembled, requiresApproval still fail-safe
		expect(cards[0]!.availability).toBe("running");
		expect(cards[0]!.requiresApproval).toBe(true);
	});

	it("returns an empty array for an org with no tedis", async () => {
		const db = makeStubDb({ tedis: [] });
		expect(await getTediCapabilityCards(db, "org-1")).toEqual([]);
	});

	// --- learnedCapability (capability flywheel) --------------------------------

	it("carries the evidence-learned capability description onto the card", async () => {
		const db = makeStubDb({
			tedis: [
				{ id: "tedi-1", slug: "cto", name: "cto", runtimeState: "active" },
			],
			apps: [],
			learned: [
				{
					tediId: "tedi-1",
					content: "Reliably ships read-heavy research objectives.",
					sourceCount: 7,
					updatedAt: "2026-07-06T00:00:00.000Z",
				},
			],
		});
		const card = (await getTediCapabilityCards(db, "org-1"))[0]!;
		expect(card.learnedCapability).toEqual({
			description: "Reliably ships read-heavy research objectives.",
			evidenceCount: 7,
			updatedAt: "2026-07-06T00:00:00.000Z",
		});
	});

	it("leaves learnedCapability null when no distilled row exists", async () => {
		const db = makeStubDb({
			tedis: [
				{ id: "tedi-1", slug: "cto", name: "cto", runtimeState: "active" },
			],
			apps: [],
		});
		const card = (await getTediCapabilityCards(db, "org-1"))[0]!;
		expect(card.learnedCapability).toBeNull();
	});

	it("degrades learnedCapability to null (no throw) when the read fails", async () => {
		const db = makeStubDb({
			tedis: [
				{ id: "tedi-1", slug: "cto", name: "cto", runtimeState: "active" },
			],
			apps: [],
			throwOn: "learned",
		});
		const cards = await getTediCapabilityCards(db, "org-1");
		expect(cards).toHaveLength(1);
		expect(cards[0]!.learnedCapability).toBeNull();
		// Rest of the card still assembled.
		expect(cards[0]!.availability).toBe("running");
	});

	it("uses pre-fetched rows from opts and SKIPS the tedis/apps re-read", async () => {
		const tablesRead: string[] = [];
		// The stub's own tedis/apps slots are intentionally EMPTY — if the function
		// re-reads them (ignoring opts) the card would be empty / absent. Passing
		// the populated rows via opts is the only way the card gets built.
		const db = makeStubDb({
			tedis: [],
			apps: [],
			skills: [{ tediId: "tedi-1", slug: "deploy-audit", title: "Deploy" }],
			packs: [
				{
					id: "pack-1",
					definition: { governancePolicy: { autoDispatch: true } },
				},
			],
			tablesRead,
		});

		const tedis = [
			{
				id: "tedi-1",
				slug: "cto",
				name: "cto",
				displayName: "CTO",
				runtimeKind: "agent",
				runtimeState: "active",
				mcpCapabilityProfile: "standard",
				policyPackId: "pack-1",
			},
		] as unknown as Parameters<typeof getTediCapabilityCards>[2] extends
			| { tedis?: infer T }
			| undefined
			? T
			: never;
		const apps = [
			ecommerceApp("app-1", "github-tedix"),
		] as unknown as Parameters<typeof getTediCapabilityCards>[2] extends
			| { apps?: infer A }
			| undefined
			? A
			: never;

		const cards = await getTediCapabilityCards(db, "org-1", { tedis, apps });

		expect(cards).toHaveLength(1);
		expect(cards[0]!.apps).toContain("github-tedix");
		expect(cards[0]!.skills).toEqual(["deploy-audit"]);
		// The tedis/apps tables were NOT read — only the skills + policy reads ran.
		expect(tablesRead).not.toContain("tedis");
		expect(tablesRead).not.toContain("apps");
		expect(tablesRead).toContain("skill_entries");
		expect(tablesRead).toContain("policy_packs");
	});

	it("re-reads tedis + apps when opts are absent (standalone path)", async () => {
		const tablesRead: string[] = [];
		const db = makeStubDb({
			tedis: [
				{
					id: "tedi-1",
					slug: "cto",
					name: "cto",
					runtimeState: "active",
				},
			],
			apps: [ecommerceApp("app-1", "github-tedix")],
			tablesRead,
		});

		const cards = await getTediCapabilityCards(db, "org-1");

		expect(cards).toHaveLength(1);
		expect(cards[0]!.apps).toContain("github-tedix");
		// Standalone: both tables ARE read.
		expect(tablesRead).toContain("tedis");
		expect(tablesRead).toContain("apps");
	});

	// --- Layered gating: tedi-layer + warm-lease sourcing onto the card --------

	it("surfaces the tedi dispatch gating layer from the pack gatingPolicy slot", async () => {
		const db = makeStubDb({
			tedis: [
				{
					id: "tedi-1",
					slug: "cto",
					name: "cto",
					runtimeState: "active",
					policyPackId: "pack-1",
				},
			],
			apps: [],
			packs: [
				{
					id: "pack-1",
					definition: { gatingPolicy: { dispatch: "deny" } },
				},
			],
		});
		const card = (await getTediCapabilityCards(db, "org-1"))[0]!;
		expect(card.dispatchPolicy).toEqual({ effect: "deny" });
		// No warm-lease table in the stub → defaults to false (not embodied-warm).
		expect(card.hasWarmWorkstationLease).toBe(false);
	});

	it("leaves dispatchPolicy null when the pack carries no gatingPolicy", async () => {
		const db = makeStubDb({
			tedis: [
				{
					id: "tedi-1",
					slug: "cto",
					name: "cto",
					runtimeState: "active",
					policyPackId: "pack-1",
				},
			],
			apps: [],
			packs: [
				{
					id: "pack-1",
					definition: { governancePolicy: { autoDispatch: true } },
				},
			],
		});
		const card = (await getTediCapabilityCards(db, "org-1"))[0]!;
		expect(card.dispatchPolicy).toBeNull();
	});

	// --- (b) sourced org/tedi DENY forces needs_approval; session ALLOW can't ---
	// override. Proves the live wiring chain: pack gatingPolicy → sourced layer →
	// decideDelegationDispatch verdict.
	it("a sourced org/tedi gatingPolicy DENY forces needs_approval and a session ALLOW cannot override it", async () => {
		// tedi layer: the target's pack denies dispatch.
		const cardDb = makeStubDb({
			tedis: [
				{
					id: "tedi-1",
					slug: "finance",
					name: "Finance",
					runtimeKind: "agent",
					runtimeState: "active",
					policyPackId: "tedi-pack",
				},
			],
			apps: [],
			packs: [
				{ id: "tedi-pack", definition: { gatingPolicy: { dispatch: "deny" } } },
			],
		});
		const card = (await getTediCapabilityCards(cardDb, "org-1"))[0]!;
		expect(card.dispatchPolicy).toEqual({ effect: "deny" });

		// org layer: the org's active pack denies dispatch (separate read path).
		const orgDb = makeLimitStubDb([
			{ definition: { gatingPolicy: { dispatch: "deny" } } },
		]);
		const orgLayer = await readOrgDispatchPolicyLayer(orgDb, "org-1");
		expect(orgLayer).toEqual({ effect: "deny" });

		const route: KernelRouteDecision = {
			routeKind: "delegate_tedi",
			rationale: "finance owns this",
			risk: "low",
			confidence: 0.9,
			effortClass: "multi_hop_read",
			answer: null,
			targetTediId: "tedi-1",
			targetTediLabel: "Finance",
			targetActivityId: null,
			plannedToolIds: [],
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		};
		const decision = decideDelegationDispatch({
			route,
			card,
			speaker: { approvalAuthority: true },
			// A session ALLOW must NOT override the lower-precedence org/tedi DENY.
			gating: {
				session: { effect: "allow" },
				tedi: card.dispatchPolicy,
				org: orgLayer,
			},
		});
		expect(decision.mode).toBe("needs_approval");
		expect(decision.canAutoDispatch).toBe(false);
	});

	it("readOrgDispatchPolicyLayer returns null when no active pack / no gatingPolicy", async () => {
		expect(
			await readOrgDispatchPolicyLayer(makeLimitStubDb([]), "org-1"),
		).toBeNull();
		expect(
			await readOrgDispatchPolicyLayer(
				makeLimitStubDb([{ definition: { governancePolicy: {} } }]),
				"org-1",
			),
		).toBeNull();
	});

	it("reads an organization-scoped earned-delegation rollout without inventing a dispatch allow", async () => {
		const orgLayer = await readOrgDispatchPolicyLayer(
			makeLimitStubDb([
				{
					definition: {
						gatingPolicy: {
							earnedDelegation: {
								mode: "enforce",
								activityIds: ["activity-cmo"],
								tediIds: ["tedi-cmo"],
								environments: ["production"],
							},
						},
					},
				},
			]),
			"org-1",
		);
		expect(orgLayer).toEqual({
			earnedDelegation: {
				mode: "enforce",
				activityIds: ["activity-cmo"],
				tediIds: ["tedi-cmo"],
				environments: ["production"],
			},
		});
	});

	// --- governanceOverride integration ---

	it("override=false makes a tedi autonomous even when the policy pack is gated", async () => {
		const db = makeStubDb({
			tedis: [
				{
					id: "tedi-cto",
					slug: "cto",
					name: "CTO",
					runtimeState: "active",
					policyPackId: "gated-pack",
					// Pack says gated (no autoDispatch); override flips to autonomous.
					governanceOverride: { requiresApproval: false },
				},
			],
			apps: [],
			packs: [
				{
					id: "gated-pack",
					definition: { governancePolicy: {} }, // no autoDispatch → gated by default
				},
			],
		});

		const card = (await getTediCapabilityCards(db, "org-1"))[0]!;
		expect(card.requiresApproval).toBe(false);
	});

	it("override=true keeps tedi gated even when the pack would auto-dispatch", async () => {
		const db = makeStubDb({
			tedis: [
				{
					id: "tedi-cfo",
					slug: "cfo",
					name: "CFO",
					runtimeState: "active",
					policyPackId: "auto-pack",
					// Pack says autonomous; override forces it back to gated.
					governanceOverride: { requiresApproval: true },
				},
			],
			apps: [],
			packs: [
				{
					id: "auto-pack",
					definition: { governancePolicy: { autoDispatch: true } },
				},
			],
		});

		const card = (await getTediCapabilityCards(db, "org-1"))[0]!;
		expect(card.requiresApproval).toBe(true);
	});

	it("null governanceOverride falls through to pack (revert to pack-derived governance)", async () => {
		const db = makeStubDb({
			tedis: [
				{
					id: "tedi-cmo",
					slug: "cmo",
					name: "CMO",
					runtimeState: "active",
					policyPackId: "auto-pack",
					governanceOverride: null,
				},
			],
			apps: [],
			packs: [
				{
					id: "auto-pack",
					definition: { governancePolicy: { autoDispatch: true } },
				},
			],
		});

		const card = (await getTediCapabilityCards(db, "org-1"))[0]!;
		// null override → pack wins → autonomous
		expect(card.requiresApproval).toBe(false);
	});

	it("malformed governanceOverride (no requiresApproval) falls through to pack", async () => {
		const db = makeStubDb({
			tedis: [
				{
					id: "tedi-cpo",
					slug: "cpo",
					name: "CPO",
					runtimeState: "active",
					policyPackId: "auto-pack",
					// No requiresApproval field → not a recognized override
					governanceOverride: {} as { requiresApproval?: boolean },
				},
			],
			apps: [],
			packs: [
				{
					id: "auto-pack",
					definition: { governancePolicy: { autoDispatch: true } },
				},
			],
		});

		const card = (await getTediCapabilityCards(db, "org-1"))[0]!;
		// Malformed override → falls through to pack → autonomous
		expect(card.requiresApproval).toBe(false);
	});
});
