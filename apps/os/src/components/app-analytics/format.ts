/**
 * Pure formatting helpers shared by the app analytics sections.
 */

import type { AppActivityFreshnessSchema } from "@tedix/api-contract/contracts/analytics";
import type { IdentityCoverage } from "@tedix/api-contract/schemas/analytics";
import type { z } from "zod";

type AppActivityFreshness = z.infer<typeof AppActivityFreshnessSchema>;

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60_000).toFixed(1)}m`;
}

export function prettyJson(body: string): string {
	if (!body) return "—";
	try {
		return JSON.stringify(JSON.parse(body), null, 2);
	} catch {
		return body;
	}
}

export function formatBytes(bytes: number): string {
	if (!bytes || bytes < 1) return "—";
	if (bytes < 1024) return `${Math.round(bytes)} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTimestamp(ts: string, now: number = Date.now()): string {
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return ts;
	const diffMs = now - d.getTime();
	if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)}m ago`;
	if (diffMs < 86_400_000) return `${Math.round(diffMs / 3_600_000)}h ago`;
	return d.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function formatAuditAction(action: string): string {
	if (action === "mcp.code.execute") return "code execution";
	if (action === "mcp.tool.execute") return "tool call";
	if (action === "mcp.tool.error") return "tool error";
	return action.replaceAll(".", " ");
}

/** AE returns "YYYY-MM-DD HH:MM:SS" (space separator, no Z) — normalize to UTC. */
export function formatBucketLabel(bucket: string): string {
	const normalized = bucket
		.replace(" ", "T")
		.replace(/(\d{2}:\d{2}:\d{2})$/, "$1Z");
	const d = new Date(normalized);
	if (Number.isNaN(d.getTime())) return bucket;
	return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

const CALLER_TYPE_LABELS: Record<string, string> = {
	anonymous: "Anonymous",
	apiKey: "API key",
	m2m: "M2M",
	oauth: "OAuth",
	service: "Service",
	tedi: "Tedi",
	user: "User",
};

export const UUID_LIKE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getCallerTypeDisplay(callerTypes: string[]): {
	visible: Array<{ value: string; label: string }>;
	hiddenCount: number;
} {
	const visible = new Map<string, string>();
	let hiddenCount = 0;

	for (const rawType of callerTypes) {
		const trimmed = rawType.trim();
		if (!trimmed) continue;

		const normalized =
			trimmed === "api_key" || trimmed === "apikey" ? "apiKey" : trimmed;
		const label = CALLER_TYPE_LABELS[normalized];
		if (label) {
			visible.set(normalized, label);
			continue;
		}

		if (UUID_LIKE.test(trimmed) || trimmed.length > 24) {
			hiddenCount += 1;
		}
	}

	return {
		visible: Array.from(visible, ([value, label]) => ({ value, label })),
		hiddenCount,
	};
}

export function formatCurrentWindow(
	window: AppActivityFreshness["currentWindow"],
): string {
	if (window.totalEvents === 0) return "no events yet";
	const parts = [
		`${window.codeExecutions.toLocaleString()} code`,
		`${window.toolExecutions.toLocaleString()} tools`,
	];
	if (window.toolErrors > 0) {
		parts.push(`${window.toolErrors.toLocaleString()} errors`);
	}
	return parts.join(" · ");
}

// =============================================================================

export function coverageLabel(coverage: IdentityCoverage): string | null {
	if (coverage.warnings.length === 0) return null;
	const warningDetails = coverageWarningDetails(coverage);
	return warningDetails.map((warning) => warning.label).join(", ");
}

function coverageWarningDetails(coverage: IdentityCoverage) {
	if (coverage.warningDetails.length > 0) return coverage.warningDetails;
	const fallbackLabels: Record<string, string> = {
		actor_unresolved: "actor unresolved",
		subject_missing: "no human subject",
		subject_unresolved: "subject unresolved",
		agent_unresolved: "agent unresolved",
		app_unresolved: "app unresolved",
		tool_unresolved: "tool unresolved",
	};
	return coverage.warnings.map((warning) => ({
		code: warning,
		label: fallbackLabels[warning] ?? warning,
		severity: "warning" as const,
		message: warning,
		recommendedAction: null,
	}));
}

export function coverageTitle(coverage: IdentityCoverage): string {
	return coverageWarningDetails(coverage)
		.map((warning) =>
			[
				warning.label,
				warning.message,
				warning.recommendedAction
					? `Action: ${warning.recommendedAction}`
					: null,
			]
				.filter(Boolean)
				.join("\n"),
		)
		.join("\n\n");
}

export function formatActivityTime(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime())
		? iso
		: d.toLocaleString(undefined, {
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			});
}
