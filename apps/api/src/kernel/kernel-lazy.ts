/**
 * Dynamic access to kernel implementation modules.
 *
 * Kernel Durable Objects are exported at Worker startup. Their static import
 * graph must not reach RPC implementation modules; importing those modules
 * only when a turn or reconciliation needs them preserves the startup boundary.
 * `apps/api/scripts/check-lazy-imports.ts` guards that boundary.
 * Each loader memoizes its module promise per isolate.
 */

type KernelTurnDelegationModule =
	typeof import("../rpc/routers/kernel-runtime/turn-delegation");
type KernelRunReadsModule =
	typeof import("../rpc/routers/kernel-runtime/run-reads-streams");
type KernelChildRunReadsModule =
	typeof import("../rpc/routers/kernel/child-run-reads");
type KernelHomePlanModule = typeof import("../rpc/routers/kernel/home-plan");
type TurnWorkModule = typeof import("../rpc/routers/kernel/turn-work");
type HomeLiveEventsModule =
	typeof import("../rpc/routers/kernel/home-live-events");
type TediHelpersModule = typeof import("../rpc/routers/tedis/helpers");
type RuntimeSubmissionBridgeModule =
	typeof import("./runtime-submission-bridge");

let kernelTurnDelegation: Promise<KernelTurnDelegationModule> | undefined;
let kernelRunReads: Promise<KernelRunReadsModule> | undefined;
let kernelChildRunReads: Promise<KernelChildRunReadsModule> | undefined;
let kernelHomePlan: Promise<KernelHomePlanModule> | undefined;
let turnWork: Promise<TurnWorkModule> | undefined;
let homeLiveEvents: Promise<HomeLiveEventsModule> | undefined;
let tediHelpers: Promise<TediHelpersModule> | undefined;

export function loadKernelTurnDelegation(): Promise<KernelTurnDelegationModule> {
	kernelTurnDelegation ??=
		import("../rpc/routers/kernel-runtime/turn-delegation");
	return kernelTurnDelegation;
}

export function loadKernelRunReads(): Promise<KernelRunReadsModule> {
	kernelRunReads ??= import("../rpc/routers/kernel-runtime/run-reads-streams");
	return kernelRunReads;
}

export function loadKernelChildRunReads(): Promise<KernelChildRunReadsModule> {
	kernelChildRunReads ??= import("../rpc/routers/kernel/child-run-reads");
	return kernelChildRunReads;
}

export function loadKernelHomePlan(): Promise<KernelHomePlanModule> {
	kernelHomePlan ??= import("../rpc/routers/kernel/home-plan");
	return kernelHomePlan;
}

/** `runKernelTurnWork` — the turn executor. */
export function loadTurnWork(): Promise<TurnWorkModule> {
	turnWork ??= import("../rpc/routers/kernel/turn-work");
	return turnWork;
}

/** `recordHomeAnswerDelta`, `recordHomeRationaleDelta`, `recordHomePhaseEvent`
 * — Home live-event sinks. */
export function loadHomeLiveEvents(): Promise<HomeLiveEventsModule> {
	homeLiveEvents ??= import("../rpc/routers/kernel/home-live-events");
	return homeLiveEvents;
}

/** `getProvisioningConfig` — tedi runtime route resolution. */
export function loadTediHelpers(): Promise<TediHelpersModule> {
	tediHelpers ??= import("../rpc/routers/tedis/helpers");
	return tediHelpers;
}

/** Submission admission, recovery, and exactly-once settlement helpers. */
export function loadRuntimeSubmissionBridge(): Promise<RuntimeSubmissionBridgeModule> {
	return import("./runtime-submission-bridge");
}
