import { ORPCError } from "@orpc/client";
import {
	getMemberByCanonicalUserId,
	getMemberByUserId,
} from "@tedix/db/queries/organization-members";
import { getProjectById } from "@tedix/db/queries/projects";
import { hasProjectWorkItemReference } from "@tedix/db/queries/work-items/project-access";
import type { BaseContext } from "../rpc/context";

/** Runs inside authentication, covering RPC, REST and forwarded MCP calls. */
export async function guardAgentReviewAccess<T extends { output: unknown }>(
	context: BaseContext,
	input: unknown,
	next: () => Promise<T>,
): Promise<T> {
	const projectId = context.env.AGENT_REVIEW_PROJECT_ID;
	if (!projectId) return next();
	const project = await getProjectById(context.db, projectId);
	if (!project)
		throw new ORPCError("SERVICE_UNAVAILABLE", {
			message: "Private review policy unavailable",
		});
	const orgId = project.orgId;

	if (context.organizationId === project.orgId) {
		if (
			(context.authType === "tedi" || context.authType === "service-binding") &&
			context.tediId === project.leadTediId
		)
			return next();
		if (context.authType === "user" && context.user?.sub) {
			const member = context.userId
				? ((await getMemberByCanonicalUserId(
						context.db,
						project.orgId,
						context.userId,
					)) ??
					(await getMemberByUserId(
						context.db,
						project.orgId,
						context.user.sub,
					)))
				: await getMemberByUserId(context.db, project.orgId, context.user.sub);
			if (
				member?.status === "active" &&
				(member.role === "owner" || member.role === "admin")
			) {
				return next();
			}
		}
	}

	const checked = new Set<string>();
	const forbidden = () =>
		new ORPCError("FORBIDDEN", {
			message: "Private review project requires an active organization admin",
		});
	async function assertNoReview(value: unknown) {
		const pending: unknown[] = [value];
		const ids = new Set<string>();
		const visited = new Set<object>();
		while (pending.length) {
			const node = pending.pop();
			if (
				!node ||
				typeof node !== "object" ||
				node instanceof Date ||
				visited.has(node)
			)
				continue;
			visited.add(node);
			if (Array.isArray(node)) {
				for (const entry of node) pending.push(entry);
				continue;
			}
			for (const [key, entry] of Object.entries(node)) {
				if (typeof entry === "string" && /id$/i.test(key)) {
					if (entry === projectId) throw forbidden();
					ids.add(entry);
				} else if (/ids$/i.test(key) && Array.isArray(entry)) {
					for (const id of entry)
						if (typeof id === "string") {
							if (id === projectId) throw forbidden();
							ids.add(id);
						}
				}
				if (entry && typeof entry === "object") pending.push(entry);
			}
		}
		const unchecked = [...ids].filter((id) => !checked.has(id));
		if (
			await hasProjectWorkItemReference(context.db, {
				orgId,
				projectId,
				ids: unchecked,
			})
		)
			throw forbidden();
		for (const id of unchecked) checked.add(id);
	}

	// Check ids before mutations; also deny aggregate/list responses containing
	// reviews, comments, evidence or nested project data. Never partially emit them.
	await assertNoReview(input);
	const result = await next();
	await assertNoReview(result.output);
	return result;
}
