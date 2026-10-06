/**
 * Agent-turn urgency triage.
 *
 * `triage` scores an agent's message to its operator against the caller's
 * triage questions with a Workers AI Clef decision model; `labelReply`
 * classifies an operator reply into a fixed reply vocabulary. Neither stores
 * anything. A model failure or timeout degrades to `status: "unavailable"`
 * (urgency `later`) instead of an error, so a caller can always proceed.
 *
 * The question set is configuration: a stored `user_configs` row in namespace
 * `work.turn-triage` keyed by the credential-resolved organization (the same
 * per-user-per-tenant shape and revision CAS as `user-settings.ts`) wins, and a
 * missing or unparseable row falls back to the versioned default asset
 * `agent-turn-triage-defaults.json`.
 */

import { ORPCError, implement } from "@orpc/server";
import { agentTurnTriageContract } from "@tedix/api-contract/contracts/agent-turn-triage";
import {
	AGENT_REPLY_LABELS,
	type AgentReplyLabel,
	type AgentTurnTriagePolicy,
	type AgentTurnTriagePolicyState,
	AgentTurnTriagePolicySchema,
	type TriageResult,
} from "@tedix/api-contract/schemas/agent-turn-triage";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { getUserConfig, putUserConfig } from "@tedix/db/queries/user-configs";
import * as z from "zod";
import { type ClefQuestion, runClef } from "../../lib/clef";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withAuthorization,
} from "../orpc";
import defaultsAsset from "./agent-turn-triage-defaults.json";

const os = implement(agentTurnTriageContract).$context<BaseContext>();
const readOs = os.use(withAuth).use(AUTHZ.messagingRead);
const writeOs = os
	.use(withAuth)
	.use(withAuthorization("tedis:update", "mcp:messaging.write"));

export const AGENT_TURN_TRIAGE_NAMESPACE = "work.turn-triage";

const DefaultsAssetSchema = z.object({
	assetVersion: z.number().int().min(1),
	policy: AgentTurnTriagePolicySchema,
	replyLabel: z.object({
		instructions: z.string().min(1),
		criteria: z.record(z.enum(AGENT_REPLY_LABELS), z.string().min(1)),
	}),
});

/**
 * Parsed once per isolate (the router module is lazy). A malformed asset is a
 * build defect and must fail loudly rather than triage with a partial set.
 */
const DEFAULTS = DefaultsAssetSchema.parse(defaultsAsset);
for (const label of AGENT_REPLY_LABELS) {
	if (!DEFAULTS.replyLabel.criteria[label]) {
		throw new Error(`agent-turn-triage defaults: missing reply class ${label}`);
	}
}
export const DEFAULT_AGENT_TURN_TRIAGE_POLICY: AgentTurnTriagePolicy =
	DEFAULTS.policy;

async function readPolicyState(
	context: BaseContext,
	organizationId: string,
): Promise<AgentTurnTriagePolicyState> {
	// A machine principal without a Tedix user identity has no stored row.
	const row = context.userId
		? await getUserConfig(context.db, {
				userId: context.userId,
				namespace: AGENT_TURN_TRIAGE_NAMESPACE,
				key: organizationId,
			})
		: null;
	const parsed = row ? AgentTurnTriagePolicySchema.safeParse(row.value) : null;
	if (!row || !parsed?.success) {
		return {
			policy: DEFAULT_AGENT_TURN_TRIAGE_POLICY,
			source: "default",
			revision: row?.revision ?? 0,
			updatedAt: row?.updatedAt ?? null,
		};
	}
	return {
		policy: parsed.data,
		source: "stored",
		revision: row.revision,
		updatedAt: row.updatedAt ?? null,
	};
}

/** Pure scoring step, exported for tests: urgency from labels + thresholds. */
export function scoreTriage(
	policy: AgentTurnTriagePolicy,
	labels: Record<string, number>,
): Pick<TriageResult, "urgency" | "urgentLabels"> {
	const urgentLabels = policy.questions
		.filter((question) => (labels[question.id] ?? 0) >= question.urgentWhen.gte)
		.map((question) => question.id);
	return { urgency: urgentLabels.length > 0 ? "now" : "later", urgentLabels };
}

const triage = readOs.triage.handler(async ({ input, context }) => {
	const organizationId = requireOrgId(context);
	const { policy } = await readPolicyState(context, organizationId);
	const unavailable = (latencyMs: number): TriageResult => ({
		status: "unavailable",
		urgency: "later",
		labels: {},
		urgentLabels: [],
		model: policy.model,
		policyVersion: policy.version,
		latencyMs,
	});
	if (!policy.enabled) return unavailable(0);

	const questions: Record<string, ClefQuestion> = {};
	for (const question of policy.questions) {
		questions[question.id] = {
			type: "noul",
			instructions: question.instructions,
		};
	}
	const result = await runClef(context.env, {
		modelId: policy.model,
		state: { agent_message: input.text },
		questions,
		surface: "agent-turn-triage",
	});
	if (!result.ok) return unavailable(result.latencyMs);

	const labels: Record<string, number> = {};
	for (const [id, answer] of Object.entries(result.answers)) {
		if (answer.type === "noul") labels[id] = answer.noul;
	}
	return {
		status: "ok",
		...scoreTriage(policy, labels),
		labels,
		model: policy.model,
		policyVersion: policy.version,
		latencyMs: result.latencyMs,
	};
});

const labelReply = readOs.labelReply.handler(async ({ input, context }) => {
	const organizationId = requireOrgId(context);
	const { policy } = await readPolicyState(context, organizationId);
	const result = await runClef(context.env, {
		modelId: policy.model,
		state: {
			agent_last_message: input.turnText,
			operator_reply: input.replyText,
		},
		questions: {
			reply_class: {
				type: "choice",
				instructions: DEFAULTS.replyLabel.instructions,
				criteria: DEFAULTS.replyLabel.criteria,
			},
		},
		surface: "agent-reply-label",
	});
	const answer = result.ok ? result.answers.reply_class : undefined;
	if (!answer || answer.type !== "choice") {
		return {
			status: "unavailable" as const,
			label: null,
			p: null,
			model: policy.model,
		};
	}
	return {
		status: "ok" as const,
		label: answer.choice as AgentReplyLabel,
		p: answer.probabilities[answer.choice] ?? answer.confidence,
		model: policy.model,
	};
});

const getPolicy = readOs.getPolicy.handler(async ({ context }) =>
	readPolicyState(context, requireOrgId(context)),
);

const updatePolicy = writeOs.updatePolicy.handler(
	async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const userId = context.userId;
		if (!userId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Triage policy belongs to a Tedix user identity; this credential resolves none",
			);
		}
		const current = await readPolicyState(context, organizationId);
		const policy: AgentTurnTriagePolicy = {
			...input.policy,
			version: current.policy.version + 1,
		};
		const result = await putUserConfig(context.db, {
			userId,
			namespace: AGENT_TURN_TRIAGE_NAMESPACE,
			key: organizationId,
			value: policy as unknown as Record<string, JsonValue>,
			expectedRevision: input.expectedRevision,
		});
		if (!result.ok) {
			throw new ORPCError("CONFLICT", {
				message:
					"Triage policy revision compare-and-swap lost against a concurrent write",
				data: {
					expectedRevision: input.expectedRevision,
					currentRevision: result.currentRevision,
				},
			});
		}
		return {
			policy,
			source: "stored" as const,
			revision: result.row.revision,
			updatedAt: result.row.updatedAt ?? null,
		};
	},
);

export const agentTurnTriageContractRouter = os.router({
	triage,
	labelReply,
	getPolicy,
	updatePolicy,
});
