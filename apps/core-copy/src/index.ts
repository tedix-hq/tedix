import {
	extractBearerToken,
	secureEqual,
} from "@tedix/worker-kit/request-auth";
import {
	applySchema,
	copyStatus,
	copyTable,
	cronTick,
	hyperdriveQuery,
	resetCopy,
	verifyTable,
	type CopyPorts,
} from "./copy.ts";
import type { Env } from "./env.ts";
import { doCheckpointStore, ProgressStore } from "./store.ts";

export { CheckpointDO } from "./checkpoint-do.ts";

/**
 * Shared-secret gate for every admin route. Returns the refusal Response, or
 * null when the request carries CORE_COPY_ADMIN_TOKEN.
 */
async function requireAdmin(
	request: Request,
	env: Env,
): Promise<Response | null> {
	const token = env.CORE_COPY_ADMIN_TOKEN;
	if (!token)
		return Response.json(
			{ error: "CORE_COPY_ADMIN_TOKEN is not configured" },
			{ status: 503 },
		);
	const header = request.headers.get("x-tedix-core-copy-token");
	const bearer = extractBearerToken(request.headers.get("authorization"));
	if ((await secureEqual(header, token)) || (await secureEqual(bearer, token)))
		return null;
	return Response.json({ error: "unauthorized" }, { status: 401 });
}

function portsFor(env: Env): { ports: CopyPorts; end(): Promise<void> } {
	const { query, copyQuery, end } = hyperdriveQuery(
		env.HYPERDRIVE.connectionString,
	);
	return {
		ports: {
			readD1: async (sql, params) => {
				const result = await env.DB.prepare(sql)
					.bind(...params)
					.all();
				return result.results as Record<string, unknown>[];
			},
			query,
			copyQuery,
			store: new ProgressStore(doCheckpointStore(env.COPY_CHECKPOINTS, env)),
		},
		end,
	};
}

function jsonError(error: unknown): Response {
	const message = error instanceof Error ? error.message : String(error);
	const status = /Unknown copy table|No checkpoint/.test(message) ? 404 : 500;
	return Response.json({ error: message }, { status });
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/schema" && request.method === "POST") {
			const denied = await requireAdmin(request, env);
			if (denied) return denied;
			const { ports, end } = portsFor(env);
			try {
				return Response.json(await applySchema(ports.query));
			} catch (error) {
				return jsonError(error);
			} finally {
				await end();
			}
		}
		if (url.pathname === "/copy" && request.method === "POST") {
			const denied = await requireAdmin(request, env);
			if (denied) return denied;
			const table = url.searchParams.get("table");
			if (!table)
				return Response.json(
					{ error: "table parameter required" },
					{ status: 400 },
				);
			const { ports, end } = portsFor(env);
			try {
				const positive = (name: string) => {
					const raw = url.searchParams.get(name);
					const value = raw === null ? undefined : Number(raw);
					return value !== undefined && Number.isInteger(value) && value > 0
						? value
						: undefined;
				};
				return Response.json(
					await copyTable(ports, table, {
						maxPages: positive("maxPages"),
						pageSize: positive("size"),
					}),
				);
			} catch (error) {
				return jsonError(error);
			} finally {
				await end();
			}
		}
		if (url.pathname === "/verify" && request.method === "POST") {
			const denied = await requireAdmin(request, env);
			if (denied) return denied;
			const table = url.searchParams.get("table");
			if (!table)
				return Response.json(
					{ error: "table parameter required" },
					{ status: 400 },
				);
			const { ports, end } = portsFor(env);
			try {
				const fromRaw = url.searchParams.get("fromPage");
				const from = fromRaw === null ? Number.NaN : Number(fromRaw);
				return Response.json(
					await verifyTable(ports, table, {
						fromPage: Number.isInteger(from) && from >= 0 ? from : undefined,
					}),
				);
			} catch (error) {
				return jsonError(error);
			} finally {
				await end();
			}
		}
		if (url.pathname === "/reset" && request.method === "POST") {
			const denied = await requireAdmin(request, env);
			if (denied) return denied;
			const body = (await request.json().catch(() => ({}))) as {
				confirm?: string;
			};
			if (body.confirm !== "truncate-core-copy")
				return Response.json(
					{ error: 'confirm must be "truncate-core-copy"' },
					{ status: 400 },
				);
			const { ports, end } = portsFor(env);
			try {
				return Response.json(await resetCopy(ports));
			} catch (error) {
				return jsonError(error);
			} finally {
				await end();
			}
		}
		if (url.pathname === "/status" && request.method === "GET") {
			const denied = await requireAdmin(request, env);
			if (denied) return denied;
			const { ports, end } = portsFor(env);
			try {
				return Response.json(await copyStatus(ports));
			} catch (error) {
				return jsonError(error);
			} finally {
				await end();
			}
		}
		if (url.pathname === "/run" && request.method === "POST") {
			const denied = await requireAdmin(request, env);
			if (denied) return denied;
			const { ports, end } = portsFor(env);
			try {
				const body = (await request.json().catch(() => ({}))) as {
					action?: string;
				};
				const now = new Date().toISOString();
				const store = ports.store;
				if (body.action === "start") {
					await store.setRunState({ mode: "running", updatedAt: now });
				} else if (body.action === "resume") {
					await store.setRunState({ mode: "running", updatedAt: now });
				} else if (body.action === "stop") {
					await store.setRunState({ mode: "idle", updatedAt: now });
				} else {
					return Response.json(
						{ error: "action must be start, resume or stop" },
						{ status: 400 },
					);
				}
				return Response.json(await store.runState());
			} catch (error) {
				return jsonError(error);
			} finally {
				await end();
			}
		}
		// authz: public liveness probe for deploy verification; exposes no data.
		if (url.pathname === "/healthz" && request.method === "GET") {
			return Response.json({
				ok: true,
				service: "core-copy",
				deployedSha: env.GIT_SHA,
			});
		}
		return Response.json({ error: "not found" }, { status: 404 });
	},

	async scheduled(
		_event: ScheduledEvent,
		env: Env,
		ctx: ExecutionContext,
	): Promise<void> {
		ctx.waitUntil(
			(async () => {
				const { ports, end } = portsFor(env);
				try {
					await cronTick(ports);
				} finally {
					await end();
				}
			})(),
		);
	},
};
