import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	CompetencyObservationAttestationSchema,
	CompetencyObservationSchema,
	DelegationYieldSchema,
	EntrustableActivitySchema,
	EntrustmentLevelSchema,
	EntrustmentScopeSchema,
	EvidencePolicySchema,
	PromotionDecisionKindSchema,
	PromotionDecisionSchema,
	TediCareerStageSchema,
	TediEntrustmentSchema,
	TediRoleAssignmentSchema,
	ValidatedExperienceSchema,
} from "../schemas/earned-delegation";

const OrganizationIdInputSchema = z.uuid().optional();
const JsonRecordSchema = z.record(z.string(), z.unknown());

export const DelegationProfileSchema = z.object({
	tediId: z.uuid(),
	activeRole: TediRoleAssignmentSchema.nullable(),
	roleHistory: z.array(TediRoleAssignmentSchema),
	validatedExperience: ValidatedExperienceSchema,
	delegationYield: DelegationYieldSchema,
	entrustments: z.array(
		TediEntrustmentSchema.extend({
			effectiveStatus: z.enum(["active", "restricted", "expired", "revoked"]),
			activity: EntrustableActivitySchema,
		}),
	),
});
export type DelegationProfile = z.infer<typeof DelegationProfileSchema>;

export const earnedDelegationContract = oc
	.route({ tags: ["earned-delegation"], prefix: "/earned-delegation" })
	.errors(baseErrors)
	.router({
		getProfile: oc
			.route({
				method: "GET",
				path: "/profile/{tediId}",
				summary: "Get a tedi's earned-delegation profile",
				description:
					"Return role track, career stage, and effective task-scoped entrustments. Titles and experience never imply authority.",
			})
			.input(
				z.object({
					organizationId: OrganizationIdInputSchema,
					tediId: z.uuid(),
				}),
			)
			.output(DelegationProfileSchema),

		createActivity: oc
			.route({
				method: "POST",
				path: "/activities",
				summary: "Create a versioned entrustable activity",
				successStatus: 201,
			})
			.input(
				z.object({
					organizationId: OrganizationIdInputSchema,
					key: z.string().min(1).max(120),
					version: z.number().int().positive(),
					supersedesId: z.uuid().optional(),
					roleTemplateId: z.string().optional(),
					name: z.string().min(1).max(200),
					description: z.string().max(5000).optional(),
					taskFamily: z.string().min(1).max(120),
					riskLevel: z.enum(["low", "medium", "high", "critical"]),
					maximumLevel: EntrustmentLevelSchema,
					actionPatterns: z.array(z.string().min(1)).min(1),
					toolIds: z.array(z.string().min(1)).default([]),
					rubric: JsonRecordSchema,
					evidencePolicy: EvidencePolicySchema,
				}),
			)
			.output(EntrustableActivitySchema),

		recordObservation: oc
			.route({
				method: "POST",
				path: "/observations",
				summary: "Record independently evaluable work evidence",
				description:
					"Evaluator-only write. The canonical harness evaluation run, not caller claims, supplies opportunity identity, outcome, held-out lane, difficulty, quality, proof, execution context, and anti-farming cluster. Subject, activity classification, eligibility, and hashes are resolved server-side.",
				successStatus: 201,
			})
			.input(
				z.object({
					organizationId: OrganizationIdInputSchema,
					tediId: z.uuid(),
					activityId: z.uuid(),
					clientObservationId: z.string().min(1).max(200),
					executionOpportunityId: z
						.string()
						.min(1)
						.max(200)
						.describe(
							"Client correlation hint only; the server derives the canonical opportunity identity from the immutable work/source reference.",
						),
					workItemId: z.uuid().optional(),
					sourceKind: z.string().min(1).max(80),
					sourceId: z.string().min(1).max(500),
					traceBundleId: z.string().max(500).optional(),
					rationaleId: z.string().max(500).optional(),
					environment: z.string().min(1).max(80),
					harness: z.string().min(1).max(120),
					harnessVersion: z.string().min(1).max(120),
					modelProvider: z.string().min(1).max(120),
					modelId: z.string().min(1).max(200),
					modelVersion: z.string().min(1).max(200),
					outcome: z.enum(["success", "partial", "failure", "unverified"]),
					complexity: z.number().min(0).max(1),
					nonTrivial: z.boolean(),
					heldOut: z.boolean(),
					calibrationScore: z.number().min(0).max(1),
					escalationQuality: z.number().min(0).max(1),
					learningTransfer: z.boolean(),
					evidenceRefs: z.array(z.string().min(1)).max(100),
					classificationMethod: z.string().min(1).max(200),
					evaluationRunId: z.string().max(500).optional(),
					proofVerifiedAt: z.iso.datetime().optional(),
					costMinorUnits: z.number().int().nonnegative().optional(),
					costCurrency: z.string().length(3).optional(),
					durationMs: z.number().int().nonnegative().optional(),
					ownerReviewMinutes: z.number().nonnegative().optional(),
					policyViolationSeverity: z.number().int().nonnegative().optional(),
					confidence: z.number().min(0).max(1),
					metadata: JsonRecordSchema.optional(),
					occurredAt: z.iso.datetime(),
				}),
			)
			.output(CompetencyObservationSchema),

		attestObservation: oc
			.route({
				method: "POST",
				path: "/observations/{observationId}/attestations",
				summary: "Attest an observation as a stable authenticated principal",
				description:
					"Owner/admin, scoped organization API key, or gateway-verified external-agent principal may corroborate or reject evidence. Attestation is evidence only and never disposes authority.",
				successStatus: 201,
			})
			.input(
				z.object({
					organizationId: OrganizationIdInputSchema,
					observationId: z.uuid(),
					verdict: z.enum(["supports", "rejects"]),
					verificationMethod: z.string().min(1).max(200),
				}),
			)
			.output(CompetencyObservationAttestationSchema.nullable()),

		certifyObservation: oc
			.route({
				method: "POST",
				path: "/observations/{observationId}/certification",
				summary: "Run the canonical proof certification service",
				description:
					"Runs a versioned server-side verifier over immutable harness evidence and proof-gated Work Item completion. The caller cannot choose the verdict. The resulting certification-service attestation is evidence only and never disposes authority.",
				successStatus: 201,
			})
			.input(
				z.object({
					organizationId: OrganizationIdInputSchema,
					observationId: z.uuid(),
				}),
			)
			.output(
				z.object({
					attestation: CompetencyObservationAttestationSchema,
					checks: z.object({
						canonicalHarnessEvidence: z.boolean(),
						proofGatedWorkItem: z.boolean(),
					}),
				}),
			),

		proposeDecision: oc
			.route({
				method: "POST",
				path: "/decisions",
				summary: "Propose a promotion or entrustment decision",
				description:
					"Creates an inert proposal from server-recomputed evidence. Tedis and gateway-verified external agents may propose, but a separate owner/admin user must dispose it.",
				successStatus: 201,
			})
			.input(
				z.object({
					organizationId: OrganizationIdInputSchema,
					clientProposalId: z.string().min(1).max(200),
					tediId: z.uuid(),
					kind: PromotionDecisionKindSchema,
					activityId: z.uuid().optional(),
					targetCareerStage: TediCareerStageSchema.optional(),
					targetEntrustmentLevel: EntrustmentLevelSchema.optional(),
					targetRoleTemplateId: z.string().max(200).optional(),
					targetRoleKey: z.string().min(1).max(120).optional(),
					targetRoleName: z.string().min(1).max(200).optional(),
					targetScope: EntrustmentScopeSchema.optional(),
					targetExpiresAt: z.iso.datetime().optional(),
					targetNextReviewAt: z.iso.datetime().optional(),
					evidenceRefs: z.array(z.string().min(1)).min(1).max(100),
					reason: z.string().max(5000).optional(),
					proposalExpiresAt: z.iso.datetime(),
				}),
			)
			.output(PromotionDecisionSchema),

		decideDecision: oc
			.route({
				method: "POST",
				path: "/decisions/{decisionId}/decision",
				summary: "Approve and atomically apply, or reject, a proposal",
				description:
					"Human or API-key authority only. The server rechecks evidence, expiry, scope, and revision fences before applying.",
			})
			.input(
				z.object({
					organizationId: OrganizationIdInputSchema,
					decisionId: z.uuid(),
					approved: z.boolean(),
					reason: z.string().max(5000).optional(),
				}),
			)
			.output(PromotionDecisionSchema),
	});

export type EarnedDelegationContract = typeof earnedDelegationContract;
