import type {
	Organization,
	OrganizationMetadata,
} from "../schema/organizations";

/**
 * True once offboarding has started: phase-one cancellation stamps
 * `metadata.cancelledAt`, retirement stamps `metadata.retiredAt`. Such an
 * organization keeps its rows and existing grants during the grace period, but
 * is no longer offered as a workspace or a new consent selection.
 */
export function isOrganizationOffboarding(
	metadata: Organization["metadata"] | Record<string, unknown> | null,
): boolean {
	const lifecycle = metadata as {
		cancelledAt?: unknown;
		retiredAt?: unknown;
	} | null;
	return Boolean(lifecycle?.cancelledAt || lifecycle?.retiredAt);
}

/**
 * Project the embedded widget turn quota an organization set, or null per
 * ceiling when it never did. Pure; a malformed value counts as unset.
 */
export function projectOrganizationWidgetQuota(
	metadata: OrganizationMetadata | null | undefined,
) {
	const quota = metadata?.tediWidget?.turnQuota;
	const read = (value: unknown): number | null =>
		typeof value === "number" && Number.isInteger(value) && value > 0
			? value
			: null;
	return {
		visitorTurnsPerHour: read(quota?.visitorTurnsPerHour),
		originTurnsPerHour: read(quota?.originTurnsPerHour),
	};
}
