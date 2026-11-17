type DelegationRisk = "low" | "medium" | "high" | "critical" | "unknown";

/**
 * Risk of a delegation an operator sends straight to a named tedi.
 *
 * A linked Work item carries the rating, as on the workstation path; a link to
 * missing or unrated Work stays unknown so it keeps the human card. Without a
 * link the request is ordinary work, rated medium: standing consent decides,
 * and human-reserved actions are still caught from the request text.
 */
export function directDelegationRisk(
	linkedWorkItemId: string | undefined,
	linkedWorkRisk: string | null | undefined,
): DelegationRisk {
	if (!linkedWorkItemId) return "medium";
	return linkedWorkRisk === "low" ||
		linkedWorkRisk === "medium" ||
		linkedWorkRisk === "high" ||
		linkedWorkRisk === "critical"
		? linkedWorkRisk
		: "unknown";
}
