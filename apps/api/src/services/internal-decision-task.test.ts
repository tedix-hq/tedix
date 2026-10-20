import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { call } from "@orpc/server";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { getDecisionLearningConfig } from "@tedix/db/queries/decision-learning";
import {
	getWorkItemById,
	getWorkItemBySourceIntentId,
} from "@tedix/db/queries/work-items/crud";
import type { BaseContext } from "../rpc/orpc";
import { readOrgDispatchPolicyLayer } from "../rpc/routers/kernel/tedi-capabilities";
import { verifiedActiveWorkActor } from "../rpc/routers/work-items-principal";
import { executeInternalDecisionTask } from "./internal-decision-task";

vi.mock("@orpc/server", async (original) => ({
	...(await original<typeof import("@orpc/server")>()),
	call: vi.fn(),
}));
vi.mock("@tedix/db/queries/decision-learning", () => ({
	getDecisionLearningConfig: vi.fn(),
}));
vi.mock("@tedix/db/queries/work-items/crud", () => ({
	getWorkItemById: vi.fn(),
	getWorkItemBySourceIntentId: vi.fn(),
}));
vi.mock("../rpc/routers/kernel/tedi-capabilities", () => ({
	readOrgDispatchPolicyLayer: vi.fn(),
}));
vi.mock("../rpc/routers/work-items-principal", () => ({
	verifiedActiveWorkActor: vi.fn(),
}));
vi.mock("../rpc/routers/work-items/creation-reads", () => ({
	createProcedure: { canonical: true },
}));

const sourceId = "00000000-0000-4000-8000-000000000001";
const effect = {
	kind: "create_owner_task" as const,
	workItemId: sourceId,
	title: "Prepare a follow-up",
	description: "Draft a follow-up for the owner to review before sending.",
};
const context = { organizationId: "org-fictional", db: {} } as BaseContext;
function fixture() {
	return {
		id: "request-1",
		orgId: "org-fictional",
		targetId: "user-fictional",
		workItemId: sourceId,
		creatorType: "tedi",
		creatorId: "tedi-fictional",
		creatorSessionId: null as string | null,
		metadata: {
			decisionDeck: DecisionEnvelopeSchema.parse({
				version: 1,
				kind: "proposal",
				classId: "crm.followup",
				proposal: "Create a follow-up task?",
				whyNow: "The project needs a draft",
				recommendation: "Prepare the task",
				reversibility: "two_way",
				protectedEffects: [],
				blastRadius: "Internal Work only",
				confidence: 0.9,
				costOfWaiting: "Draft delayed",
				reasoning: "The owner can review the draft before sending",
				options: [
					{
						id: "yes",
						label: "Create",
						intent: "approve",
						consequence: "Creates internal Work",
						cost: "None",
						effect,
					},
					{
						id: "later",
						label: "Later",
						intent: "later",
						consequence: "Wait",
						cost: "Delay",
					},
				],
			}),
		},
	};
}
const task = {
	id: "task-1",
	disposition: "proposed",
	parentWorkItemId: sourceId,
	accountableOwnerType: "user",
	accountableOwnerId: "user-fictional",
	title: effect.title,
	description: effect.description,
	metadata: {
		source: "decision-owner-task",
		requestId: "request-1",
		sendingReservedForOwner: true,
	},
} as NonNullable<Awaited<ReturnType<typeof getWorkItemBySourceIntentId>>>;
beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(verifiedActiveWorkActor).mockResolvedValue({
		type: "tedi",
		id: "tedi-fictional",
	});
	vi.mocked(readOrgDispatchPolicyLayer).mockResolvedValue({
		autonomy: { version: 1, maxRisk: "medium" },
	});
	vi.mocked(getWorkItemById).mockResolvedValue({
		id: sourceId,
		projectId: "project-fictional",
	} as NonNullable<Awaited<ReturnType<typeof getWorkItemById>>>);
	vi.mocked(getWorkItemBySourceIntentId).mockResolvedValue(null);
	vi.mocked(getDecisionLearningConfig).mockResolvedValue({
		deckCurators: [],
	} as unknown as Awaited<ReturnType<typeof getDecisionLearningConfig>>);
	vi.mocked(call).mockResolvedValue(task);
});

