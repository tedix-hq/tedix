import { organizationModelEnv } from "./unrouted-model-egress";
import * as z from "zod";
import { hasPermission } from "@tedix/auth/rbac";
import {
	getMemberByUserId,
	getMemberByCanonicalUserId,
} from "@tedix/db/queries/organization-members";
import { createDbClient } from "@tedix/db/client";
import {
	pendingFilingLessons,
	listUnfiledRequests,
	countUnfiledRequests,
} from "@tedix/db/queries/request-filings";
import { workersAiLedgerModel } from "./agent-session-request-ledger";
import { requestFilingFitModel } from "./request-filing-fit";
import { requestFilingSettings } from "./request-filing-settings";
import { autoFileRequests } from "./request-auto-filing";

// Kept outside AutomationEventSchema: public automation producers cannot choose a private ledger owner.
export const RequestFilingQueueSchema = z.strictObject({
	kind: z.literal("request_filing"),
	organizationId: z.uuid(),
	userId: z.string().min(1),
	ownerSubject: z.string().min(1),
});
export async function enqueueRequestFiling(
	env: CloudflareEnv,
	owner: { organizationId: string; userId: string; ownerSubject: string },
) {
	if (!env.AUTOMATION_EVENTS)
		throw new Error("Request filing queue unavailable");
	await env.AUTOMATION_EVENTS.send({
		kind: "request_filing",
		organizationId: owner.organizationId,
		userId: owner.userId,
		ownerSubject: owner.ownerSubject,
	});
}
export async function processRequestFilingQueue(
	env: CloudflareEnv,
	owner: { organizationId: string; userId: string; ownerSubject: string },
	limit = 10,
) {
	const db = createDbClient(env.DB);
	const member =
		(await getMemberByCanonicalUserId(
			db,
			owner.organizationId,
			owner.userId,
		)) ??
		(await getMemberByUserId(db, owner.organizationId, owner.ownerSubject));
	if (member?.status !== "active") return { state: "inactive_owner" as const };
	const { recordFilingCorrectionLesson } =
		await import("./request-ledger-lessons");
	for (const event of await pendingFilingLessons(db, owner))
		await recordFilingCorrectionLesson(db, event);
	const settings = await requestFilingSettings(db, owner);
	if (!settings.enabled) return { state: "paused" as const };
	if (
		!hasPermission(
			{ roles: [member.role], permissions: member.customPermissions ?? [] },
			"tedis:update",
		)
	)
		return { state: "permission_denied" as const };
	const model = workersAiLedgerModel(
		organizationModelEnv(env, db, owner.organizationId),
	);
	model.scoreProjectFit = requestFilingFitModel(
		db,
		organizationModelEnv(env, db, owner.organizationId),
		owner.organizationId,
	);
	await autoFileRequests(
		db,
		model,
		{
			...owner,
			learningOwnerId: owner.ownerSubject,
			intakeProjectId: settings.intakeProjectId,
			now: new Date().toISOString(),
		},
		limit,
	);
	const { materializeFilingReviews } =
		await import("./decision-filing-reviews");
	await materializeFilingReviews(db, owner);
	if (
		(await listUnfiledRequests(db, owner)).length ||
		(await pendingFilingLessons(db, owner)).length
	)
		await enqueueRequestFiling(env, owner);
	return {
		state: "processed" as const,
		pending: await countUnfiledRequests(db, owner),
	};
}
