import { createRouterClient } from "@orpc/server";
import type { SkillEntry, SkillSchedule } from "@tedix/db/schema/cognitive";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({
	computeSkillRepairs: vi.fn(),
	getSkillEntry: vi.fn(),
	getSkillSchedule: vi.fn(),
	updateSkillEntry: vi.fn(),
	upsertSkillSchedule: vi.fn(),
	deleteSkillSchedule: vi.fn(),
}));

vi.mock("@tedix/db/queries/cognitive/skill-crud", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/cognitive/skill-crud")
	>()),
	getSkillEntry: mocks.getSkillEntry,
	updateSkillEntry: mocks.updateSkillEntry,
}));

vi.mock("@tedix/db/queries/cognitive/skill-repair", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/cognitive/skill-repair")
	>()),
	computeSkillRepairs: mocks.computeSkillRepairs,
}));

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
const SKILL_ID = "skill-1";
const TEDI_ID = "tedi-1";
const SCHEDULE = {
	cron: "0 0 1 1 *",
	params: { mode: "retry" },
	enabled: false,
};

function skillFixture(): SkillEntry {
	return {
		id: SKILL_ID,
		organizationId: ORG_ID,
		tediId: TEDI_ID,
		proposedByTediId: TEDI_ID,
		domainId: null,
		title: "Workflow Kitchen Sink",
		slug: "workflow-kitchen-sink",
		description: "Runtime proof fixture",
		content: `---
name: workflow-kitchen-sink
capabilities:
  schedule:
    cron: "0 0 1 1 *"
    params:
      mode: retry
    enabled: false
---

# Workflow Kitchen Sink`,
		files: { "scripts/workflow.ts": "export default {};" },
		inputSchema: null,
		successCount: 1,
		failureCount: 0,
		lastUsedAt: null,
		avgDurationMs: null,
		revision: 7,
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
		audience: ["tedi"],
		preconditions: null,
		lifecycleState: "proven",
		reviewFlaggedAt: null,
		reviewFlagReason: null,
		paceLayer: "differentiation",
		createdAt: "2026-07-16T00:00:00.000Z",
		updatedAt: "2026-07-16T00:00:00.000Z",
	} as SkillEntry;
}

function scheduleFixture(): SkillSchedule {
	return {
		id: "schedule-1",
		organizationId: ORG_ID,
		skillId: SKILL_ID,
		tediId: TEDI_ID,
		...SCHEDULE,
		nextFireAt: "2027-01-01T00:00:00.000Z",
		lastFireAt: null,
		lastRunId: null,
		lastError: null,
		createdAt: "2026-07-16T00:00:00.000Z",
		updatedAt: "2026-07-16T00:00:00.000Z",
	};
}

function createClient() {
	const context = {
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
	return createRouterClient(skillsContractRouter, { context });
}

describe("skills.repair schedule projection", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSkillEntry.mockResolvedValue(skillFixture());
		mocks.computeSkillRepairs.mockResolvedValue({ changes: [], patch: {} });
		mocks.deleteSkillSchedule.mockResolvedValue(undefined);
		mocks.upsertSkillSchedule.mockResolvedValue(undefined);
	});

	it("reports a missing manifest schedule without mutating in dry-run mode", async () => {
		mocks.getSkillSchedule.mockResolvedValue(undefined);

		const result = await createClient().repair({ id: SKILL_ID });

		expect(result).toMatchObject({ applied: false, entry: null });
		expect(result.changes).toContainEqual({
			code: "SYNC_SCHEDULE_PROJECTION",
			field: "schedule",
			before: null,
			after: { skillId: SKILL_ID, tediId: TEDI_ID, ...SCHEDULE },
			note: "reconciled from the canonical skill manifest",
		});
		expect(mocks.upsertSkillSchedule).not.toHaveBeenCalled();
	});

	it("restores a missing manifest schedule idempotently", async () => {
		mocks.getSkillSchedule.mockResolvedValue(undefined);

		const result = await createClient().repair({ id: SKILL_ID, dryRun: false });

		expect(result.applied).toBe(true);
		expect(mocks.upsertSkillSchedule).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				organizationId: ORG_ID,
				skillId: SKILL_ID,
				tediId: TEDI_ID,
				...SCHEDULE,
			}),
		);
	});

	it("does nothing when the stored projection already matches the manifest", async () => {
		mocks.getSkillSchedule.mockResolvedValue(scheduleFixture());

		const result = await createClient().repair({ id: SKILL_ID, dryRun: false });

		expect(result).toMatchObject({ applied: false, changes: [] });
		expect(mocks.upsertSkillSchedule).not.toHaveBeenCalled();
		expect(mocks.deleteSkillSchedule).not.toHaveBeenCalled();
	});
});