describe("internal task decision adapter", () => {
	it("calls canonical Work creation with agent context and reserves sending for the owner", async () => {
		expect(
			await executeInternalDecisionTask(context, fixture(), effect),
		).toEqual({
			taskId: "task-1",
			state: "proposed",
			classId: "internal.work.create",
		});
		expect(getWorkItemById).toHaveBeenCalledWith(
			context.db,
			sourceId,
			"org-fictional",
		);
		expect(call).toHaveBeenCalledWith(
			{ canonical: true },
			expect.objectContaining({
				parentWorkItemId: sourceId,
				projectId: "project-fictional",
				sourceIntentId: "decision-owner-task:request-1",
				accountableOwnerType: "user",
				accountableOwnerId: "user-fictional",
				metadata: expect.objectContaining({
					sendingReservedForOwner: true,
					handledBy: { type: "tedi", id: "tedi-fictional" },
				}),
			}),
			{ context },
		);
	});
	it("returns an existing task and recovers a concurrent creation without duplicate effects", async () => {
		vi.mocked(getWorkItemBySourceIntentId).mockResolvedValueOnce(task);
		await executeInternalDecisionTask(context, fixture(), effect);
		expect(call).not.toHaveBeenCalled();
		vi.mocked(getWorkItemBySourceIntentId)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(task);
		vi.mocked(call).mockRejectedValueOnce(new Error("unique source intent"));
		expect(
			(await executeInternalDecisionTask(context, fixture(), effect)).taskId,
		).toBe("task-1");
	});
	it("refuses a cancelled idempotent task after the recipient undid it", async () => {
		vi.mocked(getWorkItemBySourceIntentId).mockResolvedValueOnce({
			...task,
			disposition: "cancelled",
		});
		await expect(
			executeInternalDecisionTask(context, fixture(), effect),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(call).not.toHaveBeenCalled();
	});
	it.each([
		{ parentWorkItemId: "other-work" },
		{ accountableOwnerType: "tedi" },
		{ accountableOwnerId: "other-person" },
		{ title: "Spoofed title" },
		{ description: "Spoofed body" },
		{ metadata: { ...task.metadata, source: "spoofed" } },
		{ metadata: { ...task.metadata, requestId: "other-request" } },
		{ metadata: { ...task.metadata, sendingReservedForOwner: false } },
	])(
		"rejects spoofed deterministic task provenance, including concurrent winners (%j)",
		async (change) => {
			const spoofed = { ...task, ...change } as typeof task;
			vi.mocked(getWorkItemBySourceIntentId).mockResolvedValueOnce(spoofed);
			await expect(
				executeInternalDecisionTask(context, fixture(), effect),
			).rejects.toMatchObject({ code: "CONFLICT" });
			expect(call).not.toHaveBeenCalled();
			vi.mocked(getWorkItemBySourceIntentId)
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce(spoofed);
			vi.mocked(call).mockRejectedValueOnce(new Error("concurrent task"));
			await expect(
				executeInternalDecisionTask(context, fixture(), effect),
			).rejects.toMatchObject({ code: "CONFLICT" });
		},
	);
	it("preserves canonical authorization failures without a winning task", async () => {
		vi.mocked(call).mockRejectedValueOnce(
			new Error("canonical authorization denied"),
		);
		await expect(
			executeInternalDecisionTask(context, fixture(), effect),
		).rejects.toThrow("canonical authorization denied");
	});
	it("rejects human actors and organization mismatches before creation", async () => {
		await expect(
			executeInternalDecisionTask(
				context,
				{ ...fixture(), orgId: "other-org" },
				effect,
			),
		).rejects.toThrow();
		vi.mocked(verifiedActiveWorkActor).mockResolvedValueOnce({
			type: "user",
			id: "user-fictional",
		});
		await expect(
			executeInternalDecisionTask(context, fixture(), effect),
		).rejects.toThrow("owning agent");
		expect(call).not.toHaveBeenCalled();
	});
	it("requires the author or a current curator grant", async () => {
		const request = { ...fixture(), creatorId: "other-tedi" };
		await expect(
			executeInternalDecisionTask(context, request, effect),
		).rejects.toThrow("author or granted curator");
		vi.mocked(getDecisionLearningConfig).mockResolvedValueOnce({
			deckCurators: [
				{
					enabled: true,
					tediId: "tedi-fictional",
					recipientId: "user-fictional",
				},
			],
		} as unknown as Awaited<ReturnType<typeof getDecisionLearningConfig>>);
		await executeInternalDecisionTask(context, request, effect);
		expect(call).toHaveBeenCalledOnce();
	});
	it("requires matching external-agent session ownership", async () => {
		vi.mocked(verifiedActiveWorkActor).mockResolvedValue({
			type: "external_agent",
			id: "agent-fictional",
			sessionId: "session-active",
			externalSessionKey: "key",
		});
		const request = {
			...fixture(),
			creatorType: "external_agent",
			creatorId: "agent-fictional",
			creatorSessionId: "old-session",
		};
		await expect(
			executeInternalDecisionTask(context, request, effect),
		).rejects.toThrow("author or granted curator");
		request.creatorSessionId = "session-active";
		await executeInternalDecisionTask(context, request, effect);
	});
	it.each([
		null,
		{
			effect: "deny" as const,
			autonomy: { version: 1 as const, maxRisk: "medium" as const },
		},
		{
			autonomy: {
				version: 1 as const,
				maxRisk: "medium" as const,
				askForClasses: ["internal.work.create"],
			},
		},
	])(
		"fails closed for absent, denied, or corrected autonomy (%j)",
		async (layer) => {
			vi.mocked(readOrgDispatchPolicyLayer).mockResolvedValueOnce(layer);
			await expect(
				executeInternalDecisionTask(context, fixture(), effect),
			).rejects.toThrow();
			expect(call).not.toHaveBeenCalled();
		},
	);
	it("rejects modified effects, different parent, expired cards, and protected consent", async () => {
		await expect(
			executeInternalDecisionTask(context, fixture(), {
				...effect,
				title: "Changed",
			}),
		).rejects.toThrow("stored internal task");
		await expect(
			executeInternalDecisionTask(
				context,
				{ ...fixture(), workItemId: "different" },
				effect,
			),
		).rejects.toThrow("stored internal task");
		const expired = fixture();
		expired.metadata.decisionDeck.expiresAt = "2020-01-01T00:00:00.000Z";
		await expect(
			executeInternalDecisionTask(context, expired, effect),
		).rejects.toThrow("stored internal task");
		const consent = fixture();
		consent.metadata.decisionDeck.protectedEffects = ["consent"];
		await expect(
			executeInternalDecisionTask(context, consent, effect),
		).rejects.toThrow("critical effect");
		expect(call).not.toHaveBeenCalled();
	});
	it.each([
		{ approvalOperation: "create_owner_task" },
		{ approvalOperation: null },
		{ localImport: true },
		{ schema: "tedix.outbound.v1" },
		{ riskLevel: "high" },
		{ riskLevel: "critical" },
		{ riskLevel: "unknown" },
		{ protectedEffects: ["consent"] },
		{ protectedEffects: "consent" },
		{ protectedEffects: null },
		{ protectedEffects: undefined },
		{ decisionClass: "credentials.rotate" },
		{ decisionClass: "legal.policy" },
	])(
		"rejects human-reserved root metadata before policy or effects (%j)",
		async (metadata) => {
			const request = fixture();
			await expect(
				executeInternalDecisionTask(
					context,
					{
						...request,
						metadata: { ...request.metadata, ...metadata },
					},
					effect,
				),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(readOrgDispatchPolicyLayer).not.toHaveBeenCalled();
			expect(call).not.toHaveBeenCalled();
		},
	);
	it("rejects handoff and approval kinds even with an internal task effect", async () => {
		await expect(
			executeInternalDecisionTask(
				context,
				{ ...fixture(), kind: "handoff" },
				effect,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		const request = fixture();
		request.metadata.decisionDeck.kind = "approval";
		await expect(
			executeInternalDecisionTask(context, request, effect),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(call).not.toHaveBeenCalled();
	});
	it("allows explicit low internal risk and empty protection metadata for draft creation", async () => {
		const request = fixture();
		await executeInternalDecisionTask(
			context,
			{
				...request,
				metadata: {
					...request.metadata,
					riskLevel: "low",
					protectedEffects: [],
					decisionClass: "internal.work.create",
				},
			},
			effect,
		);
		expect(call).toHaveBeenCalledOnce();
	});
	it("never creates from a missing tenant-scoped parent", async () => {
		vi.mocked(getWorkItemById).mockResolvedValueOnce(null);
		await expect(
			executeInternalDecisionTask(context, fixture(), effect),
		).rejects.toThrow("source task is unavailable");
		expect(call).not.toHaveBeenCalled();
	});
});
