/**
 * Versioned estimates for provider-specific units that are not LLM tokens.
 *
 * These values support internal cost attribution only. Provider invoices and
 * exports remain authoritative, and an unknown model deliberately records a
 * zero estimate plus a null rate-card version instead of inventing a price.
 */

export const PROVIDER_UNIT_PRICING_VERSION = "workers-ai-2026-07-31";

/**
 * Separate card: Cloudflare Containers bill on different units than Workers AI
 * and move on their own schedule, so they version independently.
 */
export const CONTAINER_UNIT_PRICING_VERSION =
	"cloudflare-containers-2026-08-04";

/**
 * Allocated-resource shape of the workstation container instance type.
 *
 * `apps/tedi-workstation-runtime/wrangler.jsonc` pins `instance_type:
 * "standard-1"`. The 2:1 disk-to-memory ratio is corroborated by our own
 * billable-usage rows, where `Container Disk (GB-s)` is exactly twice
 * `Container Memory (GiB-s)` on every charge period observed.
 *
 * Container spend is roughly 90% memory-seconds, so these two numbers ARE the
 * bill. Follow the pin whenever it moves, and read that wrangler comment before
 * moving it — the instance size is a gate input, not a performance dial.
 */
const CONTAINER_INSTANCE_MEMORY_GIB = 4;
const CONTAINER_INSTANCE_DISK_GB = 8;

/**
 * USD micros per GiB-second of allocated container memory.
 *
 * Derived from a fully-billed Cloudflare charge period ($0.0000025/GiB-s), not a
 * published list price. (Periods still inside the free allowance imply a lower
 * effective rate and must not be used to derive this.)
 */
const CONTAINER_MEMORY_MICROS_PER_GIB_SECOND = 2.5;

/** USD micros per GB-second of allocated container disk. */
const CONTAINER_DISK_MICROS_PER_GB_SECOND = 0.07;

export interface ProviderUnitPriceInput {
	provider: string;
	model: string;
	usageKind: string;
	unit: string;
	quantity: number;
}

export interface ProviderUnitPriceEstimate {
	providerCostMicros: number;
	rateCardVersion: string | null;
}

/**
 * Estimate integer USD micros from directly observed provider units.
 *
 * Workers AI publishes Flux at $0.0077/audio minute and Aura 1 at
 * $0.015/1,000 input characters. STT sessions are measured in connected
 * seconds; TTS calls are measured in submitted characters.
 */
export function estimateProviderUnitCostMicros(
	input: ProviderUnitPriceInput,
): ProviderUnitPriceEstimate {
	if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
		return { providerCostMicros: 0, rateCardVersion: null };
	}
	if (
		input.provider === "workers-ai" &&
		input.model === "@cf/deepgram/flux" &&
		input.usageKind === "voice_stt" &&
		input.unit === "seconds"
	) {
		return {
			providerCostMicros: Math.round((input.quantity * 7_700) / 60),
			rateCardVersion: PROVIDER_UNIT_PRICING_VERSION,
		};
	}
	if (
		input.provider === "workers-ai" &&
		input.model === "@cf/deepgram/aura-1" &&
		input.usageKind === "voice_tts" &&
		input.unit === "characters"
	) {
		return {
			providerCostMicros: input.quantity * 15,
			rateCardVersion: PROVIDER_UNIT_PRICING_VERSION,
		};
	}
	return { providerCostMicros: 0, rateCardVersion: null };
}

/**
 * Container allocation cost per second, RETAINED BUT DELIBERATELY UNUSED.
 *
 * WHY THERE IS NO CONTAINER RATE IN `estimateProviderUnitCostMicros`:
 * the rate is right and the QUANTITY is wrong. Lease wall-clock is not
 * container allocated time, and pricing it over-estimates by orders of
 * magnitude. Workstation leases and sessions are D1 lifecycle records that
 * outlive the container by days when nothing releases them, whereas
 * Cloudflare bills allocated time while the Durable Object is actually awake.
 * D1 has no visibility into that.
 *
 * So `workstation_compute` rows are recorded UNPRICED: the quantity and the
 * org/tedi/work-item attribution are real and useful, the absolute cost is not
 * derivable from them. This module's stated contract already covers the case —
 * "an unknown model deliberately records a zero estimate plus a null rate-card
 * version instead of inventing a price".
 *
 * The correct model is allocation, not estimation: take Cloudflare's ACTUAL
 * account-level Containers charge as the numerator and distribute it across
 * tenants using an activity key. This helper stays so that work has the
 * verified per-second rate to start from.
 */
export function estimateContainerAllocationMicros(
	leaseSeconds: number,
): number {
	if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) return 0;
	const perSecond =
		CONTAINER_INSTANCE_MEMORY_GIB * CONTAINER_MEMORY_MICROS_PER_GIB_SECOND +
		CONTAINER_INSTANCE_DISK_GB * CONTAINER_DISK_MICROS_PER_GB_SECOND;
	return Math.round(leaseSeconds * perSecond);
}
