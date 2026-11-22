import { FLOW_WATCH_LIMITS } from "@tedix/api-contract/schemas/flow-watch";
import { sha256Hex } from "@tedix/worker-kit/crypto";

/**
 * The platform-owned flow.watch automation. Every organization gets one skill
 * row with this source (see ensurePlatformSkill); each watch is a run of it
 * with server-derived params, so no watch records a skill of its own.
 */
export const WATCH_SKILL_SLUG = "tedix-flow-watch";
export const WATCH_SKILL_TAGS = ["flow-watch", "platform"];
export const WATCH_CHECK_TOOL = "check_work_item_watch";
/** Open-run window: longer than the 24 h deadline so a stuck row frees itself. */
export const WATCH_OPEN_WINDOW_HOURS = 25;

/**
 * Evaluate a flow.watch `until` rule against one status result. Embedded
 * verbatim in the workflow source, so it must stay self-contained: no
 * imports, outer references or nested functions a bundler could rename.
 */
export function evaluateWatchRule(rule: unknown, value: unknown): boolean {
	if (!rule || typeof rule !== "object") return false;
	const r = rule as Record<string, unknown>;
	if (typeof r.path !== "string") return false;
	let current: unknown = value;
	for (const key of r.path.split(".")) {
		if (
			current === null ||
			typeof current !== "object" ||
			!Object.prototype.hasOwnProperty.call(current, key)
		)
			return false;
		current = (current as Record<string, unknown>)[key];
	}
	if (Array.isArray(r.in)) {
		for (let i = 0; i < r.in.length; i++) if (r.in[i] === current) return true;
		return false;
	}
	if ("eq" in r) return r.eq === current;
	if (typeof r.gte === "number")
		return typeof current === "number" && current >= r.gte;
	return false;
}

const WATCH_WORKFLOW_BODY = `
const MAX_CONSECUTIVE_FAILURES = ${FLOW_WATCH_LIMITS.maxConsecutiveFailures};
const DENIED = /ACCESS_REVOKED|FORBIDDEN|UNAUTHORIZED|NOT_FOUND/;

function watchStatus(raw) {
	let value = raw;
	if (value && typeof value === "object" && value.structuredContent && typeof value.structuredContent === "object")
		value = value.structuredContent;
	if (typeof value === "string") {
		try { value = JSON.parse(value); } catch { value = null; }
	}
	if (!value || typeof value !== "object" || typeof value.disposition !== "string")
		throw new Error("WATCH_CHECK_INVALID: the status read returned no status");
	return {
		workItemId: String(value.workItemId ?? ""),
		disposition: value.disposition,
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
	};
}

export default {
	async run(event, step, env) {
		const p = (event && event.payload) || {};
		const until = p.until;
		const everyMs = Number(p.everySeconds) * 1000;
		const maxChecks = Number(p.maxChecks);
		const deadlineMs = Date.parse(String(p.deadlineAt));
		if (!until || !(everyMs >= ${FLOW_WATCH_LIMITS.minEverySeconds * 1000}) || !(maxChecks >= 1 && maxChecks <= ${FLOW_WATCH_LIMITS.maxChecks}) || !Number.isFinite(deadlineMs))
			return { outcome: "check_failed", checks: 0, status: null, error: "WATCH_PARAMS_INVALID" };
		let failures = 0;
		let last = null;
		for (let checks = 1; checks <= maxChecks; checks++) {
			// The match is computed inside the step and only the status fields
			// leave it, so step evidence stays small. A failed read is a result,
			// not a native retry: every attempt counts against maxChecks, and no
			// reconnect wait can outlive the deadline.
			const result = await step.do("check", { retries: { limit: 0, delay: "1 second" }, timeout: "60 seconds" }, async () => {
				const at = Date.now();
				try {
					const status = watchStatus(await env.MCP.tedi.${WATCH_CHECK_TOOL}({}));
					return { ok: true, at, status, matched: evaluateWatchRule(until, status) === true };
				} catch (error) {
					const message = String((error && error.message) || error).slice(0, 300);
					return { ok: false, at, error: message, denied: DENIED.test(message) };
				}
			});
			if (result.ok) {
				failures = 0;
				last = result.status;
				if (result.matched)
					return { outcome: "matched", checks, status: last, matchedAt: new Date(result.at).toISOString() };
			} else {
				failures += 1;
				if (result.denied || failures >= MAX_CONSECUTIVE_FAILURES)
					return { outcome: "check_failed", checks, status: last, error: result.error };
			}
			if (checks === maxChecks) break;
			const remainingMs = deadlineMs - result.at;
			if (remainingMs <= 0) return { outcome: "deadline", checks, status: last };
			await step.sleep("wait", Math.max(1000, Math.min(everyMs, remainingMs)));
		}
		return { outcome: "max_checks", checks: maxChecks, status: last };
	},
};
`;

export const WATCH_WORKFLOW_SOURCE = `// Platform-owned flow.watch automation. Shipped with Tedix; do not edit.
const evaluateWatchRule = ${evaluateWatchRule.toString()};
${WATCH_WORKFLOW_BODY}`;

export const WATCH_SKILL_DESCRIPTION =
	"Platform watch behind flow.watch: checks one Work Item's status on a schedule until a rule matches, then ends.";

export const WATCH_SKILL_DOC = [
	"---",
	`name: ${JSON.stringify(WATCH_SKILL_SLUG)}`,
	`description: ${JSON.stringify(WATCH_SKILL_DESCRIPTION)}`,
	`capabilities: ${JSON.stringify({
		mcp: { tedi: [WATCH_CHECK_TOOL] },
		expectedAnnotations: { readOnly: true, destructive: false },
		rationale: { mode: "off" },
	})}`,
	"---",
	"",
	"# flow.watch",
	"",
	WATCH_SKILL_DESCRIPTION,
	"",
	"Started only by flow.watch with server-derived params; each check re-reads",
	"the starter's access to the Work Item. Ends as matched, max_checks,",
	"deadline or check_failed.",
	"",
].join("\n");

/** One stable skill id per organization, so every watch reuses the same row. */
export async function watchSkillId(organizationId: string): Promise<string> {
	const hex = await sha256Hex(`tedix-flow-watch:${organizationId}`);
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		`4${hex.slice(13, 16)}`,
		`${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
		hex.slice(20, 32),
	].join("-");
}
