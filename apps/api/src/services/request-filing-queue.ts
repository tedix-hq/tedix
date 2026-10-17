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
} from "@tedix/db/queries/request-filings";
import { workersAiLedgerModel } from "./agent-session-request-ledger";
import { requestFilingFitModel } from "./request-filing-fit";
import { automaticFilingEnabled } from "./request-filing-settings";
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
) {
	const db = createDbClient(env.DB);
	const member =
		(await getMemberByCanonicalUserId(
			db,
			owner.organizationId,
			owner.userId,
		)) ??
		(await getMemberByUserId(db, owner.organizationId, owner.ownerSubject));
	if (member?.status !== "active") return;
	const { recordFilingCorrectionLesson } =
		await import("./request-ledger-lessons");
	for (const event of await pendingFilingLessons(db, owner))
		await recordFilingCorrectionLesson(db, event);
	if (
		!(await automaticFilingEnabled(db, owner)) ||
		!hasPermission(
			{ roles: [member.role], permissions: member.customPermissions ?? [] },
			"tedis:update",
		)
	)
		return;
	const model = workersAiLedgerModel(env);
	model.scoreProjectFit = requestFilingFitModel(db, env, owner.organizationId);
	await autoFileRequests(
		db,
		model,
		{
			...owner,
			learningOwnerId: owner.ownerSubject,
			now: new Date().toISOString(),
		},
		10,
	);
	const { materializeFilingReviews } =
		await import("./decision-filing-reviews");
	await materializeFilingReviews(db, owner);
	if (
		(await listUnfiledRequests(db, owner)).length ||
		(await pendingFilingLessons(db, owner)).length
	)
		await enqueueRequestFiling(env, owner);
}
