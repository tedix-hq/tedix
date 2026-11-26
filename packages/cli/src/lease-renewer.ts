import { setTimeout as sleep } from "node:timers/promises";

/**
 * The one lease-renewal cadence every path shares: wait a third of the
 * confirmed lease, leaving two thirds of it as margin for a lost reply or a
 * slow call. The runner, `work heartbeat --watch`, `work run` and lane
 * watches all schedule through this module, so a missed renewal is noticed
 * and reported in exactly one place per watcher.
 */
export const LEASE_RENEWAL_DIVISOR = 3;

/** Delay until the next renewal: a third of the remaining confirmed lease. */
export function leaseRenewalDelayMs(remainingLeaseMs: number): number {
	return Number.isFinite(remainingLeaseMs) && remainingLeaseMs > 0
		? remainingLeaseMs / LEASE_RENEWAL_DIVISOR
		: 0;
}

export type LeaseRenewalStep =
	| {
			/** The server confirmed a new lease expiry, in epoch milliseconds. */
			kind: "renewed";
			expiresAt: number;
	  }
	| {
			/** A transient failure; try again after this delay. */
			kind: "retry";
			delayMs: number;
	  }
	| {
			/** The lease is definitively gone; the watcher reports it once. */
			kind: "lost";
			reason: string;
	  }
	| {
			/** A bounded watch reached its horizon; stop without a loss. */
			kind: "horizon";
	  }
	| {
			/** The step already reported its own outcome; end the loop. */
			kind: "stop";
	  };

export interface LeaseRenewerOptions {
	/**
	 * One lease call. It receives the last confirmed expiry and must classify
	 * its own failures: return `lost` only when the lease is definitively
	 * gone, `retry` for transient failures, and `stop` after reporting a
	 * terminal outcome itself. A thrown error is treated as `lost`.
	 */
	step: (lease: { expiresAt?: number }) => Promise<LeaseRenewalStep>;
	/** Last confirmed expiry in epoch milliseconds, when already known. */
	expiresAt?: number;
	/** Delay before the first step when no expiry is confirmed yet. */
	firstDelayMs?: number;
	/** Stop scheduling once this epoch millisecond passes. */
	horizonAt?: number;
	now?: () => number;
	wait?: (ms: number) => Promise<void>;
	onRenewed?: (expiresAt: number) => void;
	/**
	 * Called once when renewal is declared lost. Returning a delay keeps the
	 * watcher alive instead (the confirmed expiry is forgotten), for paths
	 * that must keep probing before their run exists.
	 */
	onLost?: (reason: string) => number | void;
	/**
	 * Called when the confirmed expiry passes before the next scheduled
	 * renewal. Return a delay to keep probing without a lease call, `"step"`
	 * to run the step anyway (the server arbitrates an expired lease), or
	 * nothing to report the loss through `onLost`.
	 */
	onExpired?: (
		expiresAt: number,
	) => number | "step" | void | Promise<number | "step" | void>;
	onHorizon?: () => void;
}

export interface LeaseRenewer {
	/** Resolves when the loop ends: lost, horizon, stop, or `stop()`ped. */
	done: Promise<void>;
	stop: () => void;
	/** The last confirmed expiry in epoch milliseconds, when known. */
	expiresAt: () => number | undefined;
	/** Adopt a server-confirmed expiry the watcher learned elsewhere. */
	confirm: (expiresAt: number) => void;
}

export function createLeaseRenewer(options: LeaseRenewerOptions): LeaseRenewer {
	const now = options.now ?? Date.now;
	const wait = options.wait ?? ((ms: number) => sleep(ms));
	let expiry = options.expiresAt;
	let delay =
		options.expiresAt === undefined
			? (options.firstDelayMs ?? 0)
			: leaseRenewalDelayMs(options.expiresAt - now());
	let stopped = false;
	let wake: (() => void) | undefined;
	const capDelay = (ms: number) =>
		options.horizonAt === undefined
			? ms
			: Math.min(ms, Math.max(0, options.horizonAt - now()));
	const done = (async () => {
		for (;;) {
			if (stopped) return;
			if (delay > 0) {
				await Promise.race([
					wait(delay),
					new Promise<void>((resolve) => {
						wake = resolve;
					}),
				]);
				wake = undefined;
			}
			if (stopped) return;
			const at = now();
			if (options.horizonAt !== undefined && at >= options.horizonAt) {
				options.onHorizon?.();
				return;
			}
			if (expiry !== undefined && at >= expiry) {
				const verdict = options.onExpired
					? await options.onExpired(expiry)
					: undefined;
				if (stopped) return;
				if (verdict !== "step") {
					const again =
						typeof verdict === "number"
							? verdict
							: options.onLost?.("Attempt lease expired");
					if (typeof again !== "number" || stopped) return;
					expiry = undefined;
					delay = again;
					continue;
				}
			}
			let step: LeaseRenewalStep;
			try {
				step = await options.step({ expiresAt: expiry });
			} catch (error) {
				const again = options.onLost?.(
					error instanceof Error ? error.message : String(error),
				);
				if (typeof again !== "number" || stopped) return;
				expiry = undefined;
				delay = again;
				continue;
			}
			if (stopped) return;
			switch (step.kind) {
				case "stop":
					return;
				case "horizon":
					options.onHorizon?.();
					return;
				case "lost": {
					const again = options.onLost?.(step.reason);
					if (typeof again !== "number" || stopped) return;
					expiry = undefined;
					delay = again;
					break;
				}
				case "retry":
					delay = capDelay(step.delayMs);
					break;
				case "renewed":
					expiry = step.expiresAt;
					options.onRenewed?.(step.expiresAt);
					delay = capDelay(leaseRenewalDelayMs(step.expiresAt - now()));
					break;
			}
		}
	})();
	return {
		done,
		stop: () => {
			stopped = true;
			wake?.();
		},
		expiresAt: () => expiry,
		confirm: (expiresAt) => {
			if (Number.isFinite(expiresAt) && expiresAt > (expiry ?? 0))
				expiry = expiresAt;
		},
	};
}
