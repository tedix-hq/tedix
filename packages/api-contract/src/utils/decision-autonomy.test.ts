import { describe, expect, it } from "vite-plus/test";
import {
	DEFAULT_DECISION_AUTONOMY,
	decideDecisionAutonomy,
} from "./decision-autonomy";

const policy = { version: 1 as const, maxRisk: "medium" as const };
const action = {
	classId: "internal.work.create",
	risk: "medium",
	reversibility: "two_way",
	scope: "internal",
	ownerType: "tedi",
	effectKind: "create_owner_task",
};
const decision = {
	version: 1,
	kind: "proposal",
	classId: "crm.followup",
	proposal: "Create an internal follow-up task?",
	whyNow: "A follow-up is ready",
	recommendation: "Create the task",
	preview: {
		body: "Send the customer a proposal and publish the announcement",
	},
	reversibility: "two_way",
	tasteOrStrategy: true,
	protectedEffects: [],
	blastRadius: "Internal Work item",
	confidence: null,
	costOfWaiting: "Follow-up is delayed",
	reasoning: "Store the draft for later work",
	options: [
		{
			id: "create",
			label: "Create task",
			intent: "approve",
			consequence: "Create Work",
			cost: "None",
			effect: {
				kind: "create_owner_task",
				workItemId: "11111111-1111-4111-8111-111111111111",
				title: "Customer follow-up",
				description: "Send customer a proposal",
			},
		},
		{
			id: "skip",
			label: "Skip",
			intent: "reject",
			consequence: "No task",
			cost: "None",
		},
	],
};

describe("decideDecisionAutonomy", () => {
	it("routes internal task creation under organization autonomy", () => {
		expect(decideDecisionAutonomy({ policy, action })).toMatchObject({
			eligible: true,
			classId: action.classId,
		});
	});

	it.each([
		undefined,
		{},
		{ ...action, risk: "unknown" },
		{ ...action, risk: "high" },
		{ ...action, risk: "critical" },
		{ ...action, reversibility: "unknown" },
		{ ...action, reversibility: "one_way" },
		{ ...action, scope: "external" },
		{ ...action, ownerType: "user" },
		{ ...action, ownerType: "system" },
		{ ...action, effectKind: "send_message" },
	])("fails closed for missing or unsafe action evidence: %j", (candidate) => {
		expect(decideDecisionAutonomy({ policy, action: candidate }).eligible).toBe(
			false,
		);
	});

	it("requires tenant policy and honors correction lessons", () => {
		expect(decideDecisionAutonomy({ action }).eligible).toBe(false);
		for (const askForClasses of [["*"], [action.classId]])
			expect(
				decideDecisionAutonomy({ policy: { ...policy, askForClasses }, action })
					.eligible,
			).toBe(false);
	});

	it.each([
		"money",
		"publish",
		"send",
		"consent",
		"credentials",
		"delete",
		"legal",
		"roles",
		"permissions",
	])(
		"keeps %s classes human even if a configuration rule permits the adapter",
		(critical) => {
			const classId = `approval.${critical}`;
			const config = {
				...DEFAULT_DECISION_AUTONOMY,
				reservedClassPattern: "^no_additional_reserved_classes$",
				rules: [{ ...DEFAULT_DECISION_AUTONOMY.rules[0]!, classes: [classId] }],
			};
			expect(
				decideDecisionAutonomy({
					policy,
					action: { ...action, classId },
					config,
				}).eligible,
			).toBe(false);
		},
	);

	it("classifies the task adapter rather than quoted draft instructions", () => {
		const draft = "Send the customer a proposal and publish the announcement";
		expect(decideDecisionAutonomy({ policy, action, decision }).eligible).toBe(
			true,
		);
		expect(
			decideDecisionAutonomy({
				policy,
				action: { ...action, actionContent: draft },
			}).eligible,
		).toBe(false);
	});

	it("rejects competing approvals and mismatched effects", () => {
		for (const options of [
			[decision.options[1], decision.options[1]],
			[decision.options[0], { ...decision.options[0], id: "another" }],
			[
				{
					...decision.options[0],
					effect: {
						kind: "complete_work",
						workItemId: "11111111-1111-4111-8111-111111111111",
					},
				},
				decision.options[1],
			],
		])
			expect(
				decideDecisionAutonomy({
					policy,
					action,
					decision: { ...decision, options },
				}).eligible,
			).toBe(false);
	});

	it.each([
		"data",
		"contract",
		"production",
		"money",
		"consent",
		"message",
		"commitment",
	])(
		"keeps protected %s effects human even for an internal task adapter",
		(effect) => {
			expect(
				decideDecisionAutonomy({
					policy,
					action,
					decision: { ...decision, protectedEffects: [effect] },
				}).eligible,
			).toBe(false);
		},
	);

	it.each(["approval", "outbound"])(
		"keeps %s decision envelopes human",
		(kind) => {
			expect(
				decideDecisionAutonomy({
					policy,
					action,
					decision: { ...decision, kind },
				}).eligible,
			).toBe(false);
		},
	);

	it("requires verified validation and governed path for a code push", () => {
		const push = {
			...action,
			classId: "internal.code.push",
			effectKind: "governed_push",
		};
		for (const evidence of [{}, { validated: true }, { governed: true }])
			expect(
				decideDecisionAutonomy({ policy, action: { ...push, ...evidence } })
					.eligible,
			).toBe(false);
		expect(
			decideDecisionAutonomy({
				policy,
				action: { ...push, validated: true, governed: true },
			}).eligible,
		).toBe(true);
	});

	it("requires agent ownership for an internal setting toggle", () => {
		const toggle = {
			...action,
			classId: "internal.setting.toggle",
			effectKind: "toggle_internal_setting",
		};
		expect(decideDecisionAutonomy({ policy, action: toggle }).eligible).toBe(
			false,
		);
		expect(
			decideDecisionAutonomy({
				policy,
				action: { ...toggle, agentOwned: true },
			}).eligible,
		).toBe(true);
	});

	it("rejects malformed decision or routing evidence", () => {
		expect(
			decideDecisionAutonomy({ policy, action, decision: {} }).eligible,
		).toBe(false);
		expect(
			decideDecisionAutonomy({ policy, action, config: {} }).eligible,
		).toBe(false);
		expect(
			decideDecisionAutonomy({
				policy,
				action,
				config: { ...DEFAULT_DECISION_AUTONOMY, reservedClassPattern: "[" },
			}).eligible,
		).toBe(false);
	});
});
