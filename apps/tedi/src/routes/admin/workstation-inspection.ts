import { RepositoryInspectionRequestSchema } from "@tedix/api-contract/schemas/workstation";
import { createDbClient } from "@tedix/db/client";
import { getWorkstationInspectionAuthority } from "@tedix/db/queries/workstations";
import { getAuthoritativeWorkItemAttempt } from "@tedix/db/queries/work-items/attempts";
import type { Context } from "hono";
import type { AppEnv } from "../../types";
import { inspectWorkstationRepository } from "../../workstation/computer-body";

const required = (value: unknown) =>
	typeof value === "string" && value.length > 0 ? value : null;

export async function inspectRepositoryRoute(c: Context<AppEnv>) {
	const body = (await c.req.json().catch(() => null)) as Record<
		string,
		unknown
	> | null;
	const leaseId = required(body?.leaseId);
	const workItemId = required(body?.workItemId);
	const attemptId = required(body?.attemptId);
	const generationId = required(body?.generationId);
	const request = RepositoryInspectionRequestSchema.safeParse(body);
	const tedi = c.get("tediConfig");
	if (
		!leaseId ||
		!workItemId ||
		!attemptId ||
		!generationId ||
		!request.success
	)
		return c.json({ error: "invalid repository inspection request" }, 400);
	if (!tedi.organizationId)
		return c.json({ error: "organization required" }, 403);
	const db = createDbClient(c.env.DB);
	const before = await getWorkstationInspectionAuthority(db, {
		orgId: tedi.organizationId,
		workItemId,
		attemptId,
		tediId: tedi.id,
	});
	if (
		!before ||
		before.workstationLease.id !== leaseId ||
		before.workstationLease.bodyGenerationId !== generationId ||
		!before.workstationLease.repositoryPath ||
		!before.workstationLease.preparedStartSha ||
		before.workstationLease.bodyInstanceName !==
			c.get("workstationBodyInstance")?.name
	)
		return c.json(
			{ error: "repository inspection authority unavailable" },
			409,
		);
	try {
		await getAuthoritativeWorkItemAttempt(db, {
			orgId: tedi.organizationId,
			workItemId,
			attemptId,
			executor: { type: "tedi", id: tedi.id },
		});
	} catch {
		return c.json({ error: "Work Attempt is no longer authoritative" }, 409);
	}
	const result = await inspectWorkstationRepository(c.get("sandbox"), {
		...request.data,
		repositoryPath: before.workstationLease.repositoryPath,
		baselineSha: before.workstationLease.preparedStartSha,
	});
	const after = await getWorkstationInspectionAuthority(db, {
		orgId: tedi.organizationId,
		workItemId,
		attemptId,
		tediId: tedi.id,
	});
	try {
		await getAuthoritativeWorkItemAttempt(db, {
			orgId: tedi.organizationId,
			workItemId,
			attemptId,
			executor: { type: "tedi", id: tedi.id },
		});
	} catch {
		return c.json({ error: "Work Attempt expired during inspection" }, 409);
	}
	if (
		!after ||
		after.workstationLease.id !== leaseId ||
		after.workstationLease.bodyGenerationId !== generationId ||
		after.workstationLease.bodyInstanceName !==
			before.workstationLease.bodyInstanceName ||
		after.workstationLease.repositoryPath !==
			before.workstationLease.repositoryPath ||
		after.workstationLease.preparedStartSha !==
			before.workstationLease.preparedStartSha
	)
		return c.json({ error: "repository inspection authority changed" }, 409);
	return c.json({
		...result,
		baselineSha: before.workstationLease.preparedStartSha,
		generationId,
		observedAt: new Date().toISOString(),
		nonAtomic: true as const,
	});
}
