import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";
import type { VerifiedActiveWorkActor } from "../rpc/routers/work-items-principal";
import { internalDecisionRouting } from "./internal-decision-routing";

const mocks = vi.hoisted(() => ({ readPolicy: vi.fn() }));
vi.mock("../rpc/routers/kernel/tedi-capabilities", () => ({
	readOrgDispatchPolicyLayer: mocks.readPolicy,
}));

const orgId = "11111111-1111-4111-8111-111111111111";
const context = { db: {} } as BaseContext;
const actor: VerifiedActiveWorkActor = { type: "tedi", id: "test-worker" };
const autonomy = {
	version: 1,
	maxRisk: "medium",
	policyPack: { id: "test-policy-pack", version: 3 },
};
const action = {
	classId: "internal.code.push",
	risk: "medium",
	reversibility: "two_way",
	scope: "internal",
	ownerType: "tedi",
	effectKind: "governed_push",
	validated: true,
	governed: true,
};
const input = {
	subject: "Push the validated code change?",
	prompt: "Validation passed. Use the governed push command.",
	metadata: { internalAction: action },
};

beforeEach(() => {
	mocks.readPolicy.mockReset();
	mocks.readPolicy.mockResolvedValue({ autonomy });
});

describe("internalDecisionRouting", () => {
	it("returns validated governed code pushes to the authenticated agent owner", async () => {
		expect(await internalDecisionRouting(context, orgId, actor, input)).toEqual(
			{
				classId: action.classId,
				policyPack: autonomy.policyPack,
				reason: "autonomy v1: medium risk",
			},
		);
		expect(mocks.readPolicy).toHaveBeenCalledWith(context.db, orgId);
	});

	it("supports a verified external agent with matching action ownership", async () => {
		const external: VerifiedActiveWorkActor = {
			type: "external_agent",
			id: "test-executor",
			sessionId: "test-session",
			externalSessionKey: "codex:test-session",
		};
		expect(
			await internalDecisionRouting(context, orgId, external, {
				...input,
				metadata: {
					internalAction: { ...action, ownerType: "external_agent" },
				},
			}),
		).toMatchObject({ classId: action.classId });
	});

	it("never turns a human request into an autonomous decision", async () => {
		expect(
			await internalDecisionRouting(
				context,
				orgId,
				{ type: "user", id: "test-user" },
				input,
			),
		).toBeNull();
		expect(mocks.readPolicy).not.toHaveBeenCalled();
	});

	it("requires the metadata owner type to match the verified principal", async () => {
		expect(
			await internalDecisionRouting(context, orgId, actor, {
				...input,
				metadata: {
					internalAction: { ...action, ownerType: "external_agent" },
				},
			}),
		).toBeNull();
		expect(mocks.readPolicy).not.toHaveBeenCalled();
	});

	it.each([null, {}, { effect: "deny", autonomy }])(
		"retains the human request without effective autonomy: %j",
		async (layer) => {
			mocks.readPolicy.mockResolvedValue(layer);
			expect(
				await internalDecisionRouting(context, orgId, actor, input),
			).toBeNull();
		},
	);

	it("honors an organization correction for this action class", async () => {
		mocks.readPolicy.mockResolvedValue({
			autonomy: { ...autonomy, askForClasses: [action.classId] },
		});
		expect(
			await internalDecisionRouting(context, orgId, actor, input),
		).toBeNull();
	});

	it.each(["validated", "governed"])(
		"retains push questions missing %s proof",
		async (key) => {
			expect(
				await internalDecisionRouting(context, orgId, actor, {
					...input,
					metadata: { internalAction: { ...action, [key]: false } },
				}),
			).toBeNull();
		},
	);

	it("routes only an agent-owned internal setting toggle", async () => {
		const internalAction = {
			classId: "internal.setting.toggle",
			risk: "low",
			reversibility: "two_way",
			scope: "internal",
			ownerType: "tedi",
			effectKind: "toggle_internal_setting",
		};
		const setting = {
			subject: "Enable internal progress summaries?",
			prompt: "Adjust the worker's own display setting.",
		};
		expect(
			await internalDecisionRouting(context, orgId, actor, {
				...setting,
				metadata: { internalAction },
			}),
		).toBeNull();
		expect(
			await internalDecisionRouting(context, orgId, actor, {
				...setting,
				metadata: { internalAction: { ...internalAction, agentOwned: true } },
			}),
		).toMatchObject({ classId: internalAction.classId });
	});

	it.each([
		"Provide credentials to continue",
		"Approve test organization consent?",
		"Delete the old notes?",
		"Change the member role?",
		"Pay the invoice?",
		"Publish the announcement?",
		"Send the customer an email?",
		"Approve the legally binding contract?",
	])("retains critical action content: %s", async (subject) => {
		expect(
			await internalDecisionRouting(context, orgId, actor, {
				...input,
				subject,
			}),
		).toBeNull();
	});

	it.each([
		"money",
		"publish",
		"send",
		"consent",
		"credentials",
		"delete",
		"roles",
		"legal",
	])(
		"retains critical %s classes despite an internal action claim",
		async (critical) => {
			expect(
				await internalDecisionRouting(context, orgId, actor, {
					...input,
					metadata: {
						internalAction: { ...action, classId: `approval.${critical}` },
					},
				}),
			).toBeNull();
		},
	);

	it.each([
		undefined,
		{},
		{ internalAction: {} },
		{ internalAction: { ...action, unknown: true } },
		{ internalAction: { ...action, risk: "unknown" } },
	])(
		"retains unclassified or malformed action metadata: %j",
		async (metadata) => {
			expect(
				await internalDecisionRouting(context, orgId, actor, {
					...input,
					metadata,
				}),
			).toBeNull();
		},
	);

	it.each([
		{ approvalOperation: "update_roles" },
		{ localImport: true },
		{ schema: "tedix.outbound.v1" },
		{ protectedEffects: ["consent"] },
		{ protectedEffects: "unknown" },
		{ riskLevel: "high" },
		{ riskLevel: "critical" },
	])("retains human-only producer metadata: %j", async (metadata) => {
		expect(
			await internalDecisionRouting(context, orgId, actor, {
				...input,
				metadata: { ...input.metadata, ...metadata },
			}),
		).toBeNull();
	});

	it("retains an internal task when its envelope protects consent", async () => {
		const internalAction = {
			...action,
			classId: "internal.work.create",
			effectKind: "create_owner_task",
		};
		const effect = {
			kind: "create_owner_task",
			workItemId: orgId,
			title: "Follow up",
			description: "Internal task",
		};
		const decisionDeck = {
			version: 1,
			kind: "proposal",
			classId: "internal.work.create",
			proposal: "Create follow-up?",
			whyNow: "Ready",
			recommendation: "Create task",
			reversibility: "two_way",
			protectedEffects: ["consent"],
			blastRadius: "Internal Work",
			confidence: null,
			costOfWaiting: "Delay",
			reasoning: "Follow-up is ready",
			options: [
				{
					id: "create",
					label: "Create",
					intent: "approve",
					consequence: "Task",
					cost: "None",
					effect,
				},
				{
					id: "skip",
					label: "Skip",
					intent: "reject",
					consequence: "None",
					cost: "None",
				},
			],
		};
		expect(
			await internalDecisionRouting(context, orgId, actor, {
				...input,
				metadata: { internalAction, decisionDeck },
			}),
		).toBeNull();
	});
});
