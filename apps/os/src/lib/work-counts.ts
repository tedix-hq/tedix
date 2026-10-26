/** Counts describe loaded, actionable records, not organization-wide totals. */
export const WORK_COUNT_DEFINITIONS = {
	decisions:
		"Choices ready in this Decisions app, including factory cards. Choices shown only in Activity and choices not yet due are excluded.",
	approvals:
		"Action requests and requests to start Work that you can approve. Each loaded request counts once, even when grouped together.",
} as const;

export function approvalAttentionCount(input: {
	home: number;
	runtime: number;
	work?: number;
}): number {
	return input.home + input.runtime + (input.work ?? 0);
}

export function isDecidableWorkApproval(row: {
	effectiveStatus: string;
	canDecide: boolean;
}): boolean {
	return row.effectiveStatus === "pending" && row.canDecide;
}
