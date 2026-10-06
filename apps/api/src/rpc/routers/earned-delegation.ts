import { implement } from "@orpc/server";
import { earnedDelegationContract } from "@tedix/api-contract/contracts/earned-delegation";
import {
	type JsonValue,
	JsonValueSchema,
} from "@tedix/api-contract/schemas/common";
import { createEntrustableActivity } from "@tedix/db/queries/earned-delegation/activities";
import { attestCompetencyObservation } from "@tedix/db/queries/earned-delegation/attestations";
import { EarnedDelegationError } from "@tedix/db/queries/earned-delegation/authority-policy";
import { certifyCompetencyObservation } from "@tedix/db/queries/earned-delegation/certification";
import { decidePromotionProposal } from "@tedix/db/queries/earned-delegation/decision-settlement";
import { getDelegationProfile } from "@tedix/db/queries/earned-delegation/entrustments";
import { recordCompetencyObservation } from "@tedix/db/queries/earned-delegation/observations";
import { createPromotionProposal } from "@tedix/db/queries/earned-delegation/promotion-proposals";
import { requireOrgIdOrInput } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";
import {
	earnedDelegationEvidenceReviewerActor,
	governanceAuthorityActor,
	humanDispositionActor,
} from "./earned-delegation-access";

const earnedDelegationOs = implement(
	earnedDelegationContract,
).$context<BaseContext>();
const authed = earnedDelegationOs.use(withAuth);

function requireNamedActor(context: BaseContext): {
	type: "user" | "tedi" | "service" | "api_key" | "external_agent";
	id: string;
} {
	if (context.externalAgentPrincipalId) {
		return {
			type: "external_agent",
			id: context.externalAgentPrincipalId,
		};
	}
	if (context.authType === "user" && typeof context.user?.sub === "string") {
		return { type: "user", id: context.user.sub };
	}
	if (context.authType === "tedi" && context.tediId) {
		return { type: "tedi", id: context.tediId };
	}
	if (context.authType === "apikey" && context.apiKey?.id) {
		return { type: "api_key", id: context.apiKey.id };
	}
	if (
		(context.authType === "service-binding" || context.authType === "m2m") &&
		context.serviceAccount?.clientId
	) {
		return { type: "service", id: context.serviceAccount.clientId };
	}
	throw createError(
		ErrorCodes.FORBIDDEN,
		"A stable authenticated principal is required",
	);
}

function requireEvidenceReviewer(context: BaseContext): {
	type: "user" | "api_key" | "external_agent";
	id: string;
} {
	const actor = earnedDelegationEvidenceReviewerActor(context);
	if (actor) return actor;
	throw createError(
		ErrorCodes.FORBIDDEN,
		"Evidence review requires an owner/admin, scoped organization API key, or gateway-verified external agent",
	);
}

function requireHumanOrApiKey(context: BaseContext): {
	type: "user" | "api_key";
	id: string;
} {
	const actor = governanceAuthorityActor(context);
	if (actor) return actor;
	throw createError(
		ErrorCodes.FORBIDDEN,
		"Earned-delegation governance requires an owner/admin or a scoped organization API key",
	);
}

function requireHumanDisposer(context: BaseContext): {
	type: "user";
	id: string;
} {
	const actor = humanDispositionActor(context);
	if (actor) return actor;
	throw createError(
		ErrorCodes.FORBIDDEN,
		"Applying an earned-authority decision requires an independent owner/admin user; API keys may not dispose authority",
	);
}

function rethrowEarnedDelegationError(error: unknown): never {
	if (!(error instanceof EarnedDelegationError)) throw error;
	switch (error.reason) {
		case "not_found":
			throw createError(ErrorCodes.NOT_FOUND, error.message);
		case "out_of_scope":
		case "untrusted_authority":
			throw createError(ErrorCodes.FORBIDDEN, error.message);
		case "conflict":
		case "expired":
			throw createError(ErrorCodes.CONFLICT, error.message);
		case "ineligible":
		case "invalid_transition":
			throw createError(ErrorCodes.BAD_REQUEST, error.message);
	}
}

