import { implement } from "@orpc/server";
import type { MemoryRevision } from "@tedix/agent-governance/types";
import { rulesContract } from "@tedix/api-contract/contracts/rules";
import type { Rule } from "@tedix/api-contract/schemas/rules";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { getMemberByCanonicalUserId } from "@tedix/db/queries/organization-members";
import { getRule, listRules } from "@tedix/db/queries/memory-graph/rules";
import {
	OrganizationMemoryAdapter,
	factReviewState,
	type FactMutationUpdates,
} from "@tedix/db/queries/memory-graph/memory-adapter";
import type { MemoryFact } from "@tedix/db/schema/memory-graph";
import { auditActor } from "../audit-helpers";
import { getRequestOrganizationMembership } from "../org-membership";
import { withOrg } from "../org-scope";
import {
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withAuthorization,
} from "../orpc";

const os = implement(rulesContract).$context<BaseContext>().use(withAuth);

function record(
	value: JsonValue | undefined | null,
): Record<string, JsonValue> {
	return value && typeof value === "object" && !Array.isArray(value)
		? value
		: {};
}

async function caller(context: BaseContext) {
	const actor = auditActor(context);
	const human =
		context.authType === "user" &&
		!context.externalAgentPrincipalId &&
		!context.browserAgentSeat &&
		!context.tediId;
	const member =
		human && context.user?.sub
			? await getRequestOrganizationMembership(
					context,
					context.organizationId!,
					context.user.sub,
					{ canonicalUserId: context.userId },
				)
			: context.gatewayEndUserId
				? await getMemberByCanonicalUserId(
						context.db,
						context.organizationId!,
						context.gatewayEndUserId,
					)
				: null;
	if (
		human &&
		(member?.status !== "active" || member.kind !== "human" || !member.userId)
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"An active organization membership is required",
		);
	return {
		actor,
		userId:
			member?.status === "active" && member.kind === "human"
				? member.userId
				: null,
		admin:
			human &&
			member?.status === "active" &&
			["owner", "admin"].includes(member.role),
	};
}

function result(fact: MemoryFact): Rule {
	const feed = record(fact.metadata?.learningFeed);
	const managed = record(fact.metadata?.managedRule);
	const personal =
		fact.visibility === "private" && typeof feed.ownerUserId === "string";
	const revisions = (fact.metadata?.memoryAdapterRevisions ??
		[]) as unknown as MemoryRevision[];
	const history: Rule["history"] = revisions.map((r) => ({
		revision: r.revision,
		text: String(r.value),
		writtenAt: r.writtenAt ?? null,
	}));
	// Older mined lessons have no adapter revision until their first edit.
	if (!history.length)
		history.push({
			revision: 1,
			text: fact.content,
			writtenAt: fact.updatedAt,
		});
	return {
		id: fact.id,
		text: fact.content,
		scope: personal ? "personal" : "organization",
		ownerUserId:
			personal && typeof feed.ownerUserId === "string"
				? feed.ownerUserId
				: null,
		origin: managed.origin === "written" ? "written" : "mined",
		state: fact.archivedAt
			? "retired"
			: fact.reviewStatus === "confirmed" &&
				  fact.status === "active" &&
				  ["can_use_as_instruction", "requires_user_confirmation"].includes(
						fact.usePolicy ?? "",
				  )
				? "active"
				: fact.reviewStatus === "pending"
					? "pending"
					: "rejected",
		reviewStatus: fact.reviewStatus,
		revision: history.at(-1)!.revision,
		reason: typeof managed.reason === "string" ? managed.reason : null,
		source: typeof managed.source === "string" ? managed.source : fact.source,
		createdAt: fact.createdAt,
		updatedAt: fact.updatedAt,
		history,
	};
}

async function load(
	context: BaseContext,
	organizationId: string,
	userId: string | null,
	id: string,
) {
	const fact = await getRule(context.db, { organizationId }, userId, id);
	if (!fact) throw createError(ErrorCodes.NOT_FOUND, "Rule not found");
	return fact;
}

function provenance(
	context: BaseContext,
	actor: ReturnType<typeof auditActor>,
) {
	return {
		actor: {
			id: actor.actorId,
			kind: actor.actorType,
			organizationId: context.organizationId!,
		},
		source: {
			surface: "rules",
			...(context.externalAgentSessionId
				? { traceId: context.externalAgentSessionId }
				: {}),
		},
	};
}

const create = os.create
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Personal writes require the owner; agent team changes remain pending; approval requires a human owner or admin",
			},
			"mcp:memory.write",
		),
	)
	.use(withOrg)
	.handler(async ({ input, context }) => {
		const who = await caller(context);
		if (input.scope === "personal" && !who.userId)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Personal rules require an authenticated person",
			);
		const id = crypto.randomUUID();
		const reviewStatus =
			input.scope === "personal" || who.admin ? "confirmed" : "pending";
		const adapter = new OrganizationMemoryAdapter(context.db, {
			organizationId: context.organizationId,
		});
		const { fact } = await adapter.create(
			{
				id,
				organizationId: context.organizationId,
				content: input.text,
				factType: "preference",
				topicKey: `learning-feed:written:${id}`,
				visibility: input.scope === "personal" ? "private" : "org",
				tediId: null,
				memoryScope: "org",
				status: "active",
				reviewStatus,
				usePolicy: "can_use_as_instruction",
				source: "written-rule",
				metadata: {
					managedRule: {
						origin: "written",
						...(input.reason ? { reason: input.reason } : {}),
						...(input.source ? { source: input.source } : {}),
					},
					learningFeed: {
						authored: true,
						...(input.scope === "personal" ? { ownerUserId: who.userId! } : {}),
						scope: { repo: "general", harness: "general", topic: "general" },
						hoisted: true,
					},
					memoryLifecycle: {
						lastReview: { actorId: who.actor.actorId, authored: true },
					},
				},
			},
			provenance(context, who.actor),
		);
		return result(fact);
	});
