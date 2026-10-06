import { createRouterClient } from "@orpc/server";
import type { SkillEntry } from "@tedix/db/schema/cognitive";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

/**
 * Adversarial-review regression suite.
 *
 * Premortem parity on skills.improve: improve could move a skill into
 * the record layer (or rewrite record-layer content) with force, entirely
 * bypassing the Klein-2007 premortem that promote/apply enforce. It now runs
 * the same gate: operators may skip WITH a logged skipPremortemReason; agent
 * callers can never skip.
 *
 * Tedi force ceiling on applyWorkshop: a tedi-applied proposal that
 * requests `crystallized` (or `proven`) is CLAMPED to `active`, annotated in
 * the changes list and the durable revisionReasoning — never a silent success
 * at a lower state, never a record-layer entry on tedi authority alone.
 */

const mocks = vi.hoisted(() => ({
	getSkillEntry: vi.fn(),
	updateSkillEntry: vi.fn(),
	computeSkillPromotionBlockers: vi.fn(),
	deleteSkillSchedule: vi.fn(),
	getSkillSchedule: vi.fn(),
	upsertSkillSchedule: vi.fn(),
}));

vi.mock("@tedix/db/queries/cognitive/skill-crud", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/cognitive/skill-crud")
	>()),
	getSkillEntry: mocks.getSkillEntry,
	updateSkillEntry: mocks.updateSkillEntry,
}));

vi.mock(
	"@tedix/db/queries/cognitive/skill-promotion",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@tedix/db/queries/cognitive/skill-promotion")
		>()),
		computeSkillPromotionBlockers: mocks.computeSkillPromotionBlockers,
	}),
);

vi.mock("@tedix/db/queries/skill-schedules", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/skill-schedules")
	>()),
	deleteSkillSchedule: mocks.deleteSkillSchedule,
	getSkillSchedule: mocks.getSkillSchedule,
	upsertSkillSchedule: mocks.upsertSkillSchedule,
}));

import { skillsContractRouter } from "./cognitive";

const ORG_ID = "org-1";

function skillFixture(overrides: Partial<SkillEntry> = {}): SkillEntry {
	return {
		id: "skill-1",
		organizationId: ORG_ID,
		tediId: "tedi-author",
		proposedByTediId: "tedi-author",
		domainId: null,
		title: "Deploy reconciler",
		slug: "deploy-reconciler",
		description: null,
		content: "# Skill",
		files: null,
		inputSchema: null,
		successCount: 0,
		failureCount: 0,
		lastUsedAt: null,
		avgDurationMs: null,
		revision: 1,
		revisionReasoning: null,
		supersedesId: null,
		sourceSkillId: null,
		sourceRevision: null,
		visibility: "private",
		agentSkillsFormat: null,
		r2Path: null,
		appId: null,
		toolIds: null,
		summary: null,
		tags: [],
		audience: null,
		preconditions: null,
		lifecycleState: "proven",
		reviewFlaggedAt: null,
		reviewFlagReason: null,
		paceLayer: "differentiation",
		createdAt: "2026-07-01T00:00:00.000Z",
		updatedAt: "2026-07-01T00:00:00.000Z",
		...overrides,
	} as SkillEntry;
}

/** Operator: API-key auth (isLifecycleOverrideAuthority passes). */
function createOperatorContext(): BaseContext {
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
		url: new URL("https://api.tedix.test/rpc/skills"),
		user: undefined,
	} as BaseContext;
}

/** Agent-class caller: trusted service binding forwarding a tedi identity. */
function createAgentContext(tediId: string): BaseContext {
	return {
		authType: "service-binding",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Mcp-Tool-Id": "skills:improve",
			"X-Tedix-Tedi-Scopes": "mcp:skills",
		}),
		organizationId: ORG_ID,
		tediId,
		tediScopes: ["mcp:skills"],
		rateLimiter: {
			limit: vi.fn(async () => ({ success: true })),
		} as unknown as RateLimit,
		url: new URL("https://api.tedix.test/rpc/skills"),
		user: undefined,
	} as BaseContext;
}

function createClient(context: BaseContext) {
	return createRouterClient(skillsContractRouter, { context });
}

const PREMORTEM = {
	failureModes: [
		"upstream schema drift breaks the workflow silently",
		"expired credentials make every call fail closed",
	],
	rollback: "demote the skill back to proven and restore revision N-1",
};

