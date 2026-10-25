import { createRouterClient } from "@orpc/server";
import type { SkillEntry } from "@tedix/db/schema/cognitive";
import type { Tedi } from "@tedix/db/schema/tedis";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

/**
 * skills.moveToTedi (move_skill_to_tedi): dry-run preconditions, refusal of a
 * real move while a check fails, the audited move itself, and moving back.
 */

const mocks = vi.hoisted(() => ({
	getSkillEntry: vi.fn(),
	getTediByIdForOrganization: vi.fn(),
	getSkillSchedule: vi.fn(),
	listInFlightSkillRuns: vi.fn(),
	moveSkillToTedi: vi.fn(),
	getAppsByOrganization: vi.fn(),
	listActiveSkillPersonalResourceDelegations: vi.fn(),
	getMemberByUserId: vi.fn(),
	runTediMcpAccessBatchOnTargets: vi.fn(),
	getAssignedAppRoles: vi.fn(),
}));

vi.mock("@tedix/db/queries/cognitive/skill-crud", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/cognitive/skill-crud")
	>()),
	getSkillEntry: mocks.getSkillEntry,
}));
vi.mock("@tedix/db/queries/tedis", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/tedis")>()),
	getTediByIdForOrganization: mocks.getTediByIdForOrganization,
}));
vi.mock("@tedix/db/queries/skill-schedules", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/skill-schedules")
	>()),
	getSkillSchedule: mocks.getSkillSchedule,
}));
vi.mock("@tedix/db/queries/skill-ownership", () => ({
	listInFlightSkillRuns: mocks.listInFlightSkillRuns,
	moveSkillToTedi: mocks.moveSkillToTedi,
}));
vi.mock("@tedix/db/queries/apps", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/apps")>()),
	getAppsByOrganization: mocks.getAppsByOrganization,
}));
vi.mock(
	"@tedix/db/queries/personal-resource-delegations",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@tedix/db/queries/personal-resource-delegations")
		>()),
		listActiveSkillPersonalResourceDelegations:
			mocks.listActiveSkillPersonalResourceDelegations,
	}),
);
vi.mock("@tedix/db/queries/organization-members", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/organization-members")
	>()),
	getMemberByUserId: mocks.getMemberByUserId,
}));
vi.mock("../../services/tedi-mcp-access", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../services/tedi-mcp-access")>()),
	runTediMcpAccessBatchOnTargets: mocks.runTediMcpAccessBatchOnTargets,
}));
vi.mock("@tedix/auth/fga", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/auth/fga")>()),
	getAssignedAppRoles: mocks.getAssignedAppRoles,
}));

import { skillsContractRouter } from "./cognitive";

const ORG = "org-1";
const SOURCE = "tedi-source";
const TARGET = "tedi-target";

const doc = (mcp: string) =>
	`---\nname: watcher\ncapabilities:\n  schedule:\n    cron: "0 7 * * *"\n  mcp:\n${mcp}---\n# Watcher\n`;

function skill(overrides: Partial<SkillEntry> = {}): SkillEntry {
	return {
		id: "skill-1",
		organizationId: ORG,
		tediId: SOURCE,
		title: "Account watcher",
		slug: "account-watcher",
		content: doc("    os:\n      - read_output\n"),
		files: { "scripts/workflow.ts": "export default {}" },
		revision: 14,
		lifecycleState: "active",
		mcpAppBindings: null,
		...overrides,
	} as SkillEntry;
}

function tedi(id: string, overrides: Partial<Tedi> = {}): Tedi {
	return {
		id,
		organizationId: ORG,
		name: id === TARGET ? "Operator" : "Assistant",
		slug: id === TARGET ? "operator" : "assistant",
		status: "active",
		retiredAt: null,
		descopeUserId: `descope-${id}`,
		...overrides,
	} as Tedi;
}

const SCHEDULE = {
	id: "schedule-1",
	organizationId: ORG,
	skillId: "skill-1",
	tediId: SOURCE,
	cron: "0 7 * * *",
	params: { mode: "daily" },
	enabled: true,
	nextFireAt: "2026-10-26T07:00:00.000Z",
};

const GATEWAY = {
	id: "app-gw",
	slug: "acme-unified",
	organizationId: ORG,
	metadata: {
		mcpConfig: {
			authMode: "authenticated",
			codeMode: true,
			aggregateApps: ["x"],
			aggregateTedis: [{ slug: "assistant", surface: "full" }],
		},
	},
};

