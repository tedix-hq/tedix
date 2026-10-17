import type { DbClient } from "@tedix/db/client";
import {
	listStallReceipts,
	listContinuityScopes,
	listContinuityHumanAsks,
} from "@tedix/db/queries/work-items/stall-recovery";
import { assessContinuity } from "../jobs/stall-recovery";

/** Read-only projection: browsing Attention never dispatches a recovery. */
export async function readContinuity(
	db: DbClient,
	orgId: string,
	now: Date,
	after = "",
	userId?: string,
	environment = "production",
) {
	const scopes = await listContinuityScopes(db, after, orgId, environment);
	const assessments = await Promise.all(
		scopes.map((scope) =>
			assessContinuity(db, scope, now.getTime(), environment),
		),
	);
	const [receipts, asks] = await Promise.all([
		listStallReceipts(
			db,
			orgId,
			scopes.map((scope) => scope.key),
			environment,
		),
		userId
			? listContinuityHumanAsks(db, orgId, userId, now.toISOString())
			: Promise.resolve([]),
	]);
	const accepted = new Map(receipts.map((r) => [r.key, r]));
	const stalls = [];
	const promises = [];
	for (const [index, scope] of scopes.entries()) {
		const assessment = assessments[index]!;
		const href =
			scope.kind === "project"
				? `/work/projects/${scope.id}`
				: "/work/portfolio";
		const receipt = accepted.get(scope.key);
		const current =
			receipt?.requestKey === `${assessment.incidentKey}:accepted`;
		if (
			assessment.promise &&
			(!userId || assessment.promise.status === "kept" || current)
		)
			promises.push({
				scopeId: scope.id,
				name: scope.name,
				href,
				...assessment.promise,
			});
		// A raw coverage gap is the system's responsibility. Expose only an accepted
		// recovery or a specific decision addressed to this viewer after that recovery.
		if (!receipt || receipt.tediId !== scope.tediId) continue;
		const ask = asks.find(
			(ask) =>
				ask.creatorId === scope.tediId &&
				(scope.kind === "project"
					? ask.projectId === scope.id
					: ask.objectiveId === scope.id),
		);
		if (
			!ask &&
			!current &&
			now.getTime() - Date.parse(receipt.occurredAt) > 3_600_000
		)
			continue;

		stalls.push({
			scopeId: scope.id,
			name: scope.name,
			cause: ask ? "blocked on a human decision" : assessment.cause,
			reason: ask
				? `waiting for your decision: ${ask.need}`
				: scope.pendingCount === 0
					? "no open work — tedi asked to propose next goals"
					: "tedi resume requested",
			href: ask ? `/work/interactions/${encodeURIComponent(ask.id)}` : href,
			requestedAt: receipt.occurredAt,
			needsYou: !!ask,
		});
	}
	stalls.sort(
		(a, b) =>
			Number(b.needsYou) - Number(a.needsYou) ||
			b.requestedAt.localeCompare(a.requestedAt),
	);
	return {
		stalls,
		promises,
		next: scopes.length === 100 ? scopes.at(-1)!.key : null,
	};
}
