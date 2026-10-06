/**
 * Tedis Router — Runtime schedule read.
 *
 * Org-scoped operator visibility into a tedi's Agents-SDK scheduler
 * (`cf_agents_schedules` inside the Agent-runtime Durable Object), which is
 * where cron jobs that fire skill workflows live. Reads the runtime's
 * operator-only `GET /__admin/schedules` endpoint through the same
 * service-binding + admin-token path as recovery diag (`agentAdminFetch`).
 *
 * Fail-soft by contract: authz failures (org mismatch, unknown tedi) still
 * throw, but a wedged/unreachable runtime returns `{ schedules: [], warning }`
 * so the Tedix OS schedule route renders instead of erroring.
 */

import type {
	TediSchedule,
	TediScheduleListResponse,
} from "@tedix/api-contract/schemas/tedi";
import { listSkillSchedules } from "@tedix/db/queries/skill-schedules";
import { agentAdminFetch } from "./crud";
import {
	AUTHZ,
	authedTedisOs,
	requireTediAccess,
	sanitizeProvisioningError,
} from "./helpers";

/** Timeout for the runtime schedules read (matches the recovery diag read). */
const SCHEDULES_TIMEOUT_MS = 10_000;

const SCHEDULE_KINDS = new Set<TediSchedule["kind"]>(["cron", "every", "at"]);

/**
 * Map the runtime's `GET /__admin/schedules` JSON body to the contract shape.
 * Pure (no HTTP/DB) so the fail-soft paths are unit-testable: an unexpected
 * payload yields an empty list + warning, unrecognized rows are skipped and
 * counted, and a partial-read `error` from the DO is surfaced as a warning.
 */
export function parseRuntimeSchedules(json: unknown): TediScheduleListResponse {
	const body = json as {
		ok?: unknown;
		schedules?: unknown;
		error?: unknown;
	} | null;
	if (!body || body.ok !== true || !Array.isArray(body.schedules)) {
		return {
			schedules: [],
			warning: "Runtime returned an unexpected schedules payload",
		};
	}

	const schedules: TediSchedule[] = [];
	let skipped = 0;
	for (const raw of body.schedules) {
		const item =
			raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
		const id = typeof item?.id === "string" && item.id ? item.id : null;
		const kind =
			typeof item?.kind === "string" &&
			SCHEDULE_KINDS.has(item.kind as TediSchedule["kind"])
				? (item.kind as TediSchedule["kind"])
				: null;
		if (!item || !id || !kind) {
			skipped += 1;
			continue;
		}
		schedules.push({
			id,
			callback: typeof item.callback === "string" ? item.callback : "unknown",
			name: typeof item.name === "string" ? item.name : null,
			kind,
			expr: typeof item.expr === "string" ? item.expr : null,
			everyMs: typeof item.everyMs === "number" ? item.everyMs : null,
			message: typeof item.message === "string" ? item.message : null,
			sessionTarget:
				typeof item.sessionTarget === "string" ? item.sessionTarget : null,
			nextRunAt: typeof item.nextRunAt === "string" ? item.nextRunAt : null,
		});
	}

	const warnings: string[] = [];
	if (typeof body.error === "string" && body.error) {
		warnings.push(`Partial read: ${body.error}`);
	}
	if (skipped > 0) {
		warnings.push(
			`Skipped ${skipped} unrecognized schedule ${skipped === 1 ? "row" : "rows"}`,
		);
	}
	return {
		schedules,
		...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}),
	};
}

/**
 * Fold an `agentAdminFetch` result into the fail-soft contract response.
 * Unreachable runtime / non-2xx → empty list + warning (never a throw).
 * Error text is sanitized so internal URLs/hosts never reach org operators.
 */
export function schedulesFromAdminFetch(
	result: { ok: boolean; status: number; json: unknown } | { error: string },
): TediScheduleListResponse {
	if ("error" in result) {
		return {
			schedules: [],
			warning: `Runtime unreachable: ${sanitizeProvisioningError(new Error(result.error))}`,
		};
	}
	if (!result.ok) {
		return {
			schedules: [],
			warning: `Runtime returned status ${result.status}`,
		};
	}
	return parseRuntimeSchedules(result.json);
}

/**
 * GET /tedis/{tediId}/schedules — org-scoped, read-only.
 * `requireTediAccess` enforces org ownership (or platform-admin) before any
 * runtime call; the runtime endpoint itself is service-binding/admin-token
 * gated and never publicly reachable.
 */
export const listSchedulesProcedure = authedTedisOs.listSchedules
	.use(AUTHZ.tedisAppsRead)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);
		const [runtimeResult, skillSchedules] = await Promise.all([
			agentAdminFetch(context, tedi, "/__admin/schedules", {
				method: "GET",
				timeoutMs: SCHEDULES_TIMEOUT_MS,
			}),
			listSkillSchedules(context.db, tedi.organizationId, {
				tediId: input.tediId,
				limit: 200,
			}),
		]);
		return {
			...schedulesFromAdminFetch(runtimeResult),
			skillSchedules,
		};
	});
