import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import {
	type SkillEntry,
	skillEntries,
	skillSchedules,
} from "@tedix/db/schema/cognitive";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { dispatcherHealthReports } from "@tedix/db/schema/dispatcher-health";
import {
	osWorkspaceResources,
	osWorkspaces,
} from "@tedix/db/schema/os-workspaces";
import { projects } from "@tedix/db/schema/projects";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { userContext, apiKeyContext } from "../test-context";

/**
 * Editing a scheduled skill with skills.improve (improve_skills) creates a new
 * revision and preserves lifecycle. Existing draft schedules pause until
 * activation; new drafts still get none.
 */

const mocks = vi.hoisted(() => ({
	getSkillEntry: vi.fn(),
	updateSkillEntry: vi.fn(),
	deleteSkillSchedule: vi.fn(),
	pauseSkillSchedule: vi.fn(),
	getSkillSchedule: vi.fn(),
	upsertSkillSchedule: vi.fn(),
	listFactoryHealth: vi.fn(),
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
	pauseSkillSchedule: mocks.pauseSkillSchedule,
	getSkillSchedule: mocks.getSkillSchedule,
	upsertSkillSchedule: mocks.upsertSkillSchedule,
}));

import { skillsContractRouter } from "./cognitive";
import { archiveFactoryProcedure } from "./project-factories";

vi.mock("@tedix/db/queries/factories", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/factories")>()),
	listFactoryHealth: mocks.listFactoryHealth,
}));

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

	it("removes the manifest schedule and its timer without rewriting the workflow", async () => {
		const files = {
			"scripts/workflow.ts":
				"export default { async run(event, step) { return { ok: true }; } };",
		};
		useSkill(skillFixture({ files }));
		const h = humanContext("owner");
		try {
			const client = createRouterClient(skillsContractRouter, {
				context: h.context,
			});
			expect(await client.removeSchedule({ id: "skill-1" })).toEqual({
				skillId: "skill-1",
				removed: true,
			});
			const updated = await mocks.getSkillEntry(
				h.context.db,
				"skill-1",
				ORG_ID,
			);
			expect(updated.content).not.toContain("schedule:");
			expect(updated.content).toContain("Version 1.");
			expect(updated.files).toEqual(files);
			expect(updated.revision).toBe(8);
			expect(mocks.deleteSkillSchedule).toHaveBeenCalledWith(
				h.context.db,
				"skill-1",
				ORG_ID,
			);
			mocks.getSkillSchedule.mockResolvedValue(undefined);
			expect(await client.removeSchedule({ id: "skill-1" })).toEqual({
				skillId: "skill-1",
				removed: false,
			});
			expect((await mocks.getSkillEntry()).revision).toBe(8);
		} finally {
			h.sqlite.close();
		}
	});

	it("refuses schedule removal by a member", async () => {
		useSkill(skillFixture());
		const h = humanContext("member");
		try {
			const client = createRouterClient(skillsContractRouter, {
				context: h.context,
			});
			await expect(
				client.removeSchedule({ id: "skill-1" }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.updateSkillEntry).not.toHaveBeenCalled();
			expect(mocks.deleteSkillSchedule).not.toHaveBeenCalled();
		} finally {
			h.sqlite.close();
		}
	});

	it.each(["draft", "active", "proven"] as const)(
		"keeps a %s improvement copy off the schedule",
		async (lifecycleState) => {
			const { syncSkillScheduleProjection } =
				await import("./cognitive-skill-shared");
			await syncSkillScheduleProjection(
				ownerContext(),
				skillFixture({
					lifecycleState,
					tags: ["workflow-improvement"],
					sourceSkillId: "canonical",
				}),
				{
					cron: "0 2 * * *",
					params: {},
					enabled: true,
					executionKind: "deterministic",
				},
			);
			expect(mocks.upsertSkillSchedule).not.toHaveBeenCalled();
		},
	);

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

	it("migrates a stored UTC fire when an edit declares local slots without changing cron", async () => {
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-25T18:00:00Z"));
		try {
			useSkill(skillFixture());
			mocks.getSkillSchedule.mockResolvedValue({
				...STORED_SCHEDULE,
				nextFireAt: "2026-11-26T02:00:00.000Z",
			});
			const client = createRouterClient(skillsContractRouter, {
				context: ownerContext(),
			});
			await client.improve({
				...EDIT,
				content: EDIT.content.replace(
					"capabilities:",
					'runsAt: {timeZone: Europe/Berlin, times: ["09:00"]}\ncapabilities:',
				),
			});
			expect(mocks.upsertSkillSchedule).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					cron: "0 2 * * *",
					nextFireAt: "2026-11-26T08:00:00.000Z",
				}),
			);
		} finally {
			vi.restoreAllMocks();
		}
	});

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

