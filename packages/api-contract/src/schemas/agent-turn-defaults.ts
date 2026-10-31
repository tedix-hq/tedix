import * as z from "zod";
import {
	AGENT_REPLY_LABELS,
	AgentTurnAttentionKindSchema,
	AgentTurnTriagePolicySchema,
	AgentReplyDeliveryGatePolicySchema,
	AgentTurnSteeringPolicySchema,
} from "./agent-turn-triage";

export const AgentTurnDefaultsSchema = z.strictObject({
	assetVersion: z.number().int().min(1),
	policy: AgentTurnTriagePolicySchema.extend({
		deliveryGate: AgentReplyDeliveryGatePolicySchema,
		steering: AgentTurnSteeringPolicySchema,
	}),
	replyLabel: z.strictObject({
		instructions: z.string().min(1),
		criteria: z.record(z.enum(AGENT_REPLY_LABELS), z.string().min(1)),
	}),
	replyDraft: z.strictObject({
		promptVersion: z.number().int().min(1),
		lines: z.array(z.string()).min(1),
	}),
	attention: z.strictObject({
		ask: z.strictObject({
			id: z.string().regex(/^[A-Za-z0-9_.-]+$/),
			instructions: z.string().min(1),
			needsYouWhen: z.strictObject({ gte: z.number().min(0).max(1) }),
			noAskPatterns: z.array(
				z
					.string()
					.min(1)
					.refine((pattern) => {
						try {
							new RegExp(pattern, "iu");
							return true;
						} catch {
							return false;
						}
					}, "Invalid attention pattern"),
			),
		}),
		turnKind: z.record(AgentTurnAttentionKindSchema, z.string().min(1)),
		need: z.strictObject({
			maxChars: z.number().int().min(20).max(240),
			lines: z.array(z.string()).min(1),
		}),
	}),
});

export type AgentTurnDefaults = z.infer<typeof AgentTurnDefaultsSchema>;