const list = os.list
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"An active member reads team rules and only their own personal rules",
			},
			"mcp:memory.read",
		),
	)
	.use(withOrg)
	.handler(async ({ input, context }) => {
		const who = await caller(context);
		const rows = await listRules(
			context.db,
			{ organizationId: context.organizationId },
			who.userId,
			input,
		);
		return {
			rules: rows.slice(0, input.limit).map(result),
			nextOffset: rows.length > input.limit ? input.offset + input.limit : null,
		};
	});
const get = os.get
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"An active member reads team rules and only their own personal rules",
			},
			"mcp:memory.read",
		),
	)
	.use(withOrg)
	.handler(async ({ input, context }) => {
		const who = await caller(context);
		return result(
			await load(context, context.organizationId!, who.userId, input.ruleId),
		);
	});

async function change(
	context: BaseContext,
	input: {
		ruleId: string;
		expectedRevision: number;
		reason?: string;
		text?: string;
		source?: string;
	},
	operation: "update" | "retire" | "restore" | "approve",
) {
	const who = await caller(context);
	const fact = await load(
		context,
		context.organizationId!,
		who.userId,
		input.ruleId,
	);
	const rule = result(fact);
	if (rule.revision !== input.expectedRevision)
		throw createError(
			ErrorCodes.CONFLICT,
			"Rule changed; read it again before editing",
		);
	if (operation === "approve" && (!who.admin || rule.scope !== "organization"))
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only a signed-in owner or admin can approve a team rule",
		);
	if ((operation === "restore") !== (rule.state === "retired"))
		throw createError(
			ErrorCodes.CONFLICT,
			"Restore a retired rule before changing it",
		);
	if (operation === "approve" && rule.state !== "pending")
		throw createError(
			ErrorCodes.CONFLICT,
			"Only a pending rule can be approved",
		);
	const feed = record(fact.metadata?.learningFeed);
	const managed = record(fact.metadata?.managedRule);
	const now = new Date().toISOString();
	const updates: FactMutationUpdates = {
		metadata: {
			...fact.metadata,
			managedRule: {
				...managed,
				origin: managed.origin === "written" ? "written" : "mined",
				...(input.reason ? { reason: input.reason } : {}),
				...(input.source ? { source: input.source } : {}),
			},
			learningFeed: {
				...feed,
				autoConfirmed: false,
				...(operation === "retire"
					? { retired: true }
					: operation === "restore"
						? { retired: false }
						: {}),
			},
			memoryLifecycle: {
				...record(fact.metadata?.memoryLifecycle),
				lastReview: {
					actorId: who.actor.actorId,
					operation,
					at: now,
					archived: operation === "retire",
				},
			},
		},
	};
	if (operation === "retire") updates.archivedAt = now;
	else {
		updates.archivedAt = null;
		updates.reviewStatus =
			operation === "approve" || rule.scope === "personal" || who.admin
				? "confirmed"
				: "pending";
		updates.status = "active";
		updates.usePolicy = "can_use_as_instruction";
		if (input.text !== undefined) {
			updates.content = input.text;
			// Explicit text is authoritative; the old miner's keyed rendering/evidence
			// describes the previous text and must not replace or hold the new revision.
			const newFeed = record(updates.metadata?.learningFeed);
			const { rules: _rules, ...authoredFeed } = newFeed;
			updates.metadata = {
				...updates.metadata,
				learningFeed: { ...authoredFeed, authored: true },
			};
		}
	}
	const adapter = new OrganizationMemoryAdapter(context.db, {
		organizationId: context.organizationId!,
	});
	await adapter.write(
		{
			key: fact.id,
			value: updates.content ?? fact.content,
			provenance: provenance(context, who.actor),
			review: factReviewState(updates.reviewStatus ?? fact.reviewStatus),
			writtenAt: now,
		},
		{ fact, updates },
	);
	return result(
		await load(context, context.organizationId!, who.userId, fact.id),
	);
}
const update = os.update
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Personal writes require the owner; agent team changes remain pending; approval requires a human owner or admin",
			},
			"mcp:memory.write",
		),
	)
	.use(withOrg)
	.handler(({ input, context }) => change(context, input, "update"));
const retire = os.retire
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Personal writes require the owner; agent team changes remain pending; approval requires a human owner or admin",
			},
			"mcp:memory.write",
		),
	)
	.use(withOrg)
	.handler(({ input, context }) => change(context, input, "retire"));
const restore = os.restore
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Personal writes require the owner; agent team changes remain pending; approval requires a human owner or admin",
			},
			"mcp:memory.write",
		),
	)
	.use(withOrg)
	.handler(({ input, context }) => change(context, input, "restore"));
const approve = os.approve
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Personal writes require the owner; agent team changes remain pending; approval requires a human owner or admin",
			},
			"mcp:memory.write",
		),
	)
	.use(withOrg)
	.handler(({ input, context }) => change(context, input, "approve"));
export const rulesContractRouter = {
	create,
	list,
	get,
	update,
	retire,
	restore,
	approve,
};
