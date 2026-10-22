import { createRouterClient } from "@orpc/server";
import type { SkillEntry } from "@tedix/db/schema/cognitive";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

/**
 * Editing a scheduled skill with skills.improve (improve_skills) creates a new
 * revision and preserves lifecycle. Existing draft schedules pause until
 * activation; new drafts still get none.
 */

const mocks = vi.hoisted(() => ({
	getSkillEntry: vi.fn(),
	updateSkillEntry: vi.fn(),
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
const OWNER = "tedi-owner";
const SCHEDULED_DOC =
	'---\nname: nightly-ingest\ncapabilities:\n  schedule:\n    cron: "0 2 * * *"\n---\n# Nightly ingest\n\nVersion 1.';

function skillFixture(overrides: Partial<SkillEntry> = {}): SkillEntry {
	return {
		id: "skill-1",
		organizationId: ORG_ID,
		tediId: OWNER,
		proposedByTediId: OWNER,
		domainId: null,
		title: "Nightly ingest",
		slug: "nightly-ingest",
		description: null,
		content: SCHEDULED_DOC,
		files: { "scripts/workflow.ts": "export default {}" },
		inputSchema: null,
		successCount: 12,
		failureCount: 0,
		lastUsedAt: null,
		avgDurationMs: null,
		revision: 7,
		revisionReasoning: null,
		supersedesId: null,
		sourceSkillId: null,
		sourceRevision: null,
		visibility: "org",
		agentSkillsFormat: null,
		r2Path: null,
		appId: null,
		toolIds: null,
		summary: null,
		tags: [],
		audience: null,
		preconditions: null,
		lifecycleState: "active",
		reviewFlaggedAt: null,
		reviewFlagReason: null,
		paceLayer: "differentiation",
		createdAt: "2026-07-01T00:00:00.000Z",
		updatedAt: "2026-07-01T00:00:00.000Z",
		...overrides,
	} as SkillEntry;
}

const STORED_SCHEDULE = {
	id: "schedule-1",
	organizationId: ORG_ID,
	skillId: "skill-1",
	tediId: OWNER,
	cron: "0 2 * * *",
	params: {},
	enabled: true,
	nextFireAt: "2999-01-01T02:00:00.000Z",
};

/** The owning tedi edits its own skill over the trusted service binding. */
function ownerContext(): BaseContext {
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
		tediId: OWNER,
		tediScopes: ["mcp:skills"],
		rateLimiter: {
			limit: vi.fn(async () => ({ success: true })),
		} as unknown as RateLimit,
		url: new URL("https://api.tedix.test/rpc/skills"),
		user: undefined,
	} as BaseContext;
}

function useSkill(initial: SkillEntry) {
	let current = initial;
	mocks.getSkillEntry.mockImplementation(async () => current);
	mocks.updateSkillEntry.mockImplementation(
		async (_db: unknown, _id: string, patch: Partial<SkillEntry>) => {
			current = { ...current, ...patch } as SkillEntry;
		},
	);
}

const EDIT = {
	id: "skill-1",
	content: SCHEDULED_DOC.replace("Version 1.", "Version 2."),
	files: { "scripts/workflow.ts": "export default { version: 2 }" },
	revisionReasoning: "Fix the ingest parser.",
	validate: "skip" as const,
};

describe("skills.improve keeps a scheduled skill running", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSkillSchedule.mockResolvedValue(STORED_SCHEDULE);
		mocks.upsertSkillSchedule.mockResolvedValue(STORED_SCHEDULE);
		mocks.deleteSkillSchedule.mockResolvedValue(undefined);
	});

	it.each(["active", "proven"] as const)(
		"an edit of a %s skill stays %s, bumps the revision and keeps the schedule",
		async (lifecycleState) => {
			useSkill(skillFixture({ lifecycleState }));
			const client = createRouterClient(skillsContractRouter, {
				context: ownerContext(),
			});

			const { entry } = await client.improve(EDIT);

			expect(entry).toMatchObject({ lifecycleState, revision: 8 });
			const patch = mocks.updateSkillEntry.mock.calls[0]![2];
			expect(patch).not.toHaveProperty("lifecycleState");
			expect(mocks.deleteSkillSchedule).not.toHaveBeenCalled();
			expect(mocks.upsertSkillSchedule).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					skillId: "skill-1",
					cron: "0 2 * * *",
					enabled: true,
					// The pending fire time survives the edit.
					nextFireAt: STORED_SCHEDULE.nextFireAt,
				}),
			);
		},
	);

	it("an edit of a draft pauses its schedule", async () => {
		useSkill(skillFixture({ lifecycleState: "draft" }));
		const client = createRouterClient(skillsContractRouter, {
			context: ownerContext(),
		});

		const { entry } = await client.improve(EDIT);

		expect(entry.lifecycleState).toBe("draft");
		expect(mocks.deleteSkillSchedule).not.toHaveBeenCalled();
		expect(mocks.upsertSkillSchedule).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				skillId: "skill-1",
				cron: "0 2 * * *",
				enabled: false,
			}),
		);
	});

	it("activation restores the manifest schedule after a draft pause", async () => {
		const { syncSkillScheduleProjection } =
			await import("./cognitive-skill-shared");
		const policy = { cron: "0 2 * * *", params: {}, enabled: true };
		await syncSkillScheduleProjection(
			ownerContext(),
			skillFixture({ lifecycleState: "draft" }),
			policy,
		);
		expect(mocks.upsertSkillSchedule).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({ enabled: false }),
		);
		mocks.getSkillSchedule.mockResolvedValue({
			...STORED_SCHEDULE,
			enabled: false,
		});
		await syncSkillScheduleProjection(
			ownerContext(),
			skillFixture({ lifecycleState: "active" }),
			policy,
		);
		expect(mocks.upsertSkillSchedule).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({ enabled: true }),
		);
	});

	it("a new draft still gets no schedule", async () => {
		mocks.getSkillSchedule.mockResolvedValue(undefined);
		useSkill(skillFixture({ lifecycleState: "draft", successCount: 0 }));
		const client = createRouterClient(skillsContractRouter, {
			context: ownerContext(),
		});

		await client.improve(EDIT);

		expect(mocks.upsertSkillSchedule).not.toHaveBeenCalled();
		expect(mocks.deleteSkillSchedule).toHaveBeenCalledWith(
			expect.anything(),
			"skill-1",
		);
	});

	it("an edit with an invalid schedule is rejected and nothing changes", async () => {
		useSkill(skillFixture());
		const client = createRouterClient(skillsContractRouter, {
			context: ownerContext(),
		});

		await expect(
			client.improve({
				...EDIT,
				content: SCHEDULED_DOC.replace(
					'cron: "0 2 * * *"',
					'cron: "0 2 * * *"\n    timezone: Europe/Berlin',
				),
			}),
		).rejects.toThrow(/schedule validation failed/i);
		expect(mocks.updateSkillEntry).not.toHaveBeenCalled();
		expect(mocks.upsertSkillSchedule).not.toHaveBeenCalled();
		expect(mocks.deleteSkillSchedule).not.toHaveBeenCalled();
	});
});
