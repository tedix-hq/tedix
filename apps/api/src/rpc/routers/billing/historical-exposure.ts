/** Human facts and explicit finite permission records. No provider, allocation, activation or settlement calls. */
import { ORPCError } from "@orpc/server";
import {
	FiniteExecutionAuthorizationSchema,
	FiniteExecutionRevocationInputSchema,
	FiniteExecutionRevocationSchema,
	type FiniteExecutionRevocationInput,
	HistoricalExposureSchema,
	HistoricalFreshDecisionSchema,
	type HistoricalFreshDecisionInput,
	type HistoricalFreshRevocationInput,
} from "@tedix/api-contract/schemas/billing";
import {
	recordFiniteExecutionRevocation,
	getFiniteExecutionAuthorization,
	getHistoricalDecisionOperation,
	getHistoricalBillingMember,
	getHistoricalFunding,
	historicalExposureSet,
	historicalRequestHash,
	recordHistoricalDecision,
} from "@tedix/db/queries/billing/historical-exposure";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { requireOrgId } from "../../org-scope";
import { userHoldsPermission, type BaseContext } from "../../orpc";
import { resolveBillingSettlementMode } from "../../../lib/billing-settlement-mode";
import { resolveStripeEnvironment } from "../../../lib/stripe-environment";

export async function requireHistoricalHuman(context: BaseContext) {
	const user = context.user as BaseContext["user"] & {
		entityType?: unknown;
		tediId?: unknown;
	};
	if (
		context.authType !== "user" ||
		!user?.sub ||
		!context.userId ||
		context.tediId ||
		context.externalAgentPrincipalId ||
		user.entityType === "tedi" ||
		user.tediId
	)
		throw new ORPCError("FORBIDDEN", {
			message: "Human organization billing authority required",
		});
	const organizationId = requireOrgId(context);
	const member = await getHistoricalBillingMember(
		context.db,
		organizationId,
		user.sub,
	);
	if (
		!member ||
		member.organizationId !== organizationId ||
		member.descopeUserId !== user.sub ||
		member.status !== "active" ||
		member.userId !== context.userId ||
		!["owner", "admin"].includes(member.role) ||
		!userHoldsPermission(
			{ ...context, userRole: member.role },
			"billing:manage",
		)
	)
		throw new ORPCError("FORBIDDEN", {
			message: "Active human owner/admin billing membership required",
		});
	return { organizationId, subject: user.sub, userId: context.userId };
}
async function canonicalRoot(
	context: BaseContext,
	tediId: string,
	organizationId: string,
) {
	const tedi = await getTediByIdForOrganization(
		context.db,
		tediId,
		organizationId,
	);
	if (!tedi || !tedi.isolateAgentId || tedi.organizationId !== organizationId)
		throw new ORPCError("CONFLICT", {
			message: "Canonical historical custody unavailable",
		});
	return tedi;
}
export async function listHistoricalExposuresHandler(
	context: BaseContext,
	input: { tediId: string },
) {
	const a = await requireHistoricalHuman(context);
	await canonicalRoot(context, input.tediId, a.organizationId);
	const set = await historicalExposureSet(
		context.db,
		a.organizationId,
		input.tediId,
	);
	return {
		scope: "recorded_objects_only" as const,
		revision: set.revision,
		hash: set.hash,
		exposures: set.rows.map((r) => HistoricalExposureSchema.parse(r.payload)),
	};
}
export async function recordHistoricalFreshDecisionHandler(
	context: BaseContext,
	input: HistoricalFreshDecisionInput,
) {
	const a = await requireHistoricalHuman(context);
	const tedi = await canonicalRoot(context, input.tediId, a.organizationId);
	const set = await historicalExposureSet(
		context.db,
		a.organizationId,
		input.tediId,
	);
	const parsed = set.rows.map((row) =>
		HistoricalExposureSchema.safeParse(row.payload),
	);
	if (parsed.some((value) => !value.success))
		throw new ORPCError("CONFLICT", {
			message: "Canonical historical custody changed",
		});
	const exposures = parsed.map((value) => value.data!);
	if (
		!exposures.some((value) => value.objectId === value.rootObjectId) ||
		set.rows.some(
			(r, index) =>
				r.objectName !== tedi.isolateAgentId ||
				exposures[index]!.rootObjectName !== tedi.isolateAgentId ||
				exposures[index]!.rootObjectId !== input.objectId,
		)
	)
		throw new ORPCError("CONFLICT", {
			message: "Canonical historical custody changed",
		});
	const normalized = {
		...input,
		permittedClasses: [...input.permittedClasses].sort(),
	};
	const requestHash = await historicalRequestHash([
		a.organizationId,
		a.subject,
		a.userId,
		normalized,
	]);
	const prior = await getHistoricalDecisionOperation(
		context.db,
		a.organizationId,
		input.tediId,
		input.operationId,
	);
	if (prior) {
		if (prior.requestHash !== requestHash)
			throw new ORPCError("CONFLICT", {
				message: "Historical decision idempotency conflict",
			});
		return HistoricalFreshDecisionSchema.parse(prior.payload);
	}
	const funding = await getHistoricalFunding(context.db, a.organizationId);
	if (!funding)
		throw new ORPCError("CONFLICT", {
			message: "Existing funding identity unavailable",
		});
	const { account, plan } = funding;
	const mode = resolveBillingSettlementMode(context.env);
	const env =
		account.billingMode === "stripe"
			? resolveStripeEnvironment(context.env)
			: account.stripeEnvironment;
	if (!["active", "trial"].includes(account.status))
		throw new ORPCError("CONFLICT", {
			message: "Existing funding identity unavailable",
		});
	const actual = {
		accountId: account.organizationId,
		entitlementVersion: account.entitlementVersion,
		settlementMode: mode,
		billingMode: account.billingMode,
		status: account.status,
		planVersionId: plan.id,
		planVersion: plan.version,
		periodStart: new Date(account.periodStart).toISOString(),
		periodEnd: new Date(account.periodEnd).toISOString(),
		stripeEnvironment: env,
	};
	if (JSON.stringify(actual) !== JSON.stringify(input.funding))
		throw new ORPCError("CONFLICT", { message: "Funding identity changed" });
	const event = HistoricalFreshDecisionSchema.parse({
		id: crypto.randomUUID(),
		organizationId: a.organizationId,
		tediId: input.tediId,
		revision: input.expectedRevision + 1,
		kind: "decision",
		decisionId: null,
		recordedBy: a.subject,
		recordedUserId: a.userId,
		recordedAt: new Date().toISOString(),
		requestHash,
		input: normalized,
		authority: "records_only",
	});
	const row = await recordHistoricalDecision(
		context.db,
		event,
		tedi.isolateAgentId!,
		set,
	);
	if (!row)
		throw new ORPCError("CONFLICT", {
			message: "Historical decision exposure, period or revision conflict",
		});
	return HistoricalFreshDecisionSchema.parse(row.payload);
}
export async function revokeHistoricalFreshDecisionHandler(
	context: BaseContext,
	input: HistoricalFreshRevocationInput,
) {
	const a = await requireHistoricalHuman(context),
		tedi = await canonicalRoot(context, input.tediId, a.organizationId);
	const set = await historicalExposureSet(
		context.db,
		a.organizationId,
		input.tediId,
	);
	const event = HistoricalFreshDecisionSchema.parse({
		id: crypto.randomUUID(),
		organizationId: a.organizationId,
		tediId: input.tediId,
		revision: input.expectedRevision + 1,
		kind: "revocation",
		decisionId: input.decisionId,
		recordedBy: a.subject,
		recordedUserId: a.userId,
		recordedAt: new Date().toISOString(),
		requestHash: await historicalRequestHash([
			a.organizationId,
			a.subject,
			a.userId,
			input,
		]),
		input,
		authority: "records_only",
	});
	const row = await recordHistoricalDecision(
		context.db,
		event,
		tedi.isolateAgentId!,
		set,
	);
	if (!row)
		throw new ORPCError("CONFLICT", {
			message: "Historical revocation revision conflict",
		});
	return HistoricalFreshDecisionSchema.parse(row.payload);
}