function humanContext(role: string, status = "active") {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(organizationMembers));
	sqlite
		.prepare(
			"INSERT INTO organization_members (id, organization_id, user_id, descope_user_id, email, role, status) VALUES ('membership-1', ?, 'human-1', 'subject-1', 'person@example.test', ?, ?)",
		)
		.run(ORG_ID, role, status);
	return {
		sqlite,
		context: userContext({
			env: {
				ENVIRONMENT: "test",
				DB: createD1Facade(sqlite),
			} as unknown as CloudflareEnv,
			organizationId: ORG_ID,
			sub: "subject-1",
			permissions: ["tedis:update"],
			roles: ["owner"],
		}),
	};
}

const REACTIVATE = {
	id: "skill-1",
	lifecycleState: "active" as const,
	force: true,
	revisionReasoning:
		"Owner reviewed the repaired gateway and turned the skill back on.",
};

describe("skills.improve draft reactivation is a human owner/admin decision", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useSkill(
			skillFixture({
				lifecycleState: "draft",
				failureCount: 4,
				files: {
					"scripts/workflow.ts":
						"export default { async run(event, step) { return { ok: true }; } };",
				},
			}),
		);
		mocks.getSkillSchedule.mockResolvedValue({
			...STORED_SCHEDULE,
			enabled: false,
		});
	});

	it.each(["owner", "admin"])(
		"allows an active %s and resumes the paused schedule",
		async (role) => {
			const h = humanContext(role);
			try {
				const client = createRouterClient(skillsContractRouter, {
					context: h.context,
				});
				const { entry } = await client.improve(REACTIVATE);
				expect(entry).toMatchObject({
					lifecycleState: "active",
					revision: 8,
					failureCount: 4,
				});
				expect(mocks.updateSkillEntry).toHaveBeenCalledWith(
					expect.anything(),
					"skill-1",
					expect.objectContaining({
						lifecycleState: "active",
						revisionReasoning: REACTIVATE.revisionReasoning,
					}),
					{ force: true, forceAuthority: { kind: "operator" } },
				);
				expect(mocks.upsertSkillSchedule).toHaveBeenCalledWith(
					expect.anything(),
					expect.objectContaining({
						enabled: true,
						cron: STORED_SCHEDULE.cron,
						nextFireAt: STORED_SCHEDULE.nextFireAt,
					}),
				);
			} finally {
				h.sqlite.close();
			}
		},
	);

	it.each([
		["member", "active"],
		["owner", "suspended"],
	])(
		"refuses persisted %s/%s despite owner token claims",
		async (role, status) => {
			const h = humanContext(role, status);
			try {
				const client = createRouterClient(skillsContractRouter, {
					context: h.context,
				});
				await expect(client.improve(REACTIVATE)).rejects.toMatchObject({
					code: "FORBIDDEN",
				});
				expect(mocks.updateSkillEntry).not.toHaveBeenCalled();
				expect(mocks.upsertSkillSchedule).not.toHaveBeenCalled();
			} finally {
				h.sqlite.close();
			}
		},
	);

	it.each(["service-binding", "tedi", "apikey"] as const)(
		"refuses %s even with force and the owning tedi",
		async (authType) => {
			const context =
				authType === "apikey"
					? apiKeyContext({ organizationId: ORG_ID, scopes: ["mcp:skills"] })
					: { ...ownerContext(), authType };
			const client = createRouterClient(skillsContractRouter, { context });
			await expect(client.improve(REACTIVATE)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			expect(mocks.updateSkillEntry).not.toHaveBeenCalled();
			expect(mocks.upsertSkillSchedule).not.toHaveBeenCalled();
		},
	);

	it("refuses agent activation without force too", async () => {
		const client = createRouterClient(skillsContractRouter, {
			context: ownerContext(),
		});
		await expect(
			client.improve({ ...REACTIVATE, force: false }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.updateSkillEntry).not.toHaveBeenCalled();
	});
});

