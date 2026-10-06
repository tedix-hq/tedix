/** Human facts and explicit finite permission records. No provider, allocation, activation or settlement calls. */
import { ORPCError } from "@orpc/server";
import {
	FiniteExecutionAuthorizationInputSchema,
	FiniteExecutionAuthorizationSchema,
	FiniteExecutionRevocationInputSchema,
	FiniteExecutionRevocationSchema,
	type FiniteExecutionAuthorizationInput,
	type FiniteExecutionRevocationInput,
	HistoricalExposureSchema,
	HistoricalExposureInputSchema,
	HistoricalFreshDecisionSchema,
	type HistoricalExposureInput,
	type HistoricalFreshDecisionInput,
	type HistoricalFreshRevocationInput,
} from "@tedix/api-contract/schemas/billing";
import {
	recordFiniteExecutionAuthorization,
	recordFiniteExecutionRevocation,
	readFiniteExecutionAuthorizationForHuman,
	getFiniteExecutionAuthorization,
	getHistoricalDecisionOperation,
	getHistoricalBillingMember,
	getHistoricalFunding,
	historicalExposureSet,
	historicalRequestHash,
	recordHistoricalExposure,
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
export async function recordHistoricalExposureHandler(
	context: BaseContext,
	input: HistoricalExposureInput,
) {
	const authority = await requireHistoricalHuman(context);
	input = HistoricalExposureInputSchema.parse(input);
	const tedi = await canonicalRoot(
		context,
		input.tediId,
		authority.organizationId,
	);
	let summary;
	try {
		// Loading/dispatch occurs only after human auth. The private route itself checks namespace/name/physical custody.
		const [
			{ agentAdminFetch },
			{ TediRuntimeHistoricalCustodyResponseSchema },
		] = await Promise.all([
			import("../tedis/crud"),
			import("@tedix/api-contract/schemas/tedi"),
		]);
		const result = await agentAdminFetch(
			context,
			tedi,
			"/__admin/pi-state-cutover",
			{
				method: "POST",
				requireServiceBinding: true,
				timeoutMs: 30_000,
				body: {
					command: "audit_historical_custody",
					objectId: input.rootObjectId,
					...(input.targetPath.length ? { targetPath: input.targetPath } : {}),
					operationId: input.operationId,
					expectedGeneration: input.expectedGeneration,
					expectedSourceHash: input.sourceHash,
					custody: {
						tediId: tedi.id,
						orgId: authority.organizationId,
						objectName: tedi.isolateAgentId,
					},
				},
			},
		);
		if ("error" in result || !result.ok) throw new Error("unavailable");
		summary = TediRuntimeHistoricalCustodyResponseSchema.parse(result.json);
		if (
			summary.command !== "audit_historical_custody" ||
			summary.id !== input.rootObjectId ||
			summary.targetObjectId !== input.targetPath.at(-1)?.objectId ||
			(summary.targetObjectId ?? summary.id) !== input.objectId ||
			summary.operationId !== input.operationId ||
			summary.generation !== input.expectedGeneration ||
			summary.sourceHash !== input.sourceHash ||
			summary.snapshotId !== input.snapshotId
		)
			throw new Error("mismatch");
	} catch {
		throw new ORPCError("BAD_GATEWAY", {
			message: "Verified historical custody unavailable",
		});
	}
	const current = await canonicalRoot(
		context,
		input.tediId,
		authority.organizationId,
	);
	if (current.isolateAgentId !== tedi.isolateAgentId)
		throw new ORPCError("CONFLICT", {
			message: "Canonical historical custody changed",
		});
	const payload = HistoricalExposureSchema.parse({
		id: crypto.randomUUID(),
		organizationId: authority.organizationId,
		tediId: tedi.id,
		rootObjectName: tedi.isolateAgentId,
		rootObjectId: summary.id,
		targetPath: input.targetPath,
		objectName:
			input.targetPath.at(-1)?.identityName ??
			input.targetPath.at(-1)?.name ??
			tedi.isolateAgentId,
		objectId: summary.targetObjectId ?? summary.id,
		className: input.targetPath.at(-1)?.className ?? "AgentTediDO",
		generation: summary.generation,
		snapshotId: summary.snapshotId,
		sourceHash: summary.sourceHash,
		manifestHash: null,
		originalRunId: null,
		originalWorkId: null,
		originalPeriod: null,
		usage: null,
		costMicros: null,
		effects: "UNKNOWN",
		exposure: "UNKNOWN",
		workflowCount: summary.workflowCount,
		fiberCount: summary.fiberCount,
		identityCount: summary.identityCount,
		observedBy: authority.subject,
		observedUserId: authority.userId,
		observedAt: new Date().toISOString(),
		requestHash: await historicalRequestHash([
			authority.organizationId,
			authority.subject,
			authority.userId,
			input,
		]),
	});
	const row = await recordHistoricalExposure(context.db, {
		operationId: input.operationId,
		payload,
	});
	if (!row)
		throw new ORPCError("CONFLICT", {
			message: "Historical exposure custody or idempotency conflict",
		});
	return HistoricalExposureSchema.parse(row.payload);
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

export async function authorizeHistoricalFreshExecutionHandler(
	context: BaseContext,
	input: FiniteExecutionAuthorizationInput,
) {
	const a = await requireHistoricalHuman(context);
	input = FiniteExecutionAuthorizationInputSchema.parse(input);
	const tedi = await canonicalRoot(context, input.tediId, a.organizationId);
	if (tedi.isolateAgentId !== input.freshRootName)
		throw new ORPCError("CONFLICT", {
			message: "Fresh canonical custody changed",
		});
	const normalized = {
		...input,
		leafScopes: input.leafScopes
			.map((s) => ({
				...s,
				generations: [...s.generations].sort((a, b) => a - b),
			}))
			.sort((a, b) => a.className.localeCompare(b.className)),
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
		const parsed = FiniteExecutionAuthorizationSchema.safeParse(prior.payload);
		if (!parsed.success || prior.requestHash !== requestHash)
			throw new ORPCError("CONFLICT", {
				message: "Finite authorization idempotency conflict",
			});
		const row = await readFiniteExecutionAuthorizationForHuman(
			context.db,
			parsed.data,
		);
		if (!row)
			throw new ORPCError("CONFLICT", {
				message: "Finite authorization recorded custody changed",
			});
		return FiniteExecutionAuthorizationSchema.parse(row.payload);
	}
	const set = await historicalExposureSet(
		context.db,
		a.organizationId,
		input.tediId,
	);
	if (set.hash !== input.exposureSetHash || set.rows.length === 0)
		throw new ORPCError("CONFLICT", {
			message: "Recorded exposure set changed",
		});
	const recorded = set.rows.map((row) =>
		HistoricalExposureSchema.safeParse(row.payload),
	);
	if (
		recorded.some((v) => !v.success) ||
		!recorded.some(
			(v) => v.success && v.data.objectId === v.data.rootObjectId,
		) ||
		recorded.some(
			(v) =>
				v.success &&
				(v.data.organizationId !== a.organizationId ||
					v.data.tediId !== input.tediId ||
					v.data.rootObjectId === input.freshRootId ||
					v.data.rootObjectName === input.freshRootName),
		)
	)
		throw new ORPCError("CONFLICT", {
			message: "Distinct fresh custody and original recorded facts required",
		});
	let preparation;
	try {
		const [{ agentAdminFetch }, { TediRuntimeCutoverInventoryResponseSchema }] =
			await Promise.all([
				import("../tedis/crud"),
				import("@tedix/api-contract/schemas/tedi"),
			]);
		const result = await agentAdminFetch(
			context,
			tedi,
			"/__admin/pi-state-cutover",
			{
				method: "GET",
				requireServiceBinding: true,
				timeoutMs: 30000,
				query: {
					objectId: input.freshRootId,
					custodyTediId: tedi.id,
					expectedGeneration: String(input.preparedGeneration),
					offset: "0",
					limit: "1",
				},
			},
		);
		if ("error" in result || !result.ok) throw Error();
		const observed = TediRuntimeCutoverInventoryResponseSchema.parse(
			result.json,
		);
		if (
			observed.id !== input.freshRootId ||
			observed.receiver !== "raw-cutover-v1" ||
			!observed.admission ||
			!["held", "quarantined"].includes(observed.admission.state) ||
			observed.admission.generation !== input.preparedGeneration ||
			observed.inventory.storedOwner.unknown ||
			observed.inventory.storedOwner.orgId !== a.organizationId ||
			observed.inventory.storedOwner.tediId !== tedi.id ||
			!observed.targetsKnown ||
			observed.offset !== 0 ||
			observed.limit !== 1
		)
			throw Error();
		preparation = {
			state: observed.admission.state,
			generation: observed.admission.generation,
			inspectionHash: observed.inspectionHash,
			receiver: observed.receiver,
		};
	} catch {
		throw new ORPCError("BAD_GATEWAY", {
			message: "Verified nonactive fresh root preparation unavailable",
		});
	}
	const funding = await getHistoricalFunding(context.db, a.organizationId);
	if (!funding)
		throw new ORPCError("CONFLICT", {
			message: "Existing funding identity unavailable",
		});
	const { account, plan } = funding;
	const actual = {
		accountId: account.organizationId,
		entitlementVersion: account.entitlementVersion,
		settlementMode: resolveBillingSettlementMode(context.env),
		billingMode: account.billingMode,
		status: account.status,
		planVersionId: plan.id,
		planVersion: plan.version,
		periodStart: new Date(account.periodStart).toISOString(),
		periodEnd: new Date(account.periodEnd).toISOString(),
		stripeEnvironment:
			account.billingMode === "stripe"
				? resolveStripeEnvironment(context.env)
				: account.stripeEnvironment,
	};
	if (
		!["trial", "active"].includes(account.status) ||
		JSON.stringify(actual) !== JSON.stringify(input.funding)
	)
		throw new ORPCError("CONFLICT", { message: "Funding identity changed" });
	const event = FiniteExecutionAuthorizationSchema.parse({
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
		authority: "finite_execution_permit",
		preparation,
		exposures: set.rows.map((r) => HistoricalExposureSchema.parse(r.payload)),
		exposureOperations: set.rows.map((r) => ({
			id: r.id,
			operationId: r.operationId,
		})),
	});
	// Final canonical reread is after all other asynchronous orchestration. SQL fences it again at INSERT.
	const current = await canonicalRoot(context, input.tediId, a.organizationId);
	if (current.isolateAgentId !== input.freshRootName)
		throw new ORPCError("CONFLICT", {
			message: "Fresh canonical custody changed",
		});
	const row = await recordFiniteExecutionAuthorization(context.db, event);
	if (!row)
		throw new ORPCError("CONFLICT", {
			message:
				"Finite authorization membership, funding, set or revision changed",
		});
	return FiniteExecutionAuthorizationSchema.parse(row.payload);
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