export async function revokeHistoricalFreshExecutionHandler(
	context: BaseContext,
	input: FiniteExecutionRevocationInput,
) {
	const a = await requireHistoricalHuman(context);
	input = FiniteExecutionRevocationInputSchema.parse(input);
	const tedi = await canonicalRoot(context, input.tediId, a.organizationId);
	const original = await getFiniteExecutionAuthorization(
		context.db,
		a.organizationId,
		input.tediId,
		input.authorizationId,
	);
	const grant = FiniteExecutionAuthorizationSchema.safeParse(original?.payload);
	if (!grant.success || grant.data.input.freshRootName !== tedi.isolateAgentId)
		throw new ORPCError("CONFLICT", {
			message: "Finite authorization custody unavailable",
		});
	const event = FiniteExecutionRevocationSchema.parse({
		id: crypto.randomUUID(),
		organizationId: a.organizationId,
		tediId: input.tediId,
		revision: input.expectedRevision + 1,
		kind: "revocation",
		decisionId: input.authorizationId,
		input,
		freshRootName: grant.data.input.freshRootName,
		freshRootId: grant.data.input.freshRootId,
		recordedBy: a.subject,
		recordedUserId: a.userId,
		recordedAt: new Date().toISOString(),
		requestHash: await historicalRequestHash([
			a.organizationId,
			a.subject,
			a.userId,
			input,
		]),
		authority: "finite_execution_permit",
	});
	const current = await canonicalRoot(context, input.tediId, a.organizationId);
	if (current.isolateAgentId !== event.freshRootName)
		throw new ORPCError("CONFLICT", {
			message: "Fresh canonical custody changed",
		});
	const row = await recordFiniteExecutionRevocation(context.db, event);
	if (!row)
		throw new ORPCError("CONFLICT", {
			message: "Finite revocation membership or revision changed",
		});
	return FiniteExecutionRevocationSchema.parse(row.payload);
}
