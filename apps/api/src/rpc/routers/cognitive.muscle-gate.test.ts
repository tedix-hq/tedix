import { createRouterClient } from "@orpc/server";
import type { SkillEntry } from "@tedix/db/schema/cognitive";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

/**
 * Adversarial-review regression suite (handler layer).
 *
 * muscle.crystallize was an ungated cross-org record-layer write: any caller
 * with tedis:update could mark ANY org's skill `crystallized` with no
 * evidence, no premortem, and no disposer separation. muscle.usage wrote
 * counters (and the source skill's usage ledger) for foreign-org muscle ids.
 * These tests pin the gates: org-scoped 404, the proven muscle bar, the
 * Klein-2007 premortem, disposer authority resolution, and org-scoped usage.
 */

const mocks = vi.hoisted(() => ({
	getSkillEntry: vi.fn(),
	crystallizeMuscleFromSkill: vi.fn(),
	getMuscleMemoryById: vi.fn(),
	recordMuscleUsage: vi.fn(),
	loadSkillUsageSignals: vi.fn(),
	recordSkillUsageEvent: vi.fn(),
}));

vi.mock("@tedix/db/queries/cognitive/skill-crud", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/cognitive/skill-crud")
	>()),
	getSkillEntry: mocks.getSkillEntry,
}));

vi.mock(
	"@tedix/db/queries/cognitive/skill-crystallization",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@tedix/db/queries/cognitive/skill-crystallization")
		>()),
		crystallizeMuscleFromSkill: mocks.crystallizeMuscleFromSkill,
	}),
);

vi.mock(
	"@tedix/db/queries/cognitive/muscle-memory",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@tedix/db/queries/cognitive/muscle-memory")
		>()),
		getMuscleMemoryById: mocks.getMuscleMemoryById,
		recordMuscleUsage: mocks.recordMuscleUsage,
	}),
);

vi.mock("@tedix/db/queries/skill-lifecycle", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/skill-lifecycle")
	>()),
	loadSkillUsageSignals: mocks.loadSkillUsageSignals,
}));

vi.mock("@tedix/db/queries/skill-usage", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/skill-usage")>()),
	recordSkillUsageEvent: mocks.recordSkillUsageEvent,
}));

import { muscleContractRouter } from "./cognitive";

const ORG_ID = "org-1";

const SKILL = {
	id: "skill-1",
	organizationId: ORG_ID,
	tediId: "tedi-author",
	proposedByTediId: "tedi-author",
	lifecycleState: "proven",
	paceLayer: "differentiation",
	revisionReasoning: null,
	title: "Deploy reconciler",
	content: "# Skill",
} as unknown as SkillEntry;

const MUSCLE_ENTRY = {
	id: "muscle-1",
	tediId: "tedi-owner",
	organizationId: ORG_ID,
	kind: "action_template",
	name: "deploy-reconciler",
	description: null,
	r2Path: null,
	usageCount: 0,
	successCount: 0,
	failureCount: 0,
	lastUsedAt: null,
	origin: "from_skill",
	version: 1,
	sourceSkillId: "skill-1",
	codeModule: null,
	allowedNamespaces: null,
	createdAt: "2026-07-16T00:00:00.000Z",
	updatedAt: "2026-07-16T00:00:00.000Z",
};

const PROVEN_SIGNALS = {
	verifiedSuccessCount: 5,
	recentOutcomes: ["success", "success", "success", "success", "success"],
};

const PREMORTEM = {
	failureModes: [
		"upstream schema drift breaks the workflow silently",
		"expired credentials make every call fail closed",
	],
	rollback: "delete the muscle entry and demote the skill back to proven",
};

/** Operator: API-key auth (isLifecycleOverrideAuthority passes). */
function createContext(): BaseContext {
	return {
		authType: "apikey",
		apiKey: {
			id: "api-key-1",
			name: "test",
			organizationId: ORG_ID,
			scopes: ["*"],
		},
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORG_ID,
		rateLimiter: {
			limit: vi.fn(async () => ({ success: true })),
		} as unknown as RateLimit,
		url: new URL("https://api.tedix.test/rpc/muscle"),
		user: undefined,
	} as BaseContext;
}

/**
 * Agent-class caller: the production MCP-edge path — trusted service binding
 * forwarding an (optional) tedi identity. Fails isLifecycleOverrideAuthority.
 */
function createAgentContext(tediId?: string): BaseContext {
	return {
		authType: "service-binding",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Mcp-Tool-Id": "muscle:crystallize",
			...(tediId ? { "X-Tedix-Tedi-Scopes": "mcp:skills" } : {}),
		}),
		organizationId: ORG_ID,
		...(tediId ? { tediId, tediScopes: ["mcp:skills"] } : {}),
		rateLimiter: {
			limit: vi.fn(async () => ({ success: true })),
		} as unknown as RateLimit,
		url: new URL("https://api.tedix.test/rpc/muscle"),
		user: undefined,
	} as BaseContext;
}

function createClient(context: BaseContext) {
	return createRouterClient(muscleContractRouter, { context });
}

const CRYSTALLIZE_INPUT = {
	tediId: "tedi-owner",
	skillId: "skill-1",
	kind: "action_template" as const,
	name: "deploy-reconciler",
};

