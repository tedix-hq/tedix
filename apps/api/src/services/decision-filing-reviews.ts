import * as z from "zod";
import type { DbQueryClient } from "@tedix/db/query-client";
import type { AgentSessionRequestOwner } from "@tedix/db/queries/agent-session-requests";
import { listRequestFilings } from "@tedix/db/queries/request-filings";
import { getUserConfig } from "@tedix/db/queries/user-configs";
import {
	createWorkInteraction,
	getWorkInteraction,
} from "@tedix/db/queries/work-items/interactions";
import { attentionProjectBriefs } from "@tedix/db/queries/work-attention";
import { REQUEST_FILING_POLICY } from "@tedix/api-contract/schemas/request-filing-policy";

const ConfigSchema = z.object({ enabled: z.boolean().default(true) });

/** Filing corrections stay available in Automatic filing; one daily FYI never asks for approval. */
export async function materializeFilingReviews(
	db: DbQueryClient,
	owner: AgentSessionRequestOwner,
	now = new Date().toISOString(),
) {
	const saved = await getUserConfig(db, {
		userId: owner.userId,
		namespace: `organization:${owner.organizationId}`,
		key: "decision-filing-reviews",
	});
	if (!ConfigSchema.parse(saved?.value ?? {}).enabled) return;
	const [history, projects] = await Promise.all([
		listRequestFilings(db, owner),
		attentionProjectBriefs(db, owner.organizationId),
	]);
	const latest = new Map<string, (typeof history)[number]>();
	for (const event of history)
		if (event.targetId && !latest.has(event.targetId))
			latest.set(event.targetId, event);
	const uncertain = [...latest.values()].filter(
		({ metadata: meta }) =>
			meta?.by === "auto" &&
			(meta.pending === true ||
				typeof meta.confidence !== "number" ||
				meta.confidence < REQUEST_FILING_POLICY.autoApplyConfidence),
	);
	const project = projects.find((p) =>
		uncertain.some(
			({ metadata: meta }) =>
				meta?.projectId === p.id || meta?.suggestedProjectId === p.id,
		),
	);
	if (!uncertain.length || !project) return;
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			`filing-digest:${owner.organizationId}:${owner.userId}:${now.slice(0, 10)}`,
		),
	);
	const hex = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
	const scope = { orgId: owner.organizationId, interactionId: id };
	if (await getWorkInteraction(db, scope)) return;
	try {
		await createWorkInteraction(db, {
			id,
			orgId: owner.organizationId,
			projectId: project.id,
			kind: "coordination",
			subject: "Some requests need a better project match",
			prompt:
				"Confident project matches are applied automatically. Uncertain matches stay unfiled. Review or undo destinations in Automatic filing; no approval is needed and no underlying action is authorized.",
			creator: { type: "user", id: owner.userId },
			targetType: "user",
			targetId: owner.userId,
			expiresAt: new Date(
				Date.parse(now) + REQUEST_FILING_POLICY.digestExpiryDays * 86400000,
			).toISOString(),
			metadata: {
				source: "request-auto-filing-digest",
				schema: "tedix.decision-capture.v1",
				attention: { kind: "fyi" },
				filingReviewSource: "/work/attention#attention-unfiled",
				policyVersion: REQUEST_FILING_POLICY.version,
			},
			now,
		});
	} catch (error) {
		if (!(await getWorkInteraction(db, scope))) throw error;
	}
}
