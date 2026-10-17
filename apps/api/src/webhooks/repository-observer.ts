import type { Context } from "hono";
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
/** Verified OIDC claims must bind both the repository and exact reporting workflow. */
export function acceptsObserverClaims(
	config: RepositoryObserverConfig,
	event: RepositoryEvent,
	claims: Record<string, unknown>,
) {
	const push = event.kind === "push";
	const repo = push ? config.repository : config.shipRepository;
	const workflow = push ? config.pushWorkflow : config.shipWorkflow;
	return (
		!!repo &&
		claims.repository === repo &&
		claims.ref === `refs/heads/${config.branch}` &&
		claims.workflow_ref === `${repo}/${workflow}@refs/heads/${config.branch}` &&
		(push
			? claims.event_name === "push" && claims.sha === event.sha
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
		} catch {
			return c.text("Observer unavailable", 404);
		}
		const parsed = RepositoryEventSchema.safeParse(
			await c.req.json().catch(() => null),
		);
		if (!parsed.success || parsed.data.projectId !== projectId)
			return c.text("Invalid event", 400);
		const event = parsed.data;
		const repo =
			event.kind === "push" ? config.repository : config.shipRepository;
		if (!repo) return c.text("Event source unavailable", 403);
		const token = c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "";
		try {
			await verifyGithubActionsWorkloadToken(token, {
				expectedAudience: OBSERVER_AUDIENCE,
				expectedSubject: `repo:${repo}:ref:refs/heads/${config.branch}`,
			});
			const claims = decodeTokenUnsafe(token);
			if (!claims || !acceptsObserverClaims(config, event, claims))
				return c.text("Invalid event identity", 403);
		} catch {
			return c.text("Invalid event identity", 403);
		}
		const context = buildInternalServiceBindingContext(base, orgId);
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
				...(retry ? { operation: { kind: "retry", evidenceUrl: retry } } : {}),
			},
			202,
		);
	};
	await bodyLimit({ maxSize: 128_000 })(c, async () => {
		c.res = await receive();
	});
	return c.res;
}
