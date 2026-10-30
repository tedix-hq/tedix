import * as z from "zod";
import { JsonValueSchema } from "./common";

const args = z
	.record(z.string(), JsonValueSchema)
	.refine(
		(value) => JSON.stringify(value).length <= 16384,
		"Example arguments are too large",
	);
export const ProbeProviderIdentityProfileInputSchema = z
	.object({ profileId: z.string().min(1), exampleArgs: args })
	.strict();
export const ProviderCredentialSummarySchema = z
	.object({
		scope: z.enum(["user", "tenant"]),
		connectionInstanceId: z.uuid().optional(),
	})
	.strict();
export const ProbeProviderIdentityProfileResponseSchema = z
	.object({
		resultReceiptId: z.uuid(),
		credentialSummary: ProviderCredentialSummarySchema.optional(),
	})
	.strict();
export const RedeemProviderIdentityProbeInputSchema = z
	.object({
		organizationId: z.string().min(1),
		receiptId: z.uuid(),
		exampleArgs: args,
	})
	.strict();
export const RedeemProviderIdentityProbeResponseSchema = z
	.object({
		actorUserId: z.string().min(1),
		profileId: z.string().min(1),
		exampleArgs: args,
		verifiedScopes: z.tuple([z.literal("connections.execute")]),
	})
	.strict();

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const RecordMachineProviderProbeInputSchema = z
	.object({
		organizationId: z.string().min(1),
		principalId: z.string().min(1),
		sessionId: z.string().min(1),
		clientRecordId: z.string().min(1),
		clientId: z.string().min(1),
		mcpServerId: z.string().min(1),
		profileId: z.string().min(1),
		profileDigest: digest,
		exampleArgs: args,
		accountRevisionDigest: digest,
	})
	.strict();
export const MachineProviderProbeListSchema = z
	.object({
		items: z.array(
			z
				.object({
					id: z.uuid(),
					profileId: z.string(),
					principalId: z.string(),
					sessionId: z.string(),
					clientRecordId: z.string(),
					expiresAt: z.string(),
				})
				.strict(),
		),
	})
	.strict();
export const PrepareMachineIdentityProbeInputSchema = z
	.object({ profileId: z.string().min(1), exampleArgs: args })
	.strict();
export const RedeemMachineIdentityProbeResponseSchema = z
	.object({
		principalId: z.string().min(1),
		sessionId: z.string().min(1),
		clientRecordId: z.string().min(1),
		clientId: z.string().min(1),
		mcpServerId: z.string().min(1),
		profileId: z.string().min(1),
		exampleArgs: args,
	})
	.strict();