describe("forwarded human identity cannot reactivate for an agent", () => {
	it.each([
		{ tediId: "tedi-owner" },
		{ externalAgentPrincipalId: "external-agent" },
	])("rejects %j", async (identity) => {
		vi.clearAllMocks();
		useSkill(skillFixture({ lifecycleState: "draft" }));
		const h = humanContext("owner");
		try {
			const client = createRouterClient(skillsContractRouter, {
				context: { ...h.context, ...identity },
			});
			await expect(client.improve(REACTIVATE)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			expect(mocks.updateSkillEntry).not.toHaveBeenCalled();
			expect(mocks.upsertSkillSchedule).not.toHaveBeenCalled();
		} finally {
			h.sqlite.close();
		}
	});
});

describe("archive persistence through skill actions", () => {
	it.each([
		{ action: "improve", legacy: false },
		{ action: "rejectWorkshop", legacy: false },
		{ action: "improve", legacy: true },
		{ action: "rejectWorkshop", legacy: true },
		{ action: "archive", legacy: false },
		{ action: "archiveMany", legacy: false },
		{ action: "archiveFactoryPaused", legacy: false },
		{ action: "archiveFactoryActive", legacy: false },
		{ action: "archiveFactoryShared", legacy: false },
		{ action: "archiveFactoryRunner", legacy: false },
	])(
		"$action preserves archive safety and schedule policy (legacy manifest: $legacy)",
		async ({ action, legacy }) => {
			vi.clearAllMocks();
			const h = humanContext("owner");
			try {
				h.sqlite.exec(schemaDdl(skillEntries));
				h.sqlite.exec(schemaDdl(skillSchedules));
				h.sqlite.exec(
					schemaDdl(
						dispatcherHealthReports,
						projects,
						osWorkspaces,
						osWorkspaceResources,
					),
				);
				h.sqlite.exec(`
					CREATE TABLE tedis (id TEXT PRIMARY KEY, organization_id TEXT, policy_pack_id TEXT, name TEXT, display_name TEXT);
					CREATE TABLE policy_packs (id TEXT PRIMARY KEY, organization_id TEXT, definition TEXT);
					CREATE TABLE skill_runs (id TEXT PRIMARY KEY, organization_id TEXT, skill_id TEXT, skill_revision INTEGER, status TEXT, result TEXT);
					CREATE TABLE skill_run_artifacts (id TEXT PRIMARY KEY, run_id TEXT, path TEXT, outcome TEXT, attempt INTEGER NOT NULL DEFAULT 1);
					INSERT INTO tedis VALUES ('tedi-owner', 'org-1', 'policy-1', 'owner', NULL);
					INSERT INTO policy_packs VALUES ('policy-1', 'org-1', '{"paceLayerPolicy":{"differentiation":{"evalRequired":false}}}');
				`);
				await h.context.db.insert(skillEntries).values(
					skillFixture({
						lifecycleState: "active",
						files: {
							"scripts/workflow.ts":
								"export default { async run(event, step) { return { ok: true }; } };",
						},
					}),
				);
				await h.context.db.insert(skillSchedules).values({
					...STORED_SCHEDULE,
					organizationId: ORG_ID,
					enabled:
						!action.startsWith("archiveFactory") ||
						action === "archiveFactoryActive",
				});
				if (action.startsWith("archiveFactory")) {
					const project = {
						id: "factory-project",
						orgId: ORG_ID,
						key: "FACTORY",
						name: "Nightly ingest",
						createdAt: new Date().toISOString(),
						metadata: {
							factory: { slug: "nightly-ingest", skillId: "skill-1" },
						},
					};
					await h.context.db.insert(projects).values(project);
					mocks.listFactoryHealth.mockResolvedValue([
						{
							slug: "nightly-ingest",
							skillId: "skill-1",
							projectId: "delivery-project",
						},
					]);
					if (action === "archiveFactoryShared")
						await h.context.db.insert(projects).values({
							...project,
							id: "other-factory",
							key: "OTHER",
							name: "Other factory",
						});
					if (action === "archiveFactoryRunner")
						await h.context.db.insert(dispatcherHealthReports).values({
							orgId: ORG_ID,
							reporterId: "test-machine",
							machineName: "test-machine",
							executor: "test",
							lane: "test",
							running: true,
							observedAt: new Date().toISOString(),
							reportedAt: new Date().toISOString(),
							rulesSkillId: "skill-1",
						});
				}
				const crud = await vi.importActual<
					typeof import("@tedix/db/queries/cognitive/skill-crud")
				>("@tedix/db/queries/cognitive/skill-crud");
				mocks.getSkillEntry.mockImplementation(crud.getSkillEntry);
				mocks.updateSkillEntry.mockImplementation(crud.updateSkillEntry);
				const schedules = await vi.importActual<
					typeof import("@tedix/db/queries/skill-schedules")
				>("@tedix/db/queries/skill-schedules");
				mocks.getSkillSchedule.mockImplementation(schedules.getSkillSchedule);
				mocks.upsertSkillSchedule.mockImplementation(
					schedules.upsertSkillSchedule,
				);
				mocks.pauseSkillSchedule.mockImplementation(
					schedules.pauseSkillSchedule,
				);
				const client = createRouterClient(skillsContractRouter, {
					context: h.context,
				});
				if (action.startsWith("archiveFactory")) {
					const factories = createRouterClient(
						{ archive: archiveFactoryProcedure },
						{ context: h.context },
					);
					const call = factories.archive({ factory: "nightly-ingest" });
					if (
						action === "archiveFactoryShared" ||
						action === "archiveFactoryRunner"
					) {
						await expect(call).rejects.toMatchObject({
							code: "CONFLICT",
							message: expect.stringContaining(
								action === "archiveFactoryShared"
									? '["factory:factory-project","factory:other-factory"]'
									: '["runner:test-machine"]',
							),
						});
						expect(mocks.updateSkillEntry).not.toHaveBeenCalled();
						expect(mocks.pauseSkillSchedule).not.toHaveBeenCalled();
						expect(
							(await crud.getSkillEntry(h.context.db, "skill-1", ORG_ID))
								?.lifecycleState,
						).toBe("active");
						return;
					}
					expect(await call).toMatchObject({
						action: "archived",
						scheduleEnabled: false,
						nextFireAt: null,
					});
				} else if (action === "improve")
					await client.improve({
						id: "skill-1",
						lifecycleState: "archived",
						// Its own schedule is a user; archiving names what will stop.
						acknowledgeUsedBy: [`schedule:${STORED_SCHEDULE.id}`],
						validate: "skip",
					});
				else if (action === "archive")
					await client.archive({
						id: "skill-1",
						acknowledgeUsedBy: [`schedule:${STORED_SCHEDULE.id}`],
					});
				else if (action === "archiveMany") {
					await h.context.db.insert(skillEntries).values(
						skillFixture({
							id: "skill-2",
							slug: "second-skill",
							lifecycleState: "active",
							content: "# Second skill",
							files: {},
						}),
					);
					await client.archiveMany({
						skills: [
							{
								id: "skill-1",
								acknowledgeUsedBy: [`schedule:${STORED_SCHEDULE.id}`],
							},
							{ id: "skill-2" },
						],
					});
					expect(
						(await crud.getSkillEntry(h.context.db, "skill-2", ORG_ID))
							?.lifecycleState,
					).toBe("archived");
				} else
					await client.rejectWorkshop({
						id: "skill-1",
						reason: "Keep the canonical skill",
					});
				const entry = await crud.getSkillEntry(h.context.db, "skill-1", ORG_ID);
				expect(entry).toMatchObject({
					lifecycleState: "archived",
					revision: 8,
				});
				expect(entry?.content).toContain("enabled: false");
				expect(
					h.sqlite.prepare("SELECT enabled FROM skill_schedules").get(),
				).toEqual({ enabled: 0 });
				if (legacy)
					h.sqlite
						.prepare(
							"UPDATE skill_entries SET content = ? WHERE id = 'skill-1'",
						)
						.run(SCHEDULED_DOC);
				const fullRestore = action === "archive" || action === "archiveMany";
				if (fullRestore) {
					await client.restore({ id: "skill-1" });
					const restored = await crud.getSkillEntry(
						h.context.db,
						"skill-1",
						ORG_ID,
					);
					expect(restored?.content).toBe(SCHEDULED_DOC);
					expect(restored?.archivedFrom).toBeNull();
					expect(restored?.paceLayer).toBe("differentiation");
				} else
					await client.improve({
						id: "skill-1",
						lifecycleState: "active",
						...(legacy ? { content: SCHEDULED_DOC } : {}),
						force: true,
						validate: "skip",
					});
				expect(
					(await crud.getSkillEntry(h.context.db, "skill-1", ORG_ID))
						?.lifecycleState,
				).toBe("active");
				expect(
					(await schedules.getSkillSchedule(h.context.db, "skill-1", ORG_ID))
						?.enabled,
				).toBe(fullRestore);
			} finally {
				h.sqlite.close();
			}
		},
	);
});
