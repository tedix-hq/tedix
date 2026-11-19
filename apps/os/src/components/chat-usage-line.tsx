import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Meter } from "@/components/kumo/meter";
import { Text } from "@/components/kumo/text";
import type { AllowanceUsage } from "@/lib/billing-credits";
import { homeConversationChargesQueryOptions } from "@/lib/os-query-options";
import { useCreditShare } from "@/lib/use-credit-share";

/** The quiet line's words, exported for tests. */
export function conversationUsageText(usage: AllowanceUsage): string {
	return `${usage.label} of this month's credits used in this conversation`;
}

/**
 * A muted line under the composer: what this conversation's settled runs
 * used, as a share of the organization's credits this month. Exact credit
 * counts stay on Billing › Usage. It needs billing read access for the
 * monthly total, stays silent until something has settled, and never shows a
 * guess while a read is pending or failed.
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
	const settled =
		charges.data && charges.data.chargeCount > 0 ? charges.data.credits : null;
	const usage = useCreditShare(settled);

	if (!usage) return null;
	return (
		<div
			className="chat-usage-line mx-auto flex w-full max-w-3xl items-center justify-end gap-2 px-4 pt-1.5"
			title="Completed charges; pending usage appears once settled."
			data-credit-percent={usage.percent}
		>
			<Text as="p" role="label" tone="secondary" className="m-0 tabular-nums">
				{conversationUsageText(usage)}
			</Text>
			<Meter
				aria-label="Share of this month's credits used in this conversation"
				label=""
				hideLabel
				value={usage.percent}
				getAriaValueText={() => usage.label}
				className="w-16 shrink-0 gap-0"
				trackClassName="h-1"
			/>
		</div>
	);
}
