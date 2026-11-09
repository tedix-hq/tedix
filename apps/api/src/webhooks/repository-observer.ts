import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { COMMON_ERROR_STATUS_MAP, ORPCError } from "@orpc/server";
import { verifyGithubActionsWorkloadToken } from "@tedix/auth/workload-identity";
import { decodeTokenUnsafe } from "@tedix/auth/jwt";
import {
	RepositoryEventSchema,
	type RepositoryObserverConfig,
	type RepositoryEvent,
} from "@tedix/api-contract/schemas/repository-observer";
import { claimRepositoryRetryDelivery } from "@tedix/db/queries/repository-observer";
import { createContext } from "../rpc/orpc";
import { buildInternalServiceBindingContext } from "../rpc/routers/kernel/runtime-shared";
import {
	observerConfig,
	observeRepositoryEvent,
} from "../services/repository-observer";
export const OBSERVER_AUDIENCE = "tedix:repository-observer";
export function observerSubject(
	repository: string,
	branch: string,
	claims: Record<string, unknown>,
): string | null {
	// Jobs running in a GitHub environment mint environment-scoped subjects.
	// Both contexts bind the same repository identity; the environment name is
	// matched exactly against the token's own signed `environment` claim.
	const contexts = [`ref:refs/heads/${branch}`];
	if (typeof claims.environment === "string" && claims.environment)
		contexts.push(`environment:${claims.environment.replaceAll(":", "%3A")}`);
	for (const context of contexts) {
		const legacy = `repo:${repository}:${context}`;
		if (claims.sub === legacy) return legacy;
		const ownerId = claims.repository_owner_id;
		const repositoryId = claims.repository_id;
		if (
			typeof ownerId !== "string" ||
			!/^[1-9]\d*$/.test(ownerId) ||
			typeof repositoryId !== "string" ||
			!/^[1-9]\d*$/.test(repositoryId)
		)
			continue;
		const [owner, name] = repository.split("/");
		const immutable = `repo:${owner}@${ownerId}/${name}@${repositoryId}:${context}`;
		if (claims.sub === immutable) return immutable;
	}
	return null;
}
/** Verified OIDC claims must bind both the repository and exact reporting workflow. */
export function acceptsObserverClaims(
	config: RepositoryObserverConfig,
	event: RepositoryEvent,
	claims: Record<string, unknown>,
) {
	const push = event.kind === "push";
	const ci = event.kind === "ci_red" || event.kind === "ci_green";
	const repo = push || ci ? config.repository : config.shipRepository;
	const workflow = push || ci ? config.pushWorkflow : config.shipWorkflow;
	// On chained triggers (workflow_run, workflow_call) GitHub splits the entry
	// and the executed workflow across workflow_ref and job_workflow_ref; the
	// executing file may land in either claim, so the configured workflow must
	// match one of them — a token naming it nowhere is still rejected.
	const expected = `${repo}/${workflow}@refs/heads/${config.branch}`;
	return (
		!!repo &&
		claims.repository === repo &&
		claims.ref === `refs/heads/${config.branch}` &&
		(claims.workflow_ref === expected ||
			claims.job_workflow_ref === expected) &&
		(push
			? claims.event_name === "push" && claims.sha === event.sha
			: ci
				? claims.event_name === "workflow_run"
				: ["workflow_run", "schedule"].includes(String(claims.event_name)))
	);
}
export async function handleRepositoryObserverWebhook(
	c: Context<{ Bindings: CloudflareEnv }>,
) {
	const { bodyLimit } = await import("hono/body-limit");
	const receive = async () => {
		const projectId = c.req.param("projectId")!;
		const orgId = c.req.param("orgId")!;
		const base = createContext(c.req.raw, c.env, (p) =>
			c.executionCtx.waitUntil(p),
		);
		let config: RepositoryObserverConfig;
		try {
			config = (await observerConfig(base, orgId, projectId)).config;
		} catch (error) {
			// Only a missing or inactive configuration is a 404. A failed read is
			// a server error the notify step may retry, not "not configured".
			if (error instanceof ORPCError && error.code === "NOT_FOUND")
				return c.text("Observer unavailable", 404);
			throw error;
		}
		const parsed = RepositoryEventSchema.safeParse(
			await c.req.json().catch(() => null),
		);
		if (!parsed.success || parsed.data.projectId !== projectId)
			return c.text("Invalid event", 400);
		const event = parsed.data;
		const repo =
			event.kind === "push" ||
			event.kind === "ci_red" ||
			event.kind === "ci_green"
				? config.repository
				: config.shipRepository;
		if (!repo) return c.text("Event source unavailable", 403);
		const token = c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "";
		try {
			const claims = decodeTokenUnsafe(token);
			const subject = claims && observerSubject(repo, config.branch, claims);
			if (!claims || !subject || !acceptsObserverClaims(config, event, claims))
				return c.text("Invalid event identity", 403);
			// Decoded claims only select an exact subject; verification authenticates them.
			await verifyGithubActionsWorkloadToken(token, {
				expectedAudience: OBSERVER_AUDIENCE,
				expectedSubject: subject,
			});
		} catch {
			return c.text("Invalid event identity", 403);
		}
		const context = buildInternalServiceBindingContext(base, orgId);
		try {
			const receipt = await observeRepositoryEvent(context, orgId, event);
			const retry =
				event.kind === "ship_red"
					? await claimRepositoryRetryDelivery(
							context.db,
							orgId,
							receipt.observationId,
						)
					: null;
			return c.json(
				{
					...receipt,
					...(retry
						? { operation: { kind: "retry", evidenceUrl: retry } }
						: {}),
				},
				202,
			);
		} catch (error) {
			if (
				error instanceof ORPCError &&
				Object.hasOwn(COMMON_ERROR_STATUS_MAP, error.code)
			) {
				const status =
					COMMON_ERROR_STATUS_MAP[
						error.code as keyof typeof COMMON_ERROR_STATUS_MAP
					];
				if (status >= 400 && status < 500) {
					throw new HTTPException(status as ContentfulStatusCode, {
						message: error.code,
						cause: error,
					});
				}
			}
			throw error;
		}
	};
	await bodyLimit({ maxSize: 128_000 })(c, async () => {
		c.res = await receive();
	});
	return c.res;
}