function context(overrides: Partial<BaseContext> = {}): BaseContext {
	return {
		authType: "apikey",
		apiKey: { id: "key-1", name: "operator", scopes: ["tedis:write"] },
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORG,
		rateLimiter: {
			limit: vi.fn(async () => ({ success: true })),
		} as unknown as RateLimit,
		url: new URL("https://api.tedix.test/rpc/skills"),
		user: undefined,
		...overrides,
	} as BaseContext;
}

const client = (ctx: BaseContext = context()) =>
	createRouterClient(skillsContractRouter, { context: ctx });

let current: SkillEntry;

beforeEach(() => {
	vi.clearAllMocks();
	current = skill();
	mocks.getSkillEntry.mockImplementation(async () => current);
	mocks.getTediByIdForOrganization.mockImplementation(async (_db, id) =>
		id === SOURCE || id === TARGET ? tedi(id) : undefined,
	);
	mocks.getSkillSchedule.mockResolvedValue(SCHEDULE);
	mocks.listInFlightSkillRuns.mockResolvedValue([]);
	mocks.getAppsByOrganization.mockResolvedValue([GATEWAY]);
	mocks.listActiveSkillPersonalResourceDelegations.mockResolvedValue([]);
	mocks.runTediMcpAccessBatchOnTargets.mockResolvedValue({
		items: [{ validation: { status: "valid", role: "operator" } }],
	});
	mocks.getAssignedAppRoles.mockResolvedValue({});
	mocks.moveSkillToTedi.mockImplementation(async (_db, params) => {
		current = { ...current, tediId: params.toTediId };
		return {
			moved: true,
			auditEventId: "audit-1",
			schedule: { ...SCHEDULE, tediId: params.toTediId },
		};
	});
});