function normalizeJsonRecord(
	value: Record<string, unknown>,
): Record<string, JsonValue> {
	const parsed = JsonValueSchema.parse(value);
	if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
		throw createError(ErrorCodes.BAD_REQUEST, "Expected a JSON object");
	}
	return parsed;
}

const getProfile = authed.getProfile
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		try {
			return await getDelegationProfile(context.db, {
				organizationId: requireOrgIdOrInput(context, input.organizationId),
				tediId: input.tediId,
				now: new Date().toISOString(),
			});
		} catch (error) {
			rethrowEarnedDelegationError(error);
		}
	});

const createActivity = authed.createActivity
	.use(AUTHZ.delegationGovern)
	.handler(async ({ input, context }) => {
		requireHumanOrApiKey(context);
		try {
			return await createEntrustableActivity(context.db, {
				...input,
				rubric: normalizeJsonRecord(input.rubric),
				organizationId: requireOrgIdOrInput(context, input.organizationId),
				now: new Date().toISOString(),
			});
		} catch (error) {
			rethrowEarnedDelegationError(error);
		}
	});

const recordObservation = authed.recordObservation
	.use(AUTHZ.delegationGovern)
	.handler(async ({ input, context }) => {
		const evaluator = requireHumanOrApiKey(context);
		try {
			return await recordCompetencyObservation(context.db, {
				...input,
				organizationId: requireOrgIdOrInput(context, input.organizationId),
				executorType: "tedi",
				executorId: input.tediId,
				evaluatorType: evaluator.type,
				evaluatorId: evaluator.id,
				now: new Date().toISOString(),
			});
		} catch (error) {
			rethrowEarnedDelegationError(error);
		}
	});

const attestObservation = authed.attestObservation
	.use(AUTHZ.delegationGovern)
	.handler(async ({ input, context }) => {
		const actor = requireEvidenceReviewer(context);
		const organizationId = requireOrgIdOrInput(context, input.organizationId);
		try {
			return await attestCompetencyObservation(context.db, {
				organizationId,
				observationId: input.observationId,
				principalType: actor.type,
				principalId:
					actor.type === "api_key"
						? `organization:${organizationId}`
						: actor.id,
				verdict: input.verdict,
				verificationMethod: input.verificationMethod,
				authenticatedAt: new Date().toISOString(),
				now: new Date().toISOString(),
			});
		} catch (error) {
			rethrowEarnedDelegationError(error);
		}
	});

const certifyObservation = authed.certifyObservation
	.use(AUTHZ.delegationGovern)
	.handler(async ({ input, context }) => {
		requireEvidenceReviewer(context);
		try {
			return await certifyCompetencyObservation(context.db, {
				organizationId: requireOrgIdOrInput(context, input.organizationId),
				observationId: input.observationId,
				now: new Date().toISOString(),
			});
		} catch (error) {
			rethrowEarnedDelegationError(error);
		}
	});

const proposeDecision = authed.proposeDecision
	.use(AUTHZ.delegationGovern)
	.handler(async ({ input, context }) => {
		const actor = requireNamedActor(context);
		try {
			return await createPromotionProposal(context.db, {
				...input,
				organizationId: requireOrgIdOrInput(context, input.organizationId),
				proposedByType: actor.type,
				proposedById: actor.id,
				now: new Date().toISOString(),
			});
		} catch (error) {
			rethrowEarnedDelegationError(error);
		}
	});

const decideDecision = authed.decideDecision
	.use(AUTHZ.delegationGovern)
	.handler(async ({ input, context }) => {
		const actor = requireHumanDisposer(context);
		try {
			return await decidePromotionProposal(context.db, {
				organizationId: requireOrgIdOrInput(context, input.organizationId),
				decisionId: input.decisionId,
				approved: input.approved,
				decidedByType: actor.type,
				decidedById: actor.id,
				reason: input.reason,
				now: new Date().toISOString(),
			});
		} catch (error) {
			rethrowEarnedDelegationError(error);
		}
	});

export const earnedDelegationContractRouter = earnedDelegationOs.router({
	getProfile,
	createActivity,
	recordObservation,
	attestObservation,
	certifyObservation,
	proposeDecision,
	decideDecision,
});
