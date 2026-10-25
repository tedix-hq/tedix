import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Text } from "@/components/kumo/text";
import { formatCreditWorth } from "@/lib/billing-credit-display";
import { homeConversationChargesQueryOptions } from "@/lib/os-query-options";

/** The quiet line's words, exported for tests. */
export function conversationUsageText(chargedMicros: number): string {
	return `${formatCreditWorth(chargedMicros, "eur")} used in this conversation`;
}

/**
 * A muted line under the composer: what this conversation's settled runs
 * cost in EUR credits. It stays silent until something has settled, and
 * never shows a guess while a read is pending or failed.
 */
export function ConversationUsageLine({
	conversationId,
	settledRunCount,
}: {
	conversationId: string;
	/** Runs that have finished; a change means new charges may have settled. */
	settledRunCount: number;
}) {
	const charges = useQuery({
		...homeConversationChargesQueryOptions(conversationId),
		staleTime: 30_000,
	});
	const lastCount = useRef(settledRunCount);
	const { refetch } = charges;
	useEffect(() => {
		if (lastCount.current === settledRunCount) return;
		lastCount.current = settledRunCount;
		void refetch();
	}, [settledRunCount, refetch]);

	if (!charges.data || charges.data.chargeCount === 0) return null;
	return (
		<Text
			as="p"
			role="label"
			tone="secondary"
			className="chat-usage-line mx-auto w-full max-w-3xl px-4 pt-1.5 text-right tabular-nums"
			title="Settled credit charges for this conversation. Usage that is still settling is added once it settles."
		>
			{conversationUsageText(charges.data.chargedMicros)}
		</Text>
	);
}
