import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import {
	PopoverContent,
	PopoverDescription,
	PopoverRoot,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/kumo/popover";
import { Text } from "@/components/kumo/text";
import type { AllowanceUsage } from "@/lib/billing-credits";
import {
	homeConversationChargesQueryOptions,
	workspaceConversationChargesQueryOptions,
} from "@/lib/os-query-options";
import { useCanReadBilling, useCreditShare } from "@/lib/use-credit-share";

/** The usage words, exported for tests. */
export function conversationUsageText(usage: AllowanceUsage): string {
	return `${usage.label} of this month's credits used in this conversation`;
}

/**
 * A small ring in the composer toolbar: what this conversation's settled runs
 * used, as a share of the organization's credits this month. The popover says
 * it in words; exact credit counts stay on Billing. It needs billing read
 * access for the monthly total, stays hidden until something has settled, and
 * never shows a guess while a read is pending or failed.
 */
export function ConversationUsageRing({
	conversationId,
	settledRunCount,
	workspaceId,
}: {
	conversationId: string;
	workspaceId?: string;
	/** Runs that have finished; a change means new charges may have settled. */
	settledRunCount: number;
}) {
	const canReadBilling = useCanReadBilling();
	const homeCharges = useQuery({
		...homeConversationChargesQueryOptions(conversationId),
		enabled: canReadBilling && workspaceId === undefined,
		staleTime: 30_000,
	});
	const workspaceCharges = useQuery({
		...workspaceConversationChargesQueryOptions(
			workspaceId ?? "",
			conversationId,
		),
		enabled: canReadBilling && workspaceId !== undefined,
		staleTime: 30_000,
		// Workspace turns can finish before gateway reconciliation settles them.
		refetchInterval: 30_000,
	});
	const charges = workspaceId === undefined ? homeCharges : workspaceCharges;
	const lastCount = useRef(settledRunCount);
	const { refetch } = charges;
	useEffect(() => {
		if (lastCount.current === settledRunCount) return;
		lastCount.current = settledRunCount;
		if (canReadBilling) void refetch();
	}, [canReadBilling, settledRunCount, refetch]);
	const settled =
		!charges.isError && charges.data && charges.data.chargeCount > 0
			? charges.data.credits
			: null;
	const usage = useCreditShare(
		settled,
		workspaceId === undefined ? undefined : workspaceCharges.data?.periodStart,
	);

	if (!usage) return null;
	return (
		<PopoverRoot>
			<PopoverTrigger
				render={
					<Button
						aria-label={`Usage: ${conversationUsageText(usage)}`}
						className="chat-usage-ring"
						data-credit-percent={usage.percent}
						size="icon-sm"
						title={conversationUsageText(usage)}
						type="button"
						variant="ghost"
					>
						<UsageRing percent={usage.percent} />
					</Button>
				}
			/>
			<PopoverContent side="top" align="end" className="w-64 p-3">
				<PopoverTitle className="text-sm font-medium">Usage</PopoverTitle>
				<PopoverDescription className="mt-1 text-sm">
					{conversationUsageText(usage)}.
				</PopoverDescription>
				<Text as="p" role="label" tone="secondary" className="m-0 mt-2">
					Counts settled replies; new ones appear within a few minutes.{" "}
					<Link href="/admin/billing">See billing</Link>
				</Text>
			</PopoverContent>
		</PopoverRoot>
	);
}

/** A 16 px doughnut; any use shows at least a sliver so it never reads as empty. */
function UsageRing({ percent }: { percent: number }) {
	const radius = 6;
	const circumference = 2 * Math.PI * radius;
	const shown = percent > 0 ? Math.min(100, Math.max(percent, 4)) : 0;
	return (
		<svg aria-hidden width={16} height={16} viewBox="0 0 16 16">
			<circle
				cx={8}
				cy={8}
				r={radius}
				fill="none"
				stroke="currentColor"
				strokeOpacity={0.25}
				strokeWidth={2.5}
			/>
			<circle
				cx={8}
				cy={8}
				r={radius}
				fill="none"
				stroke="currentColor"
				strokeWidth={2.5}
				strokeLinecap="round"
				strokeDasharray={`${(shown / 100) * circumference} ${circumference}`}
				transform="rotate(-90 8 8)"
			/>
		</svg>
	);
}