describe("muscle.crystallize gating (A1)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSkillEntry.mockResolvedValue(SKILL);
		mocks.loadSkillUsageSignals.mockResolvedValue(PROVEN_SIGNALS);
		mocks.crystallizeMuscleFromSkill.mockResolvedValue(MUSCLE_ENTRY);
	});

	it("404s a skill outside the caller's org and never reaches the db writer", async () => {
		mocks.getSkillEntry.mockResolvedValue(undefined);
		const client = createClient(createContext());
		await expect(client.crystallize(CRYSTALLIZE_INPUT)).rejects.toThrow(
			/Skill not found/,
		);
		expect(mocks.getSkillEntry).toHaveBeenCalledWith(
			expect.anything(),
			"skill-1",
			ORG_ID,
		);
		expect(mocks.crystallizeMuscleFromSkill).not.toHaveBeenCalled();
	});

	it("rejects a skill below the proven muscle bar", async () => {
		mocks.loadSkillUsageSignals.mockResolvedValue({
			verifiedSuccessCount: 2,
			recentOutcomes: ["success", "success"],
		});
		const client = createClient(createContext());
		await expect(
			client.crystallize({ ...CRYSTALLIZE_INPUT, premortem: PREMORTEM }),
		).rejects.toThrow(/proven muscle bar/);
		expect(mocks.crystallizeMuscleFromSkill).not.toHaveBeenCalled();
	});

	it("rejects a skill with an unrecovered failure in the recent window", async () => {
		mocks.loadSkillUsageSignals.mockResolvedValue({
			verifiedSuccessCount: 5,
			recentOutcomes: ["failure", "success", "success"],
		});
		const client = createClient(createContext());
		await expect(
			client.crystallize({ ...CRYSTALLIZE_INPUT, premortem: PREMORTEM }),
		).rejects.toThrow(/unrecovered failure/);
		expect(mocks.crystallizeMuscleFromSkill).not.toHaveBeenCalled();
	});

	it("agent callers must supply a premortem (record-layer entry)", async () => {
		const client = createClient(createAgentContext("tedi-reviewer"));
		await expect(client.crystallize(CRYSTALLIZE_INPUT)).rejects.toThrow(
			/premortem/,
		);
		expect(mocks.crystallizeMuscleFromSkill).not.toHaveBeenCalled();
	});

	it("agent callers cannot use the operator skip waiver", async () => {
		const client = createClient(createAgentContext("tedi-reviewer"));
		await expect(
			client.crystallize({
				...CRYSTALLIZE_INPUT,
				skipPremortemReason: "trust me, it is fine",
			}),
		).rejects.toThrow(/operator-only/);
		expect(mocks.crystallizeMuscleFromSkill).not.toHaveBeenCalled();
	});

	it("the authoring tedi can never crystallize its own skill", async () => {
		const client = createClient(createAgentContext("tedi-author"));
		await expect(
			client.crystallize({ ...CRYSTALLIZE_INPUT, premortem: PREMORTEM }),
		).rejects.toThrow(/never approve/);
		expect(mocks.crystallizeMuscleFromSkill).not.toHaveBeenCalled();
	});

	it("anonymous machine credentials fail closed", async () => {
		const client = createClient(createAgentContext());
		await expect(
			client.crystallize({ ...CRYSTALLIZE_INPUT, premortem: PREMORTEM }),
		).rejects.toThrow(/Delegated service-binding scope/);
	});

	it("a NON-author tedi with premortem + proven evidence crystallizes with a tedi authority", async () => {
		const client = createClient(createAgentContext("tedi-reviewer"));
		await expect(
			client.crystallize({ ...CRYSTALLIZE_INPUT, premortem: PREMORTEM }),
		).resolves.toMatchObject({ entry: { id: "muscle-1" } });
		expect(mocks.crystallizeMuscleFromSkill).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				organizationId: ORG_ID,
				skillId: "skill-1",
				authority: { kind: "tedi", tediId: "tedi-reviewer" },
				revisionReasoning: expect.stringContaining("Premortem (Klein 2007)"),
			}),
		);
	});

	it("an operator may skip the premortem with a logged reason", async () => {
		const client = createClient(createContext());
		await expect(
			client.crystallize({
				...CRYSTALLIZE_INPUT,
				skipPremortemReason: "one-shot migration, rollback documented",
			}),
		).resolves.toMatchObject({ entry: { id: "muscle-1" } });
		expect(mocks.crystallizeMuscleFromSkill).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				authority: { kind: "operator" },
				revisionReasoning: expect.stringContaining(
					"Premortem skipped by operator",
				),
			}),
		);
	});
});

describe("muscle.usage org scoping (A3)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("404s a foreign-org muscle id — no counter write, no ledger stamp", async () => {
		mocks.getMuscleMemoryById.mockResolvedValue(undefined);
		const client = createClient(createContext());
		await expect(
			client.usage({ id: "muscle-other-org", success: true }),
		).rejects.toThrow(/not found/);
		expect(mocks.getMuscleMemoryById).toHaveBeenCalledWith(
			expect.anything(),
			"muscle-other-org",
			ORG_ID,
		);
		expect(mocks.recordMuscleUsage).not.toHaveBeenCalled();
		expect(mocks.recordSkillUsageEvent).not.toHaveBeenCalled();
	});

	it("records org-scoped usage and stamps the source skill's ledger", async () => {
		mocks.getMuscleMemoryById.mockResolvedValue(MUSCLE_ENTRY);
		mocks.recordMuscleUsage.mockResolvedValue({
			...MUSCLE_ENTRY,
			usageCount: 1,
			successCount: 1,
		});
		mocks.recordSkillUsageEvent.mockResolvedValue(undefined);
		const client = createClient(createContext());
		await expect(
			client.usage({ id: "muscle-1", success: true }),
		).resolves.toEqual({
			success: true,
		});
		expect(mocks.recordMuscleUsage).toHaveBeenCalledWith(
			expect.anything(),
			"muscle-1",
			true,
			ORG_ID,
		);
		expect(mocks.recordSkillUsageEvent).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				organizationId: ORG_ID,
				skillId: "skill-1",
				source: "muscle_memory",
				success: true,
			}),
		);
	});
});
