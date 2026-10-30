import * as z from "zod";
import { isTenantPolicyPredicate } from "../utils/tenant-policy-predicate";
import { JsonValueSchema } from "./common";
import { ProviderIdentityMountSchema } from "./provider-identity-profile";
import {
	TOOL_BLAST_RADIUS_VALUES,
	TOOL_OPERATIONAL_RISK_TIER_VALUES,
	ToolPolicyMetadataSchema,
} from "./tools";

export const TenantToolPolicyPredicateSchema = JsonValueSchema.refine(
	isTenantPolicyPredicate,
	"Invalid policy predicate",
);
export const TenantToolPolicyEffectSchema = z
	.object({
		disposition: z.enum(["allow", "ask", "deny"]),
		riskTier: z.enum(TOOL_OPERATIONAL_RISK_TIER_VALUES),
		blastRadius: z.enum(TOOL_BLAST_RADIUS_VALUES),
	})
	.strict()
	.refine(
		(effect) =>
			ToolPolicyMetadataSchema.safeParse({
				riskTier: effect.riskTier,
				blastRadius: effect.blastRadius,
			}).success,
		"Risk and scope are not compatible",
	);
export const TenantToolPolicySetSchema = z
	.object({
		evaluatorVersion: z.literal(1),
		defaultDisposition: z.literal("ask"),
		rules: z
			.array(
				z
					.object({
						id: z.string().min(1).max(100),
						predicate: TenantToolPolicyPredicateSchema,
						effect: TenantToolPolicyEffectSchema,
					})
					.strict(),
			)
			.min(1)
			.max(32),
	})
	.strict()
	.refine(
		(set) =>
			new Set(set.rules.map((rule) => rule.id)).size === set.rules.length,
		"Rule IDs must be unique",
	);
export type TenantToolPolicySet = z.infer<typeof TenantToolPolicySetSchema>;
const LegacyEffectSchema = z
	.object({
		riskTier: z.literal("bounded_write"),
		blastRadius: z.literal("single_resource"),
		autoApprove: z.boolean(),
	})
	.strict();
