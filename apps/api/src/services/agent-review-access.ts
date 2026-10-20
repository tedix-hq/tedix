import { ORPCError } from "@orpc/client";
import {
	getMemberByCanonicalUserId,
	getMemberByUserId,
} from "@tedix/db/queries/organization-members";
import { getProjectById } from "@tedix/db/queries/projects";
import { hasProjectWorkItemReference } from "@tedix/db/queries/work-items/project-access";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import type { BaseContext } from "../rpc/context";
import { agentReviewProjectId } from "./agent-review-config";

async function agentReviewProjectScope(context: BaseContext) {
	const projectId = agentReviewProjectId(context.env);
	if (!projectId) return undefined;
	const project = await getProjectById(context.db, projectId);
	if (!project)
		throw new ORPCError("SERVICE_UNAVAILABLE", {
			message: "Private review policy unavailable",
		});

	if (context.organizationId === project.orgId) {
		if (
			(context.authType === "tedi" || context.authType === "service-binding") &&
			context.tediId === project.leadTediId
		)
			return { project, allowed: true };
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
				return { project, allowed: true };
			}
		}
	}

	return { project, allowed: false };
}

/** Restrict a collection query before counting or paging; direct-access guards remain strict. */
export async function excludedAgentReviewProjectId(
	context: BaseContext,
	organizationId: string,
): Promise<string | undefined> {
	const scope = await agentReviewProjectScope(context);
	return scope && !scope.allowed && scope.project.orgId === organizationId
		? scope.project.id
		: undefined;
}

/** Runs inside authentication, covering RPC, REST and forwarded MCP calls. */
export async function guardAgentReviewAccess<T extends { output: unknown }>(
	context: BaseContext,
	input: unknown,
	next: () => Promise<T>,
	path?: readonly string[],
): Promise<T> {
	const scope = await agentReviewProjectScope(context);
	const policy = scope?.project.metadata?.agentReviewTriage;
	if (
		scope &&
		policy &&
		typeof policy === "object" &&
		!Array.isArray(policy) &&
		typeof policy.tediId === "string" &&
		context.tediId === policy.tediId &&
		(context.authType === "tedi" || context.authType === "service-binding")
	) {
		const denied = () =>
			new ORPCError("FORBIDDEN", {
				message:
					"Review triage is restricted to proposed Work and comments in its project",
			});
		const endpoint = path?.join("/");
		if (
			context.organizationId !== scope.project.orgId ||
			![
				"workItems/list",
				"workItems/getById",
				"workItems/create",
				"workItems/addComment",
			].includes(endpoint ?? "")
		)
			throw denied();
		const args = input as Record<string, unknown>;
		if (!args || typeof args !== "object") throw denied();
		if (endpoint === "workItems/list" || endpoint === "workItems/create") {
			if (args.projectId !== scope.project.id) throw denied();
		}
		if (endpoint === "workItems/create") {
			const allowed = new Set([
				"title",
				"description",
				"projectId",
				"parentWorkItemId",
				"workKind",
				"riskLevel",
				"priority",
				"requiredCapabilities",
				"requiredAuthorities",
			]);
			if (Object.keys(args).some((key) => !allowed.has(key))) throw denied();
			if (
				(Array.isArray(args.requiredCapabilities) &&
					args.requiredCapabilities.length) ||
				(Array.isArray(args.requiredAuthorities) &&
					args.requiredAuthorities.length)
			)
				throw denied();
		}
		if (
			endpoint === "workItems/addComment" &&
			(args.requestDelegation ||
				(args.metadata &&
					Object.keys(args.metadata as object).some(
						(key) => key !== "agentReviewTriageResult",
					)))
		)
			throw denied();
		for (const key of ["id", "parentWorkItemId"]) {
			if (args[key] !== undefined) {
				if (typeof args[key] !== "string") throw denied();
				const item = await getWorkItemById(
					context.db,
					args[key] as string,
					scope.project.orgId,
				);
				if (item?.projectId !== scope.project.id) throw denied();
			}
		}
		return next();
	}
	if (!scope || scope.allowed) return next();
	const projectId = scope.project.id;
	const orgId = scope.project.orgId;

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
