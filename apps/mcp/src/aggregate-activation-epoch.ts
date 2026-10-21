import {
	CACHE_TIER_BUDGET_MS,
	StepBudgetExceededError,
	withStepBudget,
} from "./lib/step-budget";
import { contentFreeMcpException, createMcpLogger } from "./log";
const log = createMcpLogger("mcp.router");

const AGGREGATE_ACTIVATION_MARKER_KEY = "aggregate-activation/v1/current";
const AGGREGATE_ACTIVATION_EPOCH_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
function isValidAggregateActivationEpoch(value: string): boolean {
	const match = value.match(AGGREGATE_ACTIVATION_EPOCH_PATTERN);
	return Boolean(match && match[0] === value);
}

export async function readAggregateActivationEpoch(
	env: CloudflareEnv,
): Promise<{ value: string; cacheable: boolean }> {
	if (env.AGGREGATE_EPOCH_KV) {
		try {
			const value = await withStepBudget(
				"aggregate_activation_epoch_instant_read",
				CACHE_TIER_BUDGET_MS,
				env.AGGREGATE_EPOCH_KV.get(AGGREGATE_ACTIVATION_MARKER_KEY),
				AGGREGATE_ACTIVATION_MARKER_KEY,
			);
			if (value !== null) {
				if (isValidAggregateActivationEpoch(value)) {
					return { value, cacheable: true };
				}
				console.warn(
					"[aggregate] KV Instant activation epoch marker is invalid",
				);
			}
		} catch (error) {
			if (!(error instanceof StepBudgetExceededError)) {
				log.warn("KV Instant aggregate activation epoch read failed", {
					event: "aggregate.activation_epoch_instant_read_failed",
					outcome: "unavailable",
					error: contentFreeMcpException(error),
				});
			}
		}
	}
	if (!("AGGREGATE_CACHE" in env) || !env.AGGREGATE_CACHE) {
		return { value: "local", cacheable: true };
	}
	try {
		const object = await withStepBudget(
			"aggregate_activation_epoch_read",
			CACHE_TIER_BUDGET_MS,
			env.AGGREGATE_CACHE.get(AGGREGATE_ACTIVATION_MARKER_KEY),
			AGGREGATE_ACTIVATION_MARKER_KEY,
		);
		if (!object) return { value: "initial", cacheable: true };
		if (typeof object.size === "number" && object.size > 128) {
			console.warn("[aggregate] activation epoch marker is invalid");
			return { value: `unavailable:${crypto.randomUUID()}`, cacheable: false };
		}
		const value = await object.text();
		if (!isValidAggregateActivationEpoch(value)) {
			console.warn("[aggregate] activation epoch marker is invalid");
			return { value: `unavailable:${crypto.randomUUID()}`, cacheable: false };
		}
		return { value, cacheable: true };
	} catch (error) {
		if (!(error instanceof StepBudgetExceededError)) {
			log.warn("Aggregate activation epoch read failed", {
				event: "aggregate.activation_epoch_read_failed",
				outcome: "unavailable",
				error: contentFreeMcpException(error),
			});
		}
		// Never reuse an earlier generation when the fence cannot be read. A unique
		// generation also prevents this request from joining or seeding any shared
		// aggregate/internal cache while R2 is unavailable.
		return { value: `unavailable:${crypto.randomUUID()}`, cacheable: false };
	}
}

export async function writeAggregateActivationEpoch(
	env: CloudflareEnv,
	activationEpoch: string,
): Promise<void> {
	// Keep the existing R2 fence current first. If the optional fast-path write
	// fails, removing its old pointer makes readers fall through to this marker.
	if ("AGGREGATE_CACHE" in env && env.AGGREGATE_CACHE) {
		await env.AGGREGATE_CACHE.put(
			AGGREGATE_ACTIVATION_MARKER_KEY,
			activationEpoch,
		);
	}
	if (!env.AGGREGATE_EPOCH_KV) return;
	try {
		await withStepBudget(
			"aggregate_activation_epoch_instant_write",
			CACHE_TIER_BUDGET_MS,
			env.AGGREGATE_EPOCH_KV.put(
				AGGREGATE_ACTIVATION_MARKER_KEY,
				activationEpoch,
			),
			AGGREGATE_ACTIVATION_MARKER_KEY,
		);
	} catch (error) {
		// A stale-but-valid Instant pointer would mask the fresh R2 fallback. Remove
		// it before allowing the purge to continue; if deletion also fails, abort
		// the purge so no caller is told that the new generation is active.
		await withStepBudget(
			"aggregate_activation_epoch_instant_delete",
			CACHE_TIER_BUDGET_MS,
			env.AGGREGATE_EPOCH_KV.delete(AGGREGATE_ACTIVATION_MARKER_KEY),
			AGGREGATE_ACTIVATION_MARKER_KEY,
		);
		if (!(error instanceof StepBudgetExceededError)) {
			log.warn("KV Instant aggregate activation epoch write failed", {
				event: "aggregate.activation_epoch_instant_write_failed",
				outcome: "unavailable",
				error: contentFreeMcpException(error),
			});
		}
	}
}
