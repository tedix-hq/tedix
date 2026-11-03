import { RepositoryCandidateAccessInputSchema } from "@tedix/api-contract/schemas/repository-candidate";
import { roleImpliesPermission } from "@tedix/auth/rbac";
import { createDbClient, type DbClient } from "@tedix/db/client";
import { resolveActiveExternalAgentSession } from "@tedix/db/queries/external-agent-identity/sessions";
import { getTediById } from "@tedix/db/queries/tedis";
import {
	getMemberAccessByUserId,
	getMemberByCanonicalUserId,
} from "@tedix/db/queries/organization-members";
import {
	getRecordedWorkItemAttempt,
	getWorkAttemptRepositoryAdmission,
} from "@tedix/db/queries/work-items/attempts";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import type { WorkAttempt, WorkItem } from "@tedix/db/schema/work-items";
import {
	liveRepositoryCandidateScope,
	recordedRepositoryCandidate,
	RepositoryCandidateError,
} from "./work-repository-draft";

export async function assertRepositoryCandidateAdmission(
	db: DbClient,
	work: WorkItem,
	attempt: WorkAttempt,
) {
	liveRepositoryCandidateScope(work, attempt);
	const admission = await getWorkAttemptRepositoryAdmission(db, attempt);
	if (
		!admission ||
		admission.admissionSpecRevision !== work.admissionSpecRevision
	)
		throw new RepositoryCandidateError(
			"Attempt repository admission no longer matches this Work",
		);
	if (attempt.executorType === "external_agent") {
		const active = attempt.executorSessionId
			? await resolveActiveExternalAgentSession(db, {
					organizationId: work.orgId,
					principalId: attempt.executorId,
					sessionId: attempt.executorSessionId,
				})
			: null;
		if (
			!active ||
			!attempt.externalSessionKey ||
			active.session.externalSessionKey !== attempt.externalSessionKey
		)
			throw new RepositoryCandidateError(
				"Repository candidate executor session is no longer active",
			);
	} else {
		const tedi = await getTediById(db, attempt.executorId);
		if (!tedi || tedi.organizationId !== work.orgId || tedi.retiredAt !== null)
			throw new RepositoryCandidateError(
				"Repository candidate executor is no longer active",
			);
	}
}

/** Trusted OS binding only: no browser-supplied identity reaches this handler. */
export async function repositoryCandidateAccess(
	request: Request,
	env: Pick<CloudflareEnv, "DB">,
) {
	if (request.method !== "POST") return new Response(null, { status: 405 });
	const parsed = RepositoryCandidateAccessInputSchema.safeParse(
		await request.json().catch(() => null),
	);
	if (!parsed.success) return new Response(null, { status: 400 });
	const denied = () =>
		Response.json({ allowed: false, roles: {}, expiresAt: null });
	const db = createDbClient(env.DB);
	const { descriptor, userIds } = parsed.data;
	const [work, attempt] = await Promise.all([
		getWorkItemById(db, descriptor.workItemId, descriptor.organizationId),
		getRecordedWorkItemAttempt(db, {
			orgId: descriptor.organizationId,
			workItemId: descriptor.workItemId,
			attemptId: descriptor.attemptId,
		}),
	]);
	if (!work || !attempt) return denied();
	try {
		await assertRepositoryCandidateAdmission(db, work, attempt);
		if (
			JSON.stringify(recordedRepositoryCandidate(work, attempt)) !==
			JSON.stringify(descriptor)
		)
			return denied();
	} catch (error) {
		if (error instanceof RepositoryCandidateError) return denied();
		throw error;
	}
	const roles = await Promise.all(
		[...new Set(userIds)].map(async (userId) => {
			const member =
				(await getMemberByCanonicalUserId(
					db,
					descriptor.organizationId,
					userId,
				)) ??
				(await getMemberAccessByUserId(db, descriptor.organizationId, userId));
			return [
				userId,
				member?.status === "active" &&
				(member.role === "owner" || member.role === "admin") &&
				roleImpliesPermission([member.role], "secrets:manage")
					? "build"
					: null,
			] as const;
		}),
	);
	return Response.json({
		allowed: true,
		roles: Object.fromEntries(roles),
		expiresAt: attempt.expiresAt,
	});
}
