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
	startDelta,
	verifyTable,
	type CopyPorts,
} from "./copy.ts";
import type { Env } from "./env.ts";
import { coreCopyPlan, planTable } from "./plan.ts";
import { replayChanges } from "./replay.ts";
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
	// Reads go to any D1 replica, keeping the copy off the primary. Lag is
	// fine here: the final delta copy picks up later writes.
	const d1 = env.DB.withSession("first-unconstrained");
	return {
		ports: {
			readD1: async (sql, params) => {
				const result = await d1
					.prepare(sql)
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
		if (url.pathname === "/bench" && request.method === "POST") {
			// Read-only latency probe for the switch decision: typical product
			// reads against the Postgres copy through Hyperdrive, timed one by
			// one. Run many of these at once from outside to load-test.
			const denied = await requireAdmin(request, env);
			if (denied) return denied;
			const { query, end } = hyperdriveQuery(env.HYPERDRIVE.connectionString);
			const timings: Record<string, number> = {};
			const time = async <T>(label: string, run: () => Promise<T>) => {
				const started = performance.now();
				const value = await run();
				timings[label] = Math.round(performance.now() - started);
				return value;
			};
			try {
				const orgs = await time("connect_and_orgs", () =>
					query(`SELECT id FROM organizations ORDER BY id LIMIT 20`, []),
				);
				const org = String(
					orgs.rows[Math.floor(Math.random() * orgs.rows.length)]?.id ?? "",
				);
				await time("org_by_pk", () =>
					query(`SELECT * FROM organizations WHERE id = $1`, [org]),
				);
				const items = await time("work_items_recent", () =>
					query(
						`SELECT id, title, disposition FROM work_items WHERE org_id = $1 ORDER BY created_at DESC LIMIT 50`,
						[org],
					),
				);
				const item = String(items.rows[0]?.id ?? "");
				await time("work_item_by_pk", () =>
					query(`SELECT * FROM work_items WHERE id = $1`, [item]),
				);
				await time("apps_by_org", () =>
					query(
						`SELECT id, slug FROM apps WHERE organization_id = $1 LIMIT 50`,
						[org],
					),
				);
				const limits = await query(
					`SELECT current_setting('max_connections')::int AS max_connections,
					        current_setting('superuser_reserved_connections')::int AS reserved,
					        (SELECT count(*)::int FROM pg_stat_activity) AS connections,
					        (SELECT count(*)::int FROM pg_stat_activity WHERE usename = current_user) AS ours`,
					[],
				);
				return Response.json({ ok: true, timings, limits: limits.rows[0] });
			} catch (error) {
				return Response.json(
					{
						ok: false,
						timings,
						error: error instanceof Error ? error.message : String(error),
					},
					{ status: 500 },
				);
			} finally {
				await end();
			}
		}
		if (url.pathname === "/replay" && request.method === "POST") {
			// Rollback only: writes Postgres changes captured after the switch back
			// into D1. ?dryRun=1 builds the statements without writing.
			const denied = await requireAdmin(request, env);
			if (denied) return denied;
			const { ports, end } = portsFor(env);
			try {
				const limit = Number(url.searchParams.get("limit") ?? "200");
				return Response.json(
					await replayChanges(
						{
							query: ports.query,
							store: ports.store,
							writeD1: async (statements) => {
								await env.DB.batch(
									statements.map((s) =>
										env.DB.prepare(s.sql).bind(...s.params),
									),
								);
							},
						},
						{
							limit: Number.isInteger(limit) ? limit : 200,
							dryRun: url.searchParams.get("dryRun") === "1",
						},
					),
				);
			} catch (error) {
				return jsonError(error);
			} finally {
				await end();
			}
		}
		if (url.pathname === "/delta") {
			// POST starts the final delta (during the write freeze); GET reports it.
			const denied = await requireAdmin(request, env);
			if (denied) return denied;
			const { ports, end } = portsFor(env);
			try {
				if (request.method === "POST") {
					const body = (await request.json().catch(() => ({}))) as {
						since?: string;
						recentSince?: string;
					};
					if (
						!body.since ||
						!body.recentSince ||
						Number.isNaN(Date.parse(body.since)) ||
						Number.isNaN(Date.parse(body.recentSince))
					)
						return Response.json(
							{ error: "since and recentSince must be ISO times" },
							{ status: 400 },
						);
					await startDelta(ports, {
						since: body.since,
						recentSince: body.recentSince,
					});
				}
				const tables = [];
				for (const entry of coreCopyPlan()) {
					const p = await ports.store.deltaProgress(entry.table);
					if (p)
						tables.push({
							table: p.table,
							status: p.status,
							phase: `${p.phase}/${p.phases.length}`,
							kinds: p.phases.map((x) => x.kind).join(","),
							pages: p.pages,
							...(p.lastError ? { lastError: p.lastError } : {}),
						});
				}
				return Response.json({
					run: await ports.store.deltaRun(),
					mode: (await ports.store.runState()).mode,
					tables,
				});
			} catch (error) {
				return jsonError(error);
			} finally {
				await end();
			}
		}
		if (url.pathname === "/insert-only") {
			const denied = await requireAdmin(request, env);
			if (denied) return denied;
			const { ports, end } = portsFor(env);
			try {
				if (request.method === "POST") {
					const body = (await request.json().catch(() => ({}))) as {
						tables?: unknown;
					};
					const tables = body.tables;
					const valid =
						tables === null ||
						tables === "all" ||
						(Array.isArray(tables) &&
							tables.every((t) => typeof t === "string" && planTable(t)));
					if (!valid)
						return Response.json(
							{ error: 'tables must be "all", a list of plan tables, or null' },
							{ status: 400 },
						);
					await ports.store.setInsertOnly(tables as "all" | string[] | null);
				}
				return Response.json({
					insertOnly: await ports.store.insertOnlySetting(),
				});
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
					await cronTick(ports, () => portsFor(env));
				} finally {
					await end();
				}
			})(),
		);
	},
};
