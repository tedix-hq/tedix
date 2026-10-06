import type { FiberInspection, StartFiberResult } from "agents";

export const WORKSTATION_PROVISION_FIBER_NAME = "workstation-provision";
export const WORKSTATION_PROVISION_MAX_ATTEMPTS = 3;

export function workstationProvisioningAttemptNumber(
	fiber: FiberInspection | null,
): number {
	const value = fiber?.metadata?.provisioningAttempt;
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: fiber
			? 1
			: 0;
}

export function workstationProvisioningFiberMetadata(
	input: { leaseId: string; workstationId?: string },
	previous: FiberInspection | null,
): Record<string, unknown> {
	return {
		leaseId: input.leaseId,
		provisioningAttempt: workstationProvisioningAttemptNumber(previous) + 1,
		workstationId: input.workstationId ?? null,
	};
}

export function workstationProvisioningFiberName(leaseId: string): string {
	return `${WORKSTATION_PROVISION_FIBER_NAME}:${leaseId}`;
}

export function workstationProvisioningBaseKey(leaseId: string): string {
	return `${WORKSTATION_PROVISION_FIBER_NAME}:${leaseId}`;
}

/**
 * A terminal attempt remains retained by the Agents SDK. Deriving the next
 * key from that attempt makes a retry fresh while keeping concurrent callers
 * on the same deterministic successor.
 */
export function workstationProvisioningAttemptKey(
	leaseId: string,
	previous: FiberInspection | null,
): string {
	const baseKey = workstationProvisioningBaseKey(leaseId);
	return previous ? `${baseKey}:after:${previous.fiberId}` : baseKey;
}

export function isActiveWorkstationProvisioningFiber(
	fiber: FiberInspection,
): boolean {
	if (fiber.status === "interrupted") {
		return fiber.settledAt === undefined;
	}
	return !["aborted", "completed", "error"].includes(fiber.status);
}

export function shouldStartWorkstationProvisioningSuccessor(
	fiber: FiberInspection | null,
	leaseStatus: unknown,
	ready: unknown,
	nextAction?: unknown,
	lastBootstrapError?: unknown,
): fiber is FiberInspection {
	const retryableComputerConnectionFailure =
		typeof lastBootstrapError === "string" &&
		(/CloudflareContainerBackend\([^)]*\)(?: \[stage=(?:connect|ws)\]|: connect failed at stage=(?:start|health|restart|connect|ws)\b)/.test(
			lastBootstrapError,
		) ||
			/WritableStream RPC stub was disposed without calling close\(\)/i.test(
				lastBootstrapError,
			));
	const recoverableTerminalFiber =
		fiber?.status === "error" ||
		(fiber?.status === "interrupted" && fiber.settledAt !== undefined);
	return (
		recoverableTerminalFiber &&
		workstationProvisioningAttemptNumber(fiber) <
			WORKSTATION_PROVISION_MAX_ATTEMPTS &&
		(leaseStatus === "provisioning" ||
			(leaseStatus === "blocked" &&
				(nextAction === "wait_for_repo_sync" ||
					retryableComputerConnectionFailure))) &&
		ready !== true
	);
}

export function latestWorkstationProvisioningFiber(
	...fibers: Array<FiberInspection | null | undefined>
): FiberInspection | null {
	return (
		fibers
			.filter(
				(fiber): fiber is FiberInspection =>
					fiber !== null && fiber !== undefined,
			)
			.sort((left, right) =>
				right.createdAt === left.createdAt
					? right.fiberId.localeCompare(left.fiberId)
					: right.createdAt - left.createdAt,
			)[0] ?? null
	);
}

