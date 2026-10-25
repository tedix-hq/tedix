import type { DbClient } from "@tedix/db/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	findSkillsByReference: vi.fn(),
	getTedisByOrganization: vi.fn(),
}));
vi.mock("@tedix/db/queries/skill-ownership", () => ({
	findSkillsByReference: mocks.findSkillsByReference,
}));
vi.mock("@tedix/db/queries/tedis", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/tedis")>()),
	getTedisByOrganization: mocks.getTedisByOrganization,
}));

import {
	directSkillMoveKernelResult,
	parseSkillMoveRequest,
	resolveDirectSkillMove,
} from "./direct-skill-move";
import { canonicalWriteToolName, correctWriteRoute } from "./write-tool-intent";

const db = {} as DbClient;
const ORG = "org-1";

describe("parseSkillMoveRequest", () => {
	it.each([
		[
			"Move the skill account watcher to the Ops tedi",
			{ skill: "account watcher", tedi: ["Ops tedi", "Ops"] },
		],
		[
			"copy the account watcher skill from My Tedi to Reddit Ops",
			{ skill: "account watcher", tedi: ["Reddit Ops"] },
		],
		[
			'transfer skill "pricing research" over to My Tedi.',
			{ skill: "pricing research", tedi: ["My Tedi", "My"] },
		],
		[
			"please hand over skill 11111111-1111-4111-8111-111111111111 to tedi ops-operator",
			{
				skill: "11111111-1111-4111-8111-111111111111",
				tedi: ["tedi ops-operator", "ops-operator"],
			},
		],
		[
			"[[tedix-context:workspace:w1:Ops]]\n\nMove skill watcher to Ops",
			{ skill: "watcher", tedi: ["Ops"] },
		],
	])("reads %j", (content, expected) => {
		expect(parseSkillMoveRequest(content)).toEqual(expected);
	});

	it.each([
		"How do I move a skill to another tedi?",
		"Move the document to the archive",
		"Move the three reddit skills to Ops",
		"Rename skill watcher to Ops watcher",
		"what happens if I move skill watcher to Ops",
	])("ignores %j", (content) => {
		expect(parseSkillMoveRequest(content)).toBeNull();
	});
});

describe("resolveDirectSkillMove", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findSkillsByReference.mockResolvedValue([
			{
				id: "skill-1",
				slug: "watcher",
				title: "Account watcher",
				tediId: "t1",
			},
		]);
		mocks.getTedisByOrganization.mockResolvedValue([
			{ id: "t1", slug: "assistant-1", name: "My Tedi", retiredAt: null },
			{
				id: "t2",
				slug: "reddit-operator",
				name: "Reddit Operator",
				retiredAt: null,
			},
			{ id: "t3", slug: "old-ops", name: "Ops", retiredAt: "2026-01-01" },
		]);
	});

	it("resolves one skill and one live tedi to the exact move call", async () => {
		const move = await resolveDirectSkillMove(db, {
			organizationId: ORG,
			content: "Move the account watcher skill to Reddit Operator",
		});
		expect(mocks.findSkillsByReference).toHaveBeenCalledWith(db, {
			organizationId: ORG,
			reference: "account watcher",
			limit: 2,
		});
		expect(move).toEqual({
			intent: {
				capability: "skills.move_to_tedi",
				toolName: "skills.move_skill_to_tedi",
				args: {
					skillId: "skill-1",
					targetTediId: "t2",
					dryRun: false,
					mode: "transfer",
				},
			},
			skillTitle: "Account watcher",
			tediName: "Reddit Operator",
		});
	});

	it("keeps a tedi whose name ends in 'Tedi'", async () => {
		const move = await resolveDirectSkillMove(db, {
			organizationId: ORG,
			content: "move skill watcher back to My Tedi",
		});
		expect(move?.intent.args.targetTediId).toBe("t1");
	});

	it("does not guess between skills or pick a retired tedi", async () => {
		mocks.findSkillsByReference.mockResolvedValueOnce([
			{ id: "a", slug: "a", title: "Watcher A", tediId: null },
			{ id: "b", slug: "b", title: "Watcher B", tediId: null },
		]);
		expect(
			await resolveDirectSkillMove(db, {
				organizationId: ORG,
				content: "move skill watcher to Reddit Operator",
			}),
		).toBeNull();
		expect(
			await resolveDirectSkillMove(db, {
				organizationId: ORG,
				content: "move skill watcher to Ops",
			}),
		).toBeNull();
	});

	it("routes as a write on the organization gateway, never a delegation", async () => {
		const move = await resolveDirectSkillMove(db, {
			organizationId: ORG,
			content: "transfer skill watcher to reddit-operator",
		});
		const result = directSkillMoveKernelResult(move!, "acme-unified");
		expect(result.delegation).toBeNull();
		expect(result.route).toMatchObject({
			routeKind: "propose_tool_write",
			targetTediId: null,
			toolIntent: {
				appSlug: "acme-unified",
				capability: "skills.move_to_tedi",
			},
		});
		expect(canonicalWriteToolName("skills.move_to_tedi")).toBe(
			"skills.move_skill_to_tedi",
		);
		const corrected = correctWriteRoute(
			{
				routeKind: "propose_tool_write",
				toolIntent: { capability: "skills.copy" },
			},
			"transfer skill watcher to reddit-operator",
			null,
			move!.intent,
		);
		expect(corrected.toolIntent.capability).toBe("skills.move_to_tedi");
	});
});
