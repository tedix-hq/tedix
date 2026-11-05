import { DeckCurationStateSchema } from "@tedix/api-contract/schemas/deck-curation";
import { osLocale, osTimeZone } from "@/lib/format";
import { OS_COPY } from "@/shared/os-copy";

type NotUseful = NonNullable<
	ReturnType<typeof DeckCurationStateSchema.parse>["notUseful"]
>;

/** The person's own "Not useful" answer stored on a card, if they gave one. */
export function notUsefulAnswer(metadata: unknown): NotUseful | null {
	const curation =
		metadata && typeof metadata === "object"
			? (metadata as Record<string, unknown>).curation
			: undefined;
	return DeckCurationStateSchema.safeParse(curation).data?.notUseful ?? null;
}

/** "08:44" today, "4 Nov, 08:44" on another day. */
export function answerTime(iso: string, now = new Date()): string {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return "";
	const timeZone = osTimeZone();
	const day = (date: Date) =>
		date.toLocaleDateString("en-CA", { timeZone, dateStyle: "short" });
	const time = at.toLocaleTimeString(osLocale(), {
		timeZone,
		hour: "2-digit",
		minute: "2-digit",
	});
	return day(at) === day(now)
		? time
		: `${at.toLocaleDateString(osLocale(), { timeZone, day: "numeric", month: "short" })}, ${time}`;
}

/**
 * How a closed card reads to a person. A "Not useful" answer is the person's
 * decision and never looks like a card the asking agent withdrew.
 */
export function decisionOutcome(
	request: { metadata?: unknown },
	effectiveState: string,
	now = new Date(),
): { label: string; line: string; note?: string } | null {
	const copy = OS_COPY.decisionDeck.outcome;
	const notUseful = notUsefulAnswer(request.metadata);
	if (notUseful)
		return {
			label: copy.notNeeded,
			line: copy.notNeededLine(
				copy.reasons[notUseful.reason],
				notUseful.at ? answerTime(notUseful.at, now) : undefined,
			),
			...(notUseful.note ? { note: notUseful.note } : {}),
		};
	switch (effectiveState) {
		case "open":
			return null;
		case "resolved":
			return { label: copy.answered, line: copy.answeredLine };
		case "expired":
			return { label: copy.expired, line: copy.expiredLine };
		default:
			return { label: copy.withdrawn, line: copy.withdrawnLine };
	}
}