export const TenantToolPolicyRawMountDescriptorSchema = z
	.object({
		version: z.literal(1),
		organizationId: z.string().min(1),
		rootAppId: z.string().min(1),
		mountAppIds: z.array(z.string().min(1)).min(1).max(16),
		sourceAppId: z.string().min(1),
		sourceToolRowId: z.string().min(1),
		sourceToolId: z.string().min(1),
		mountedToolId: z.string().min(1),
		transport: z.enum(["mcp", "external"]),
		upstreamOperation: z.string().min(1),
		providerId: z.string().min(1),
		connectionInstanceId: z.string().min(1),
		credentialScope: z.literal("tenant"),
		requestedScopes: z.array(z.string()),
		effectiveToolDigest: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
export const TenantToolPolicyMountDescriptorSchema =
	TenantToolPolicyRawMountDescriptorSchema.extend({
		accountRevisionDigest: z.string().regex(/^[a-f0-9]{64}$/),
	}).strict();
export const TenantToolPolicyProfileDescriptorSchema = z
	.object({
		kind: z.literal("profile"),
		mount: ProviderIdentityMountSchema,
		profileId: z.string().min(1),
		profileDigest: z.string().regex(/^[a-f0-9]{64}$/),
		actorUserId: z.string().min(1),
		accountRevisionDigest: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
export const TenantToolPolicyMachineSubjectSchema = z.discriminatedUnion(
	"scope",
	[
		z
			.object({
				scope: z.literal("session"),
				principalId: z.string().min(1),
				sessionId: z.string().min(1),
				clientRecordId: z.string().min(1),
				clientId: z.string().min(1),
				mcpServerId: z.string().min(1),
			})
			.strict(),
		z
			.object({
				scope: z.literal("principal"),
				principalId: z.string().min(1),
				mcpServerId: z.string().min(1),
			})
			.strict(),
	],
);
export const TenantToolPolicyMachineDescriptorSchema = z
	.object({
		kind: z.literal("machine"),
		mount: ProviderIdentityMountSchema,
		profileId: z.string().min(1),
		profileDigest: z.string().regex(/^[a-f0-9]{64}$/),
		ownerUserId: z.string().min(1),
		subject: TenantToolPolicyMachineSubjectSchema,
		credentialScope: z.literal("tenant"),
		accountRevisionDigest: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
export const TenantNativeRpcMountSchema = z
	.object({
		version: z.literal(1),
		organizationId: z.string().min(1),
		rootAppId: z.string().min(1),
		mountAppIds: z.array(z.string().min(1)).min(1).max(16),
		sourceAppId: z.string().min(1),
		sourceToolRowId: z.string().min(1),
		sourceToolId: z.string().min(1),
		mountedToolId: z.string().min(1),
		transport: z.literal("rpc"),
		endpoint: z.string().min(1),
		effectiveToolDigest: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
export type TenantNativeRpcMount = z.infer<typeof TenantNativeRpcMountSchema>;
export const TenantNativeRpcPolicyDescriptorSchema = z
	.object({
		kind: z.literal("native_rpc"),
		mount: TenantNativeRpcMountSchema,
		ownerUserId: z.string().min(1),
		subject: TenantToolPolicyMachineSubjectSchema,
		reviewSessionId: z.string().min(1),
		reviewClientRecordId: z.string().min(1),
	})
	.strict();
export const TenantToolPolicyBoundDescriptorSchema = z.union([
	TenantToolPolicyMountDescriptorSchema,
	TenantToolPolicyProfileDescriptorSchema,
	TenantToolPolicyMachineDescriptorSchema,
	TenantNativeRpcPolicyDescriptorSchema,
]);
export type TenantToolPolicyRawMountDescriptor = z.infer<
	typeof TenantToolPolicyRawMountDescriptorSchema
>;
export const PrepareTenantToolPolicyInputSchema = z
	.object({
		rootAppId: z.string().min(1),
		mountedToolId: z.string().min(1),
		exampleArgs: z.record(z.string(), JsonValueSchema),
	})
	.strict();
export const PrepareTenantToolPolicyResponseSchema = z.object({
	preparationId: z.uuid(),
	descriptor: TenantToolPolicyMountDescriptorSchema,
	descriptorDigest: z.string(),
	expiresAt: z.string(),
});
export const PrepareHybridTenantToolPolicyInputSchema = z
	.object({
		profileId: z.string().min(1),
		resultReceiptId: z.uuid(),
		exampleArgs: z.record(z.string(), JsonValueSchema),
	})
	.strict();
export const PrepareHybridTenantToolPolicyResponseSchema = z.object({
	preparationId: z.uuid(),
	descriptor: TenantToolPolicyProfileDescriptorSchema,
	descriptorDigest: z.string(),
	expiresAt: z.string(),
});
export const PrepareMachineTenantToolPolicyInputSchema =
	PrepareHybridTenantToolPolicyInputSchema.extend({
		subjectScope: z.enum(["session", "principal"]).default("session"),
	}).strict();
export const PrepareMachineTenantToolPolicyResponseSchema = z.object({
	preparationId: z.uuid(),
	descriptor: TenantToolPolicyMachineDescriptorSchema,
	descriptorDigest: z.string(),
	expiresAt: z.string(),
});
export const PrepareNativeRpcPolicyInputSchema = z
	.object({
		rootAppId: z.string().min(1),
		mountedToolId: z.string().min(1),
		principalId: z.string().min(1),
		sessionId: z.string().min(1),
		clientRecordId: z.string().min(1),
		exampleArgs: z.record(z.string(), JsonValueSchema),
	})
	.strict();
export const PrepareNativeRpcPolicyResponseSchema = z.object({
	preparationId: z.uuid(),
	descriptor: TenantNativeRpcPolicyDescriptorSchema,
	descriptorDigest: z.string(),
	expiresAt: z.string(),
});
export const MachinePolicyInventorySchema = z.object({
	items: z.array(
		z.object({
			principalId: z.string(),
			principalName: z.string(),
			sessionId: z.string(),
			clientRecordId: z.string(),
			mcpServerId: z.string(),
		}),
	),
});
export type MachinePolicyInventory = z.infer<
	typeof MachinePolicyInventorySchema
>;
export const TenantToolPolicySchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	appId: z.string(),
	toolRowId: z.string().nullable(),
	toolDigest: z.string(),
	ruleDigest: z.string(),
	mountDescriptor: TenantToolPolicyBoundDescriptorSchema.nullable(),
	mountDigest: z.string().nullable(),
	predicate: TenantToolPolicyPredicateSchema,
	effect: z.union([TenantToolPolicyEffectSchema, LegacyEffectSchema]),
	policySet: TenantToolPolicySetSchema.nullable(),
	createdBy: z.string(),
	createdAt: z.string(),
	revokedAt: z.string().nullable(),
});
export const CreateTenantToolPolicyInputSchema = z
	.object({
		preparationId: z.uuid(),
		expectedDescriptorDigest: z.string().min(1),
		expectedRevisionId: z.string().min(1).optional(),
		regrantRevoked: z.boolean().optional(),
		recoverDeleted: z.boolean().optional(),
		recoverUnknownRevisionId: z.string().min(1).optional(),
		subjectRecoveryMode: z.enum(["revoked", "deleted"]).optional(),
		exampleArgs: z.record(z.string(), JsonValueSchema),
		machineConfirmationReceiptId: z.uuid().optional(),
		policySet: TenantToolPolicySetSchema,
	})
	.strict()
	.refine(
		(input) =>
			(!(input.regrantRevoked || input.recoverDeleted) ||
				!!input.expectedRevisionId ||
				!!input.recoverUnknownRevisionId) &&
			!(input.regrantRevoked && input.recoverDeleted) &&
			(!input.recoverUnknownRevisionId ||
				!!input.regrantRevoked ||
				!!input.recoverDeleted) &&
			(!input.subjectRecoveryMode ||
				(!!input.recoverUnknownRevisionId && !!input.expectedRevisionId)),
	);
export const DeletedTenantPolicyFencesSchema = z.object({
	items: z.array(
		z.object({
			rootAppId: z.string(),
			mountedToolId: z.string(),
			revisionId: z.string(),
			subjectKey: z.string().nullable().optional(),
			sourceAppId: z.string().nullable(),
			sourceToolId: z.string().nullable(),
		}),
	),
});
export const ResolveTenantToolPolicyInputSchema = z
	.object({
		organizationId: z.string().min(1),
		descriptor: TenantToolPolicyBoundDescriptorSchema,
		descriptorDigest: z.string(),
		args: z.record(z.string(), JsonValueSchema),
	})
	.strict();
export const ResolveTenantToolPolicyResponseSchema = z.object({
	matched: z.boolean(),
	revisionId: z.string().nullable(),
	ruleDigest: z.string().nullable(),
	effect: TenantToolPolicyEffectSchema.optional(),
	defaultAsk: z.literal(true).optional(),
});
export const ResolveTenantPolicyCandidateInputSchema = z
	.object({
		organizationId: z.string().min(1),
		rootAppId: z.string().min(1),
		mountedToolId: z.string().min(1),
		actorUserId: z.string().min(1),
		args: z.record(z.string(), JsonValueSchema),
	})
	.strict();
export const ResolveTenantPolicySourceCandidateInputSchema = z
	.object({
		organizationId: z.string().min(1),
		rootAppId: z.string().min(1),
		sourceAppId: z.string().min(1),
		sourceToolRowId: z.string().min(1),
		actorUserId: z.string().min(1),
		args: z.record(z.string(), JsonValueSchema),
	})
	.strict();
export const ResolveTenantPolicyCandidateResponseSchema = z.object({
	candidate: z
		.object({
			descriptor: TenantToolPolicyProfileDescriptorSchema,
			descriptorDigest: z.string(),
			revisionId: z.string(),
			ruleDigest: z.string(),
			effect: TenantToolPolicyEffectSchema.optional(),
			defaultAsk: z.literal(true).optional(),
		})
		.nullable(),
});
export const ResolveTenantPolicyDiscoveryInputSchema = z
	.object({
		organizationId: z.string().min(1),
		rootAppId: z.string().min(1),
		mountedToolId: z.string().min(1),
		actorUserId: z.string().min(1),
	})
	.strict();
export const ResolveTenantPolicyDiscoveryResponseSchema = z.object({
	potential: z.boolean(),
});
export const ResolveTenantPolicyPresenceInputSchema = z
	.object({
		organizationId: z.string().min(1),
		rootAppId: z.string().min(1).optional(),
		mountedToolId: z.string().min(1).optional(),
		sourceAppId: z.string().min(1),
		sourceToolRowId: z.string().min(1),
		sourceToolId: z.string().min(1),
	})
	.strict()
	.refine((v) => !v.mountedToolId || !!v.rootAppId);
export const ResolveMachinePolicyCandidateInputSchema = z
	.object({
		organizationId: z.string().min(1),
		rootAppId: z.string().min(1),
		sourceAppId: z.string().min(1),
		sourceToolRowId: z.string().min(1),
		args: z.record(z.string(), JsonValueSchema),
	})
	.strict();
export const ResolveMachinePolicyDiscoveryInputSchema =
	ResolveMachinePolicyCandidateInputSchema.omit({ args: true });
export const ResolveMachinePolicyAnyRootInputSchema =
	ResolveMachinePolicyCandidateInputSchema.omit({ rootAppId: true });
export const ResolveMachinePolicyCandidateResponseSchema = z.object({
	candidate: z
		.object({
			descriptor: TenantToolPolicyMachineDescriptorSchema,
			descriptorDigest: z.string(),
			revisionId: z.string(),
			ruleDigest: z.string(),
			effect: TenantToolPolicyEffectSchema.optional(),
			defaultAsk: z.literal(true).optional(),
		})
		.nullable(),
});
export const ResolveNativeRpcPolicyCandidateResponseSchema = z.object({
	candidate: z
		.object({
			descriptor: TenantNativeRpcPolicyDescriptorSchema,
			descriptorDigest: z.string(),
			revisionId: z.string(),
			ruleDigest: z.string(),
			effect: TenantToolPolicyEffectSchema.optional(),
			defaultAsk: z.literal(true).optional(),
		})
		.nullable(),
});
export const RequestMachineToolApprovalInputSchema = z
	.object({
		organizationId: z.string().min(1),
		descriptor: TenantToolPolicyMachineDescriptorSchema,
		descriptorDigest: z.string().min(1),
		revisionId: z.string().min(1),
		ruleDigest: z.string().min(1),
		args: z.record(z.string(), JsonValueSchema),
		approvalRequestId: z.uuid().optional(),
	})
	.strict();
export const RequestNativeMachineToolApprovalInputSchema =
	RequestMachineToolApprovalInputSchema.extend({
		descriptor: TenantNativeRpcPolicyDescriptorSchema,
	}).strict();
export type RequestMachineToolApprovalInput =
	| z.infer<typeof RequestMachineToolApprovalInputSchema>
	| z.infer<typeof RequestNativeMachineToolApprovalInputSchema>;
export const PrepareOwnerPolicyReplayInputSchema = z
	.object({
		organizationId: z.string().min(1),
		approvalRequestId: z.uuid(),
		args: z.record(z.string(), JsonValueSchema),
	})
	.strict();
export const PrepareOwnerPolicyReplayResponseSchema = z.object({
	binding: z
		.object({
			descriptor: TenantToolPolicyProfileDescriptorSchema,
			descriptorDigest: z.string(),
			revisionId: z.string(),
			ruleDigest: z.string(),
		})
		.strict(),
	probeReceiptId: z.uuid(),
});
export type ResolveTenantToolPolicyInput = z.infer<
	typeof ResolveTenantToolPolicyInputSchema
>;