describe("skills.moveToTedi", () => {
	it("dry-runs by default and changes nothing", async () => {
		const result = await client().moveToTedi({
			skillId: "skill-1",
			targetTediId: TARGET,
		});

		expect(result).toMatchObject({
			status: "ready",
			dryRun: true,
			from: { tediId: SOURCE, name: "Assistant" },
			to: { tediId: TARGET, name: "Operator", slug: "operator" },
			schedule: { before: SCHEDULE, after: null },
			blockers: [],
			rollback: null,
		});
		expect(result.checks.map((check) => check.id)).toEqual([
			"target_tedi",
			"runs_in_flight",
			"tedi_namespace",
			"gateway_access",
			"app_access",
			"personal_resources",
			"source_references",
			"schedule",
		]);
		expect(mocks.moveSkillToTedi).not.toHaveBeenCalled();
	});

	it("reports every blocker in a dry run", async () => {
		current = skill({
			content: doc("    tedi:\n      - run_tedi_turn\n"),
		});
		mocks.listInFlightSkillRuns.mockResolvedValue([
			{ id: "run-9", tediId: SOURCE, status: "running", startedAt: null },
		]);
		mocks.listActiveSkillPersonalResourceDelegations.mockResolvedValue([
			{ id: "delegation-1" },
		]);

		const result = await client().moveToTedi({
			skillId: "skill-1",
			targetTediId: TARGET,
		});

		expect(result.status).toBe("blocked");
		const failed = result.checks
			.filter((check) => check.status === "fail")
			.map((check) => check.id);
		expect(failed).toEqual([
			"runs_in_flight",
			"tedi_namespace",
			"personal_resources",
		]);
		expect(result.blockers.join(" ")).toContain("run-9 (running)");
		expect(result.blockers.join(" ")).toContain("aggregateTedis");
	});

	it("refuses a real move while a check fails and writes nothing", async () => {
		mocks.getTediByIdForOrganization.mockImplementation(async (_db, id) =>
			id === TARGET
				? tedi(TARGET, { status: "paused" })
				: id === SOURCE
					? tedi(SOURCE)
					: undefined,
		);

		await expect(
			client().moveToTedi({
				skillId: "skill-1",
				targetTediId: TARGET,
				dryRun: false,
			}),
		).rejects.toThrow(/SKILL_MOVE_BLOCKED.*Operator is paused/);
		expect(mocks.moveSkillToTedi).not.toHaveBeenCalled();
	});

	it("refuses a target outside the organization", async () => {
		await expect(
			client().moveToTedi({ skillId: "skill-1", targetTediId: "elsewhere" }),
		).rejects.toThrow(/Target tedi not found/);
	});

	it("moves the skill and schedule with an audit event, and moves them back", async () => {
		const moved = await client().moveToTedi({
			skillId: "skill-1",
			targetTediId: TARGET,
			dryRun: false,
			reason: "cut over to the operator",
		});

		expect(moved).toMatchObject({
			status: "moved",
			auditEventId: "audit-1",
			schedule: {
				before: SCHEDULE,
				after: { tediId: TARGET, cron: "0 7 * * *" },
			},
			rollback: {
				skillId: "skill-1",
				targetTediId: SOURCE,
				dryRun: false,
				mode: "transfer",
			},
		});
		expect(mocks.moveSkillToTedi).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				organizationId: ORG,
				skillId: "skill-1",
				fromTediId: SOURCE,
				toTediId: TARGET,
				audit: expect.objectContaining({
					actorId: "key-1",
					actorType: "api_key",
					action: "skill.owner_moved",
					metadata: expect.objectContaining({
						fromTediId: SOURCE,
						toTediId: TARGET,
						scheduleId: "schedule-1",
						cron: "0 7 * * *",
						nextFireAt: "2026-10-26T07:00:00.000Z",
						reason: "cut over to the operator",
					}),
				}),
			}),
		);

		const back = await client().moveToTedi(moved.rollback!);
		expect(back).toMatchObject({
			status: "moved",
			from: { tediId: TARGET },
			to: { tediId: SOURCE },
			rollback: { targetTediId: TARGET },
		});
		expect(current.tediId).toBe(SOURCE);
	});

	it("reports a lost race as a conflict", async () => {
		mocks.moveSkillToTedi.mockResolvedValue({
			moved: false,
			auditEventId: null,
			schedule: SCHEDULE,
		});
		await expect(
			client().moveToTedi({
				skillId: "skill-1",
				targetTediId: TARGET,
				dryRun: false,
			}),
		).rejects.toThrow(/SKILL_MOVE_CONFLICT/);
	});

	describe("authority", () => {
		const tediContext = (tediId: string, scopes = ["mcp:skills"]) =>
			context({
				authType: "service-binding",
				apiKey: undefined,
				tediId,
				tediScopes: scopes,
				headers: new Headers({
					"X-Service-Binding": "true",
					"X-Tedix-Mcp-Tool-Id": "skills:moveToTedi",
				}),
			});

		it("lets the owning tedi hand its skill over", async () => {
			await expect(
				client(tediContext(SOURCE)).moveToTedi({
					skillId: "skill-1",
					targetTediId: TARGET,
				}),
			).resolves.toMatchObject({ status: "ready" });
		});

		it("refuses another tedi that does not own the skill", async () => {
			await expect(
				client(tediContext("tedi-stranger")).moveToTedi({
					skillId: "skill-1",
					targetTediId: TARGET,
				}),
			).rejects.toThrow(/SKILL_MOVE_FORBIDDEN/);
		});

		it("lets the organization's admin operator tedi move it", async () => {
			await expect(
				client(
					tediContext("tedi-admin", ["mcp:skills", "mcp:settings.admin"]),
				).moveToTedi({ skillId: "skill-1", targetTediId: TARGET }),
			).resolves.toMatchObject({ status: "ready" });
		});

		it("accepts a Home write only for an active owner or admin", async () => {
			const home = context({
				authType: "service-binding",
				apiKey: undefined,
				descopeUserId: "user-admin",
				// A Home call is bound to the member's own tedi, not the owner.
				tediId: "tedi-member-primary",
				tediScopes: ["mcp:skills"],
				headers: new Headers({
					"X-Service-Binding": "true",
					"X-Tedix-Mcp-Tool-Id": "skills:moveToTedi",
				}),
			});
			mocks.getMemberByUserId.mockResolvedValueOnce({
				role: "admin",
				status: "active",
			});
			await expect(
				client(home).moveToTedi({
					skillId: "skill-1",
					targetTediId: TARGET,
					dryRun: false,
				}),
			).resolves.toMatchObject({ status: "moved" });
			expect(mocks.moveSkillToTedi).toHaveBeenLastCalledWith(
				expect.anything(),
				expect.objectContaining({
					audit: expect.objectContaining({
						actorId: "user-admin",
						actorType: "user",
					}),
				}),
			);

			mocks.getMemberByUserId.mockResolvedValueOnce({
				role: "member",
				status: "active",
			});
			await expect(
				client(home).moveToTedi({
					skillId: "skill-1",
					targetTediId: SOURCE,
				}),
			).rejects.toThrow(/SKILL_MOVE_FORBIDDEN/);
		});
	});
});
