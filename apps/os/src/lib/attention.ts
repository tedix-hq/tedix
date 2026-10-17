import {
	ATTENTION_COPY,
	attentionCopy,
	attentionStatusLabel,
} from "@tedix/api-contract/utils/attention-copy";
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
	local_claude: {
		label: ATTENTION_COPY.local_claude,
		color: "var(--tedix-hue-amber)",
	},
	local_codex: {
		label: ATTENTION_COPY.local_codex,
		color: "var(--tedix-hue-blue)",
	},
	cloud_tedi: {
		label: ATTENTION_COPY.cloud_tedi,
		color: "var(--tedix-hue-violet)",
	},
	factory: {
		label: ATTENTION_COPY.factory,
		color: "var(--color-kumo-success)",
	},
	coordinator: {
		label: ATTENTION_COPY.coordinator,
		color: "var(--color-kumo-warning)",
	},
	unknown: {
		label: ATTENTION_COPY.unknownSource,
		color: "var(--color-kumo-line)",
	},
} as const;
export function attentionSource(
	card: AttentionCard,
): keyof typeof ATTENTION_SOURCES {
	return card.activitySource ?? "unknown";
}
export function duration(ms: number): string {
	if (!Number.isFinite(ms)) return ATTENTION_COPY.timeUnknown;
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return attentionCopy("seconds", { seconds });
	if (seconds < 3600)
		return attentionCopy("minutesSeconds", {
			minutes: Math.floor(seconds / 60),
			seconds: seconds % 60,
		});
	return attentionCopy("hoursMinutes", {
		hours: Math.floor(seconds / 3600),
		minutes: Math.floor((seconds % 3600) / 60),
	});
}
export function heartbeatAge(card: AttentionCard, now: number): number | null {
	const at = attentionTimestamp(card.heartbeatAt ?? "");
	return Number.isFinite(at) ? Math.max(0, now - at) : null;
}
export function attentionStatus(card: AttentionCard, now: number): string {
	return attentionStatusLabel(card, new Date(now));
}
export function attentionUpdatesSince(
	cards: AttentionCard[],
	previousVisitAt: string | null,
): AttentionCard[] {
	const since = attentionTimestamp(previousVisitAt ?? "");
	return Number.isFinite(since)
		? cards.filter(
				(card) =>
					attentionTimestamp(
						card.finishedAt || card.heartbeatAt || card.startedAt,
					) > since,
			)
		: [];
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
