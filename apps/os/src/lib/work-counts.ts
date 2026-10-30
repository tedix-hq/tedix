/** Counts describe loaded, actionable records, not organization-wide totals. */
export const WORK_COUNT_DEFINITIONS = {
	decisions: "Choices waiting for your decision.",
	approvals: "Requests waiting for your approval.",
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
