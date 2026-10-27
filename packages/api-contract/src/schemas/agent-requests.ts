import * as z from "zod";
import {
	ConnectionAllowedResourcesSchema,
	ConnectionConsumerGrantsSchema,
} from "./connections";

export const DataSensitivitySchema = z.enum([
	"public",
	"internal",
	"confidential",
	"restricted",
]);

export const AgentOwnershipLabelsSchema = z.strictObject({
	ownerUserId: z.string().trim().min(1).max(200),
	ownerTeam: z.string().trim().min(1).max(200).optional(),
	justification: z.string().trim().min(1).max(2_000),
	dataSensitivity: DataSensitivitySchema,
});

export const AgentRequestActionSchema = z.enum([
	"agent.create",
	"agent.connect",
	"resource.grant",
]);

export const AgentRequestProposalSchema = z.discriminatedUnion("kind", [
	AgentOwnershipLabelsSchema.extend({
		kind: z.literal("tedi"),
		name: z.string().trim().min(1).max(100),
		slug: z
			.string()
			.min(1)
			.max(50)
			.regex(/^[a-z0-9-]+$/),
	}),
	AgentOwnershipLabelsSchema.extend({
		kind: z.literal("external_agent"),
		key: z
			.string()
			.min(1)
			.max(120)
			.refine(
				(value) => !value.toLowerCase().startsWith("owner-host-"),
				"Owner-host keys are reserved",
			),
		displayName: z.string().trim().min(1).max(200),
		credentialBindingId: z
			.uuid()
			.describe(
				"Existing active API key in this organization; no credential value is accepted.",
			),
	}),
	AgentOwnershipLabelsSchema.extend({
		kind: z.literal("connection"),
		providerId: z.string().trim().min(1).max(200),
		label: z.string().trim().min(1).max(100),
		allowedResources: ConnectionAllowedResourcesSchema.optional(),
	}),
	AgentOwnershipLabelsSchema.extend({
		kind: z.literal("connection_grant"),
		providerId: z.string().trim().min(1).max(200),
		connectionInstanceId: z.uuid(),
		policy: ConnectionConsumerGrantsSchema,
	}),
]);
export type AgentRequestProposal = z.infer<typeof AgentRequestProposalSchema>;

export function agentRequestAction(proposal: AgentRequestProposal) {
	return proposal.kind === "connection"
		? "agent.connect"
		: proposal.kind === "connection_grant"
			? "resource.grant"
			: "agent.create";
}

export const AgentRequestExecutionSchema = z.strictObject({
	status: z.enum(["pending", "running", "succeeded", "failed"]),
	resourceId: z.string().optional(),
	completedAt: z.iso.datetime().optional(),
	message: z.string().max(500).optional(),
});
export type AgentRequestExecution = z.infer<typeof AgentRequestExecutionSchema>;
