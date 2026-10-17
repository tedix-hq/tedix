import { normalizeD1Timestamp } from "@/lib/time";
import type { AttentionResult } from "@tedix/api-contract/schemas/work-attention";
import type { AttentionLayout } from "@tedix/api-contract/schemas/attention-layout";

export function attentionTimestamp(at: string): number {
	return Date.parse(
		/^\d{4}-\d{2}-\d{2} /.test(at) ? normalizeD1Timestamp(at) : at,
	);
}

export type AttentionCard = AttentionResult["cards"][number];
export const ATTENTION_SOURCES = {
	local_claude: { label: "Local Claude", color: "var(--tedix-hue-amber)" },
	local_codex: { label: "Local Codex", color: "var(--tedix-hue-blue)" },
	cloud_tedi: { label: "Cloud tedi", color: "var(--tedix-hue-violet)" },
	factory: { label: "Factory / skill", color: "var(--color-kumo-success)" },
	coordinator: {
		label: "Scheduled coordinator",
		color: "var(--color-kumo-warning)",
	},
	unknown: { label: "Other activity", color: "var(--color-kumo-line)" },
} as const;
export function attentionSource(
	card: AttentionCard,
): keyof typeof ATTENTION_SOURCES {
	return (
		card.activitySource ??
		(card.source === "session"
			? card.who === "Codex"
				? "local_codex"
				: "local_claude"
			: card.source === "skill"
				? "factory"
				: card.source === "run"
					? "cloud_tedi"
					: "unknown")
	);
}
export function duration(ms: number): string {
	if (!Number.isFinite(ms)) return "Time unknown";
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
	return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
export function heartbeatAge(card: AttentionCard, now: number): number | null {
	const at = attentionTimestamp(card.heartbeatAt ?? "");
	return Number.isFinite(at) ? Math.max(0, now - at) : null;
}
export function attentionStatus(card: AttentionCard, now: number): string {
	if (card.column === "done") return "finished";
	if (card.column === "backlog") return "ready to start";
	if (card.column === "waiting") return "waiting on you";
	const age = heartbeatAge(card, now);
	if (age === null) return "heartbeat not reported";
	if (age >= 300_000) return `no heartbeat for ${Math.floor(age / 60_000)}m`;
	return card.column === "blocked" ? "blocked" : "working";
}
export function rankAttention(
	cards: AttentionCard[],
	layout: AttentionLayout,
): AttentionCard[] {
	const priority = { waiting: 0, blocked: 1, moving: 2, backlog: 3, done: 4 };
	const words =
		layout.focusToday.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
	const relevance = (c: AttentionCard) =>
		words.filter((word) =>
			`${c.title} ${c.note}`.toLocaleLowerCase().includes(word),
		).length;
	const pin = (c: AttentionCard) => {
		const i = layout.pinnedProjects.indexOf(c.projectId ?? "");
		return i < 0 ? 100 : i;
	};
	return cards
		.filter(
			(c) =>
				!layout.hiddenColumns.includes(c.column) &&
				(!layout.focusProjectId || c.projectId === layout.focusProjectId) &&
				(!layout.sourceFilters.length ||
					layout.sourceFilters.includes(attentionSource(c))),
		)
		.sort(
			(a, b) =>
				priority[a.column] - priority[b.column] ||
				pin(a) - pin(b) ||
				relevance(b) - relevance(a) ||
				(attentionTimestamp(a.startedAt) || 0) -
					(attentionTimestamp(b.startedAt) || 0) ||
				a.id.localeCompare(b.id),
		);
}
export function activityDuration(card: AttentionCard, now: number): number {
	if (card.source === "backlog") return 0;
	const start = attentionTimestamp(card.startedAt);
	const midnight = new Date(now);
	midnight.setHours(0, 0, 0, 0);
	// Never count silence as continuous work. A fresh heartbeat advances the bar.
	const end = attentionTimestamp(card.finishedAt || card.heartbeatAt || "");
	return Number.isFinite(start) && Number.isFinite(end)
		? Math.max(0, Math.min(now, end) - Math.max(start, midnight.getTime()))
		: 0;
}