/** Diagnostic evidence only: never contains an actionable readiness/ownership bit. */
export function workstationPreparationObservation(input: {
	leaseId: string;
	refreshId?: string;
	source: "persisted_status" | "native_refresh";
	receipt: Record<string, unknown>;
	fiber?: { fiberId: string; status: string };
}) {
	const record = (v: unknown): Record<string, unknown> =>
		v && typeof v === "object" && !Array.isArray(v)
			? (v as Record<string, unknown>)
			: {};
	const identifier = (v: string) => /^[A-Za-z0-9_:.-]{1,256}$/.test(v);
	const oneOf =
		(...values: string[]) =>
		(v: string) =>
			values.includes(v);
	const timestamp = (v: string) =>
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
		Number.isFinite(Date.parse(v)) &&
		new Date(v).toISOString() === v;
	const pick = (
		v: unknown,
		validators: Record<string, (v: string) => boolean>,
	) => {
		const value = record(v);
		return Object.fromEntries(
			Object.entries(validators)
				.filter(
					([key, valid]) =>
						typeof value[key] === "string" && valid(value[key] as string),
				)
				.map(([key]) => [key, value[key]]),
		);
	};
	return {
		...(identifier(input.leaseId) ? { leaseId: input.leaseId } : {}),
		...(input.refreshId && identifier(input.refreshId)
			? { refreshId: input.refreshId }
			: {}),
		source: input.source,
		...pick(input.receipt, { observedAt: timestamp }),
		repoSync: pick(input.receipt.repoSync, {
			status: oneOf(
				"not_configured",
				"cloned",
				"dirty",
				"failed",
				"refused",
				"skipped_credentials",
				"syncing",
				"unsupported_strategy",
				"updated",
			),
			executionId: identifier,
			executionState: oneOf("admitting", "missing", "running", "terminal"),
		}),
		bootstrap: pick(input.receipt.bootstrap, {
			nextAction: oneOf(
				"repair_workstation_tools",
				"configure_github_credentials",
				"wait_for_repo_sync",
				"open_computer",
				"wait_for_install_process",
				"cancel_and_restart_install_process",
				"restart_install_process",
				"start_install_process",
			),
		}),
		...(input.fiber
			? {
					provisioningFiber: pick(input.fiber, {
						fiberId: identifier,
						status: oneOf(
							"pending",
							"running",
							"interrupted",
							"completed",
							"error",
							"aborted",
						),
					}),
				}
			: {}),
	};
}

/** Exact refresh ownership prevents old completed provisioning from proving readiness. */
export function workstationRefreshKey(
	leaseId: string,
	refreshId: string,
): string {
	return `${workstationProvisioningBaseKey(leaseId)}:refresh:${refreshId}`;
}

export async function observeWorkstationRefresh(
	input: { leaseId: string; refreshId: string },
	deps: {
		inspect(key: string): Promise<FiberInspection | null>;
		latest(): Promise<FiberInspection | null>;
		start(key: string): Promise<FiberInspection>;
	},
): Promise<Record<string, unknown>> {
	const key = workstationRefreshKey(input.leaseId, input.refreshId);
	let fiber = await deps.inspect(key);
	if (!fiber) {
		const prior = await deps.latest();
		if (prior && isActiveWorkstationProvisioningFiber(prior))
			return {
				ok: true,
				ready: false,
				provisioningFiber: { fiberId: prior.fiberId, status: prior.status },
			};
		fiber = await deps.start(key);
	}
	const snapshot = fiber.snapshot as
		| {
				leaseId?: string;
				refreshId?: string;
				refreshReceipt?: Record<string, unknown>;
		  }
		| undefined;
	if (
		fiber.status === "completed" &&
		snapshot?.leaseId === input.leaseId &&
		snapshot.refreshId === input.refreshId &&
		snapshot.refreshReceipt
	) {
		const receipt = snapshot.refreshReceipt;
		const readiness = receipt.readiness as
			| { toolsReady?: boolean; repoReady?: boolean }
			| undefined;
		if (
			receipt.ready === true ||
			(readiness?.toolsReady === true && readiness?.repoReady === true)
		)
			return receipt;
		return {
			...receipt,
			ok: false,
			ready: false,
			error:
				receipt.error ??
				receipt.setupError ??
				"Native Computer refresh settled without readiness; inspect repository preparation before retrying",
		};
	}
	if (!isActiveWorkstationProvisioningFiber(fiber))
		return {
			ok: false,
			ready: false,
			error:
				fiber.error ??
				"Native Computer refresh ended without a matching fresh readiness receipt",
		};
	return {
		ok: true,
		ready: false,
		provisioningFiber: { fiberId: fiber.fiberId, status: fiber.status },
		...(snapshot?.leaseId === input.leaseId &&
		snapshot.refreshId === input.refreshId &&
		snapshot.refreshReceipt
			? {
					lastObservation: workstationPreparationObservation({
						...input,
						source: "native_refresh",
						receipt: snapshot.refreshReceipt,
						fiber,
					}),
				}
			: {}),
	};
}

const provisioningAdmissions = new WeakMap<
	object,
	Map<string, Promise<void>>
>();
/** Serialize admission, not execution. Durable SDK identities survive isolate loss. */
export async function admitWorkstationProvisioning(
	owner: object,
	leaseId: string,
	deps: {
		active(): Promise<FiberInspection | null>;
		start(): Promise<StartFiberResult>;
	},
): Promise<StartFiberResult> {
	let leases = provisioningAdmissions.get(owner);
	if (!leases) {
		leases = new Map();
		provisioningAdmissions.set(owner, leases);
	}
	const before = leases.get(leaseId) ?? Promise.resolve();
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = before.then(() => held);
	leases.set(leaseId, tail);
	await before;
	try {
		const active = await deps.active();
		if (active) return { ...active, accepted: false };
		return await deps.start();
	} finally {
		release();
		if (leases.get(leaseId) === tail) leases.delete(leaseId);
	}
}
