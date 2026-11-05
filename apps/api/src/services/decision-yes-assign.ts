import { call } from "@orpc/server";
import { humanReservedActionClasses } from "@tedix/api-contract/utils/approval-policy";
import {
	addWorkItemCommentIfAbsent,
	getWorkItemCommentById,
} from "@tedix/db/queries/work-items/comments";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import { resolveWorkItemSteward } from "@tedix/db/queries/work-items/stewardship";
import { getTedisByOrganization } from "@tedix/db/queries/tedis";
import { safeExceptionTopology } from "../lib/safe-log-metadata";
import type { BaseContext } from "../rpc/orpc";

/** The lane a local dispatcher serves when none is named (`tedix lane serve`). */
export const DEFAULT_CODING_LANE = "codex";

export function yesAssignCommentId(workItemId: string) {
	return `decision-yes-assign:${workItemId}`;
}

type Work = NonNullable<Awaited<ReturnType<typeof getWorkItemById>>>;

/** Why a Yes must not pick an agent for this Work, or null when it may. */
export function yesAssignBlocker(work: Work): string | null {
	const executor = work.metadata?.executor;
	if (typeof executor === "string" && executor)
		return `it already has an executor (${executor})`;
	if (work.riskLevel === "high" || work.riskLevel === "critical")
		return `it is ${work.riskLevel}-risk, and changing it would void its approval`;
	const reserved = humanReservedActionClasses(
		`${work.title}\n${work.description ?? ""}\n${work.acceptanceContract?.doneLooksLike ?? ""}`,
	);
	if (reserved.length)
		return `it may need a person (${reserved.join(", ")}), and changing it would void its approval`;
	return null;
}

/** Its steward tedi, else the organization's stewardship policy, else Home. */
async function stewardTedi(
	context: BaseContext,
	work: Work,
): Promise<{ id: string; name: string } | null> {
	const tedis = await getTedisByOrganization(context.db, work.orgId);
	const named = (id: string | undefined | null) => {
		const tedi = id
			? tedis.find((row) => row.id === id && row.status === "active")
			: undefined;
		return tedi ? { id: tedi.id, name: tedi.displayName || tedi.name } : null;
	};
	const steward = work.stewardType === "tedi" ? named(work.stewardId) : null;
	if (steward) return steward;
	const policy = await resolveWorkItemSteward(context.db, {
		orgId: work.orgId,
		projectId: work.projectId ?? undefined,
		workKind: work.workKind,
	});
	if (policy.stewardId && named(policy.stewardId))
		return named(policy.stewardId);
	const { proposalTedi } =
		await import("../rpc/routers/work-items/proposal-start");
	return proposalTedi(context, work.orgId, undefined);
}

/**
 * A person's Yes accepted this Work: give it an agent so it starts. Coding Work
 * goes to the default local coding lane; other Work to its steward tedi (or
 * Home) through a Home delegation. One receipt comment per Work latches the
 * choice, and Work an agent must not take is left alone with the reason.
 * Fail-soft: the answer and the acceptance already stand.
 */
export async function assignAgentOnYes(
	context: BaseContext,
	p: { orgId: string; workItemId: string; personId: string },
): Promise<{ executor: string; tediId?: string } | { skipped: string } | null> {
	const commentId = yesAssignCommentId(p.workItemId);
	const note = (body: string, metadata: Record<string, string>) =>
		addWorkItemCommentIfAbsent(context.db, {
			id: commentId,
			orgId: p.orgId,
			workItemId: p.workItemId,
			authorType: "user",
			authorId: p.personId,
			recordActivity: true,
			body,
			metadata: { schema: "tedix.decision-yes-assign.v1", ...metadata },
			createdAt: new Date().toISOString(),
		});
	try {
		if (await getWorkItemCommentById(context.db, commentId)) return null;
		const work = await getWorkItemById(context.db, p.workItemId, p.orgId);
		if (!work || work.disposition !== "accepted") return null;
		const blocker = yesAssignBlocker(work);
		if (blocker) {
			await note(
				`Not assigned to an agent automatically after your Yes: ${blocker}. Set an executor by hand when it should start.`,
				{ outcome: "skipped", reason: blocker },
			);
			return { skipped: blocker };
		}
		const coding = work.workKind === "coding";
		const tedi = coding ? null : await stewardTedi(context, work);
		if (!coding && !tedi) {
			const reason = "this organization has no tedi to hand it to";
			await note(
				`Not assigned to an agent automatically after your Yes: ${reason}.`,
				{ outcome: "skipped", reason },
			);
			return { skipped: reason };
		}
		const executor = coding ? DEFAULT_CODING_LANE : "tedi";
		const { workItemsContractRouter } =
			await import("../rpc/routers/work-items");
		await call(
			workItemsContractRouter.updateSpecification,
			{
				id: work.id,
				expectedWorkItemVersion: work.version,
				executor,
				laneDispatch: { state: "ready" },
				...(tedi && work.stewardType !== "tedi"
					? { stewardType: "tedi" as const, stewardId: tedi.id }
					: {}),
			},
			{ context },
		);
		if (coding) {
			await note(
				`Assigned to the ${executor} coding lane after your Yes; a local lane dispatcher starts it.`,
				{ outcome: "assigned", executor },
			);
			return { executor };
		}
		await note(
			`Assigned to ${tedi!.name} after your Yes; asked through Home to start it.`,
			{ outcome: "assigned", executor, tediId: tedi!.id },
		);
		const { proposalStartActions } =
			await import("../rpc/routers/work-items/proposal-start");
		await proposalStartActions().delegate(context, {
			content: `You steward this Work and the person said Yes to it. Do the first step now within your own authority, record the result on the Work, settle your Attempt and complete the Work once its done-when holds. If a step truly needs a person, do everything else and ask once on this Work.\n\nWork "${work.title}" (${work.id}). Done when: ${work.acceptanceContract?.doneLooksLike ?? work.title}`,
			tediId: tedi!.id,
			idempotencyKey: await seededUuid(`decision-yes:${work.id}`),
			workItemId: work.id,
		});
		return { executor, tediId: tedi!.id };
	} catch (error) {
		console.warn("[decision-yes-assign] agent not assigned", {
			workItemId: p.workItemId,
			exception: safeExceptionTopology(error),
		});
		return null;
	}
}

/** A UUID derived from a seed, so a retried delegation reuses its Home run. */
async function seededUuid(seed: string): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)),
	);
	digest[6] = (digest[6]! & 0x0f) | 0x80;
	digest[8] = (digest[8]! & 0x3f) | 0x80;
	const hex = [...digest.slice(0, 16)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
