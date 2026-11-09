import * as z from "zod";
import { createDbClient } from "@tedix/db/client";
import { getMemberByCanonicalUserId } from "@tedix/db/queries/organization-members";
import { listPendingAgentSessionEvents } from "@tedix/db/queries/agent-session-requests";
import { captureLocalKernelRequests } from "../kernel/request-local-source";
import { organizationModelEnv } from "./unrouted-model-egress";
import {
	processAgentSessionEvents,
	workersAiLedgerModel,
} from "./agent-session-request-ledger";
import { enqueueRequestFiling } from "./request-filing-queue";
import { automaticFilingEnabled } from "./request-filing-settings";
import {
	ledgerLessonNoveltyModel,
	recordLedgerLessonCandidates,
} from "./request-ledger-lessons";

// Private queue messages cannot be submitted through public automation producers.
export const AgentSessionEventQueueSchema = z.strictObject({
	kind: z.literal("agent_session_events"),
	organizationId: z.string().min(1),
	userId: z.string().min(1),
});
type Owner = { organizationId: string; userId: string };

export async function enqueueAgentSessionEvents(
	env: CloudflareEnv,
	owner: Owner,
	delaySeconds = 0,
) {
	if (!env.AUTOMATION_EVENTS)
		throw new Error("Session event queue unavailable");
	await env.AUTOMATION_EVENTS.send(
		{
			kind: "agent_session_events",
			organizationId: owner.organizationId,
			userId: owner.userId,
		},
		{ delaySeconds },
	);
}

export async function processAgentSessionEventQueue(
	env: CloudflareEnv,
	owner: Owner,
) {
	const db = createDbClient(env.DB);
	const member = await getMemberByCanonicalUserId(
		db,
		owner.organizationId,
		owner.userId,
	);
	if (member?.status !== "active") return;
	const modelEnv = organizationModelEnv(env, db, owner.organizationId);
	const model = workersAiLedgerModel(modelEnv, owner.organizationId);
	model.enqueueFilings = async () => {
		if (await automaticFilingEnabled(db, owner))
			await enqueueRequestFiling(env, {
				...owner,
				ownerSubject: member.descopeUserId,
			});
	};
	model.learn = async (lessons, scope) => {
		if (lessons.length)
			await recordLedgerLessonCandidates(
				db,
				lessons,
				{ ...scope, ownerUserId: member.descopeUserId },
				ledgerLessonNoveltyModel(modelEnv),
			);
	};
	const processed = await processAgentSessionEvents(db, model, owner, {
		onRecorded: (scope) =>
			captureLocalKernelRequests({ db, userId: owner.userId }, scope),
	});
	const [next] = await listPendingAgentSessionEvents(db, {
		...owner,
		limit: 1,
		now: new Date().toISOString(),
	});
	if (next) await enqueueAgentSessionEvents(env, owner, processed ? 0 : 10);
	console.log(
		JSON.stringify({
			event: "agent_session_events.drain",
			organizationId: owner.organizationId,
			userId: owner.userId,
			processed,
			continued: Boolean(next),
		}),
	);
}
