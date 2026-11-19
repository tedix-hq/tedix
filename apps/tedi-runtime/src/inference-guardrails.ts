const MAX_GATEWAY_SOURCE_CHARS = 96;

function compactSource(value: string): string {
	return value
		.replace(/[^a-zA-Z0-9:._-]+/g, "-")
		.slice(0, MAX_GATEWAY_SOURCE_CHARS);
}

/**
 * The non-empty `:`-separated segments after the first whole `cron` segment
 * that is followed only by non-empty segments — what
 * `/(?:^|:)cron:([^:]+(?::[^:]+)*)$/i` captured, without its quadratic rescan
 * of caller-supplied session keys.
 */
function cronSessionSuffix(key: string): string | null {
	const parts = key.split(":");
	let lastEmpty = -1;
	for (const [index, part] of parts.entries()) if (!part) lastEmpty = index;
	for (let index = lastEmpty + 1; index < parts.length - 1; index += 1) {
		if (parts[index]?.toLowerCase() === "cron") {
			return parts.slice(index + 1).join(":");
		}
	}
	return null;
}

/** Server-derived AI Gateway trigger label. Never accepts a caller-provided tag. */
export function inferenceSource(
	sessionKey: string | null | undefined,
	surface:
		| "chat"
		| "cron"
		| "email"
		| "operator"
		| "judge"
		| "mcp"
		| "observer",
): string {
	const key = sessionKey?.trim() ?? "";
	if (/ci-smoke|agentic-evidence|__test:|__throwaway:/i.test(key)) return "ci";
	const cron = cronSessionSuffix(key);
	if (surface === "cron" || cron) {
		return compactSource(`cron:${cron ?? "unknown"}`);
	}
	if (/telegram:/i.test(key)) return "telegram";
	if (/home/i.test(key)) return "home";
	return surface;
}

/**
 * Server-owned provenance for a turn the RUNTIME authored rather than a caller.
 * Two values, because there are exactly two such authors:
 *
 * - `cron`: the authenticated persisted schedule record (and the
 *   service-binding-only assignment inbox, which borrows it to reach the
 *   background lane).
 * - `computer_execution`: a command that outlived its inline wait, whose
 *   completion the runtime hands back as a turn
 *   (`computer-execution-wake.ts`). The command's OUTPUT is still external
 *   text and is still fenced downstream; this bit asserts only that the
 *   runtime, not a tenant, composed the turn.
 */
export type TrustedInstructionOrigin = "computer_execution" | "cron";

/**
 * Convert only the server-owned assignment-inbox inject source into trusted
 * scheduler provenance. `/hooks/inject` is service-binding-only; arbitrary
 * chat text and ordinary inject metadata must never claim that provenance.
 */
export function trustedInstructionOriginForInject(
	metadata: Record<string, unknown> | null | undefined,
): TrustedInstructionOrigin | undefined {
	return metadata?.source === "work_item_assignment_inbox" ? "cron" : undefined;
}

/**
 * What a turn's origin implies for its ROUND BUDGET and TOOL SURFACE.
 *
 * An assignment wake sets `trustedInstructionOrigin: "cron"` to mark it as
 * runtime-authored, and must not inherit the maintenance cycle's 4-round cap and single-tool
 * projection, or it runs with zero tool calls because the Work Item needs
 * repo, workspace, or browser tools that projection removes.
 */
export type FacetTurnBudgetClass =
	/** Scheduler-fired maintenance cycle: tight rounds, Code-Mode-only surface. */
	| "maintenance_cycle"
	/** Board-assigned Work Item turn: real work, so a real surface. */
	| "wake"
	/** Ordinary interactive turn. */
	| "interactive";

/**
 * Only the scheduler's own maintenance cycle earns the tight rounds and the
 * Code-Mode-only surface. A board assignment wake is discriminated from it by
 * carrying a `workItemId`. A command-completion wake says so in its origin
 * instead: it resumes real work inside an ordinary conversation and needs the
 * same full surface the turn that launched the command had.
 */
export function facetTurnBudgetClass(input: {
	trustedInstructionOrigin?: string | undefined;
	workItemId?: string | null | undefined;
}): FacetTurnBudgetClass {
	if (input.trustedInstructionOrigin === "computer_execution") return "wake";
	if (input.trustedInstructionOrigin !== "cron") return "interactive";
	return input.workItemId ? "wake" : "maintenance_cycle";
}

/**
 * Conservative token reservation from model-visible configuration. Exact token
 * usage replaces this reservation after the call; 3 UTF-16 code units/token is
 * intentionally stricter than the common English-text 4-char heuristic.
 */
export function estimateInferenceTokens(...values: unknown[]): number {
	let chars = 0;
	for (const value of values) {
		if (value == null) continue;
		try {
			chars +=
				typeof value === "string" ? value.length : JSON.stringify(value).length;
		} catch {
			chars += 1_000;
		}
	}
	return Math.max(1, Math.ceil(chars / 3));
}
