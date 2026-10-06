import type { CostProvenance } from "@tedix/api-contract/schemas/cost-provenance";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import {
	type CostReading,
	type CostTone,
	PROVENANCE_LABEL,
	readingDetail,
	readingLabel,
	readingTone,
} from "@/lib/cost-reading";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Tone → Badge variant. Nothing that is not a trustworthy number gets a
 * confident variant: an unavailable read is outline, and every caution state
 * (absent, unpriced, quarantined) is warning-toned so a missing number never
 * reads like a settled one.
 */
export const COST_TONE_VARIANTS: Record<CostTone, BadgeVariant> = {
	known: "success",
	estimate: "info",
	caution: "warning",
	unavailable: "outline",
};

/**
 * The provenance a chip may print on its face — only when a number is on it.
 * A chip with no number has no provenance to report, and printing one would
 * attach a basis to a value that does not exist.
 */
export function chipProvenance(reading: CostReading): CostProvenance | null {
	return reading.kind === "priced" || reading.kind === "zero"
		? reading.provenance
		: null;
}

// ---------------------------------------------------------------------------
// Presentational chip (exported for tests)
// ---------------------------------------------------------------------------

/**
 * The one cost chip across the OS.
 *
 * Colour is never the only channel: the label itself says which state it is
 * ("Cost pending", "price unknown", "$0.0041"), the provenance word rides
 * beside a number, and the full explanation is both the `title` and the
 * accessible label. `data-cost-kind`/`data-tone` exist so tests can assert the
 * state rather than the styling.
 *
 * `subject` names WHAT was measured. It is required for a reason: several of
 * these chips measure a part (the kernel planning call, this window, this
 * receipt) and a bare dollar figure beside a conversation would imply a total
 * the read does not support.
 */
export function CostChip({
	reading,
	subject,
	className,
}: {
	reading: CostReading;
	subject: string;
	className?: string;
}) {
	const tone = readingTone(reading);
	const provenance = chipProvenance(reading);
	const detail = `${subject}. ${readingDetail(reading)}`;
	return (
		<Badge
			variant={COST_TONE_VARIANTS[tone]}
			className={className}
			data-tone={tone}
			data-cost-kind={reading.kind}
			data-cost-provenance={provenance ?? undefined}
			title={detail}
			aria-label={`${readingLabel(reading)} — ${detail}`}
		>
			<span className="tabular-nums">{readingLabel(reading)}</span>
			{provenance !== null && (
				<span className="ml-1 opacity-70">{PROVENANCE_LABEL[provenance]}</span>
			)}
		</Badge>
	);
}