describe("skills.improve premortem parity (A6)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSkillEntry.mockResolvedValue(skillFixture());
		mocks.updateSkillEntry.mockResolvedValue(undefined);
		mocks.getSkillSchedule.mockResolvedValue(null);
		mocks.deleteSkillSchedule.mockResolvedValue(undefined);
	});

	it("operator improve to crystallized WITHOUT premortem/skipReason is rejected", async () => {
		const client = createClient(createOperatorContext());
		await expect(
			client.improve({
				id: "skill-1",
				lifecycleState: "crystallized",
				force: true,
				validate: "skip",
			}),
		).rejects.toThrow(/premortem/);
		expect(mocks.updateSkillEntry).not.toHaveBeenCalled();
	});

	it("operator improve to crystallized WITH skipPremortemReason passes and is logged", async () => {
		const client = createClient(createOperatorContext());
		await expect(
			client.improve({
				id: "skill-1",
				lifecycleState: "crystallized",
				force: true,
				validate: "skip",
				skipPremortemReason: "one-shot migration, rollback documented",
			}),
		).resolves.toMatchObject({ entry: expect.anything() });
		expect(mocks.updateSkillEntry).toHaveBeenCalledWith(
			expect.anything(),
			"skill-1",
			expect.objectContaining({
				lifecycleState: "crystallized",
				revisionReasoning: expect.stringContaining(
					"Premortem skipped by operator: one-shot migration",
				),
			}),
			{ force: true, forceAuthority: { kind: "operator" } },
		);
	});

	it("operator improve WITH a premortem passes and appends the audit line", async () => {
		const client = createClient(createOperatorContext());
		await client.improve({
			id: "skill-1",
			lifecycleState: "crystallized",
			force: true,
			validate: "skip",
			revisionReasoning: "Compressing into muscle memory.",
			premortem: PREMORTEM,
		});
		expect(mocks.updateSkillEntry).toHaveBeenCalledWith(
			expect.anything(),
			"skill-1",
			expect.objectContaining({
				revisionReasoning: expect.stringMatching(
					/Compressing into muscle memory\.\nPremortem \(Klein 2007\)/,
				),
			}),
			expect.anything(),
		);
	});

	it("agent callers cannot skip: skipPremortemReason is rejected", async () => {
		const client = createClient(createAgentContext("tedi-reviewer"));
		await expect(
			client.improve({
				id: "skill-1",
				lifecycleState: "crystallized",
				validate: "skip",
				skipPremortemReason: "trust me, it is fine",
			}),
		).rejects.toThrow(/operator-only/);
		expect(mocks.updateSkillEntry).not.toHaveBeenCalled();
	});

	it("non-record improves stay ungated (no premortem required)", async () => {
		mocks.getSkillEntry.mockResolvedValue(
			skillFixture({ lifecycleState: "draft" }),
		);
		const client = createClient(createOperatorContext());
		await expect(
			client.improve({
				id: "skill-1",
				summary: "Sharper summary",
				validate: "skip",
			}),
		).resolves.toMatchObject({ entry: expect.anything() });
		expect(mocks.updateSkillEntry).toHaveBeenCalled();
	});
});

describe("skills.applyWorkshop tedi force ceiling (A4)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSkillEntry.mockResolvedValue(
			skillFixture({ lifecycleState: "draft" }),
		);
		mocks.updateSkillEntry.mockResolvedValue(undefined);
		mocks.computeSkillPromotionBlockers.mockResolvedValue([]);
		mocks.getSkillSchedule.mockResolvedValue(null);
		mocks.deleteSkillSchedule.mockResolvedValue(undefined);
	});

	it("a tedi apply requesting crystallized is clamped to active and annotated", async () => {
		const client = createClient(createAgentContext("tedi-reviewer"));
		const result = await client.applyWorkshop({
			id: "skill-1",
			lifecycleState: "crystallized",
		});
		expect(result.applied).toBe(true);
		const clamp = result.changes.find(
			(change) => change.code === "TEDI_APPLY_LIFECYCLE_CLAMPED",
		);
		expect(clamp).toMatchObject({
			field: "lifecycleState",
			before: "crystallized",
			after: "active",
		});
		expect(mocks.updateSkillEntry).toHaveBeenCalledWith(
			expect.anything(),
			"skill-1",
			expect.objectContaining({
				lifecycleState: "active",
				revisionReasoning: expect.stringContaining("force ceiling"),
			}),
			{
				force: true,
				forceAuthority: { kind: "tedi", tediId: "tedi-reviewer" },
			},
		);
	});

	it("a tedi apply requesting proven is clamped too", async () => {
		const client = createClient(createAgentContext("tedi-reviewer"));
		const result = await client.applyWorkshop({
			id: "skill-1",
			lifecycleState: "proven",
		});
		const clamp = result.changes.find(
			(change) => change.code === "TEDI_APPLY_LIFECYCLE_CLAMPED",
		);
		expect(clamp).toMatchObject({ before: "proven", after: "active" });
	});

	it("an operator apply to crystallized is unaffected (with premortem)", async () => {
		const client = createClient(createOperatorContext());
		const result = await client.applyWorkshop({
			id: "skill-1",
			lifecycleState: "crystallized",
			premortem: PREMORTEM,
		});
		expect(result.applied).toBe(true);
		expect(
			result.changes.some(
				(change) => change.code === "TEDI_APPLY_LIFECYCLE_CLAMPED",
			),
		).toBe(false);
		expect(mocks.updateSkillEntry).toHaveBeenCalledWith(
			expect.anything(),
			"skill-1",
			expect.objectContaining({ lifecycleState: "crystallized" }),
			{ force: true, forceAuthority: { kind: "operator" } },
		);
	});

	it("a tedi apply to active (at the ceiling) is not clamped", async () => {
		const client = createClient(createAgentContext("tedi-reviewer"));
		const result = await client.applyWorkshop({
			id: "skill-1",
			lifecycleState: "active",
		});
		expect(
			result.changes.some(
				(change) => change.code === "TEDI_APPLY_LIFECYCLE_CLAMPED",
			),
		).toBe(false);
		expect(mocks.updateSkillEntry).toHaveBeenCalledWith(
			expect.anything(),
			"skill-1",
			expect.objectContaining({ lifecycleState: "active" }),
			expect.anything(),
		);
	});
});
