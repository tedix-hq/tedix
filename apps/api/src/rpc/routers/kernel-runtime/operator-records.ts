import { getTopPlatformFacts } from "@tedix/db/queries/memory-graph/platform-facts";
import { isMemorySearchFactEligible } from "../../../services/memory-search-filter";
import { rankByQueryRelevance } from "../kernel/context-relevance";
import { listWorkItemAttempts } from "@tedix/db/queries/work-items/attempts";
import { implement } from "@orpc/server";
import { kernelRuntimeContract } from "@tedix/api-contract/contracts/kernel-runtime";
import { hasOperatorRecordPlan } from "@tedix/api-contract/schemas/operator-records";
import { DelegationWorkOrderSchema } from "@tedix/api-contract/schemas/kernel-runtime";
import { getKernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import { getPersonalRequestConsent } from "@tedix/db/queries/personal-request-consent";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { insertTediRuntimeEvent } from "@tedix/db/queries/cognitive-runtime";
import { resolveKernelConversationAccess } from "../../../kernel/conversation-access";
import { requireOrgId, requireTediRequestIdentity } from "../../org-scope";
import {
	type BaseContext,
	withTediAuth,
	createError,
	ErrorCodes,
} from "../../orpc";
import { assembleHomeContext } from "../kernel/context-assembly";
import { fetchConversationHistory } from "../kernel/context-history";
import { renderHomeTurnContext } from "../kernel/context-render";
import { nonNullRecord } from "../kernel/runtime-shared";

const os = implement(kernelRuntimeContract).$context<BaseContext>();

/** This API takes a dispatch lookup tuple, never an acting-user identity. */
export const readOperatorRecordsRoute = os.readOperatorRecords
	.use(withTediAuth)
	.handler(async ({ context, input }) => {
		requireTediRequestIdentity(context, input.tediId);
		const organizationId = requireOrgId(context);
		const [home, consent, tedi] = await Promise.all([
			getKernelRuntimeRun(context.db, { id: input.homeRunId, organizationId }),
			getPersonalRequestConsent(context.db, organizationId, input.homeRunId),
			getTediByIdForOrganization(context.db, input.tediId, organizationId),
		]);
		const deny = (): never => {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"No active read-only member delegation for these operator records",
			);
		};
		if (
			!home ||
			!tedi ||
			!consent ||
			!["queued", "running", "waiting"].includes(home.status) ||
			home.delegatedTediId !== input.tediId ||
			home.childRunId !== input.runId ||
			home.metadata?.workItemId !== input.workItemId
		)
			return deny();
		const metadata = home.metadata;
		const order = DelegationWorkOrderSchema.safeParse(
			nonNullRecord(metadata?.homeDelegation)?.workOrder,
		);
		const route = nonNullRecord(metadata?.kernelRoute);
		const grant = consent.metadata;
		const userId = consent.actorId;
		if (
			!userId ||
			grant?.requesterUserId !== userId ||
			grant.rootRunId !== input.homeRunId ||
			grant.conversationId !== home.conversationId ||
			grant.tediId ||
			typeof grant.expiresAt !== "string" ||
			!Number.isFinite(Date.parse(grant.expiresAt)) ||
			Date.parse(grant.expiresAt) <= Date.now() ||
			Date.parse(grant.expiresAt) - consent.timestamp.getTime() >
				15 * 60 * 1000 + 1000 ||
			!order.success ||
			!hasOperatorRecordPlan(order.data.capabilityPlan) ||
			route?.risk !== "low" ||
			order.data.executionRequirement.surface !== "native" ||
			order.data.contract.successCriteria.some((value) =>
				/mutating tool call/i.test(value),
			)
		)
			return deny();
		const sourceTool = {
			work: "read_operator_records",
			home: "read_home_messages",
			memory: "memory_search",
			calendar: "read_operator_calendar",
			mail: "read_operator_mail",
		}[input.source];
		if (!order.data.capabilityPlan?.allowedToolIds.includes(sourceTool))
			return deny();
		const member = await getMemberByUserId(context.db, organizationId, userId);
		if (
			member?.status !== "active" ||
			(tedi.scope === "personal" && tedi.ownerUserId !== userId)
		)
			return deny();
		const attempts = await listWorkItemAttempts(context.db, {
			orgId: organizationId,
			workItemId: input.workItemId,
			limit: 1,
		});
		const active = attempts.data[0];
		if (
			!active ||
			active.executorType !== "tedi" ||
			active.executorId !== tedi.id ||
			active.runId !== input.runId ||
			!["running", "waiting", "retrying"].includes(active.runtimeState) ||
			!active.expiresAt ||
			active.expiresAt <= new Date().toISOString()
		)
			return deny();
		const conversationId = input.conversationId ?? home.conversationId;
		if (input.source === "home") {
			const access = await resolveKernelConversationAccess(context.db, {
				organizationId,
				conversationId,
				descopeUserId: userId,
				required: "read",
			});
			if (!access.allowed) return deny();
		}
		await insertTediRuntimeEvent(context.db, {
			id: crypto.randomUUID(),
			tediId: input.tediId,
			kind: "delegation.authority.evaluated",
			runId: input.runId,
			conversationId: home.conversationId,
			sequence: 0,
			payload: {
				source: "delegation-operator-records",
				memberId: member.id,
				homeRunId: home.id,
				workItemId: input.workItemId,
				recordSource: input.source,
				allowed: true,
				mode: "enforce",
				enforced: true,
			},
			runtimeBackend: "cloudflare-agents",
			organizationId,
			createdAt: new Date().toISOString(),
		});
		if (input.source === "calendar" || input.source === "mail")
			return {
				source: input.source,
				text: "Member record read admitted. The provider gateway must still verify this request's account consent and granted connection.",
			};
		if (input.source === "home") {
			const history = await fetchConversationHistory(
				context.db,
				organizationId,
				conversationId,
			);
			return {
				source: input.source,
				text: JSON.stringify({
					conversationId,
					messages: history.messages,
				}).slice(0, 24000),
			};
		}
		if (input.source === "memory") {
			const rows = await getTopPlatformFacts(context.db, organizationId, {
				tediId: tedi.id,
				limit: 50,
			});
			const visible = rows
				.map((row) => row.fact)
				.filter((fact) =>
					isMemorySearchFactEligible(fact, {
						orgId: organizationId,
						...(tedi.scope === "personal" && tedi.ownerUserId === userId
							? { tediId: tedi.id }
							: {}),
					}),
				);
			const facts = rankByQueryRelevance(
				visible,
				input.query,
				(fact) => fact.content,
			)
				.slice(0, 12)
				.map((fact) => ({
					id: fact.id,
					content: fact.content,
					createdAt: fact.createdAt,
					updatedAt: fact.updatedAt,
				}));
			return {
				source: input.source,
				text: JSON.stringify({ facts, candidateLimit: 50 }).slice(0, 24000),
			};
		}
		const snapshot = await assembleHomeContext(context.db, organizationId, {
			descopeUserId: userId,
			operatorMessage: `What are my commitments, people and follow-ups this week? ${input.query ?? ""}`,
			maxPromptTokens: 6000,
			rankingBudgetMs: 0,
			relevanceRecallBudgetMs: 0,
		});
		const text = renderHomeTurnContext({
			...snapshot,
			facts: [],
			rationale: [],
		});
		return { source: input.source, text: text.slice(0, 24000) };
	});
