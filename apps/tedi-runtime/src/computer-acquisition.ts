import type { PlatformClient } from "./brain/platform-client";
import type { ComputerEnvironment } from "./computer-environment";
import { delegatedWorkLeaseKey } from "./delegated-work-lease";

export interface AcquisitionStore {
	get<T>(key: string): Promise<T | undefined>;
	put<T>(key: string, value: T): Promise<unknown>;
}

export interface AcquisitionWorkAuthority {
	workItemId: string;
	attemptId: string;
	tediId: string;
}

export interface ComputerAcquisition {
	callId: string;
	scopeKey: string;
	ownerRunId: string | null;
	generation: string;
	preparation: ComputerEnvironment["preparation"];
	work: AcquisitionWorkAuthority | null;
	confirmed?: ComputerEnvironment;
}

export interface ReconciledComputerAcquisition {
	kind: "computer_acquisition";
	terminal: true;
	leaseId: string;
	preparation: ComputerEnvironment["preparation"];
	ready: false;
	/** Only shell acquisition exposes a path before readiness is confirmed. */
	cwd?: string;
	instruction?: string;
}

export const REPOSITORY_STARTING_INSTRUCTION =
	"Repository checkout readiness is not confirmed. Run relative commands with exec and omit cwd; exec checks readiness and selects the prepared checkout. If you need an absolute path, call open_computer({ repository: true }) again on this same lease and use cwd only when ready:true.";

export const computerAcquisitionKey = (callId: string) =>
	`computer-acquisition:${callId}`;

export async function originalAcquisitionAuthority(
	store: AcquisitionStore,
	getClient: () => Promise<Pick<PlatformClient, "listWorkAttempts"> | null>,
	input: {
		runId?: string;
		workItemId?: string;
		tediId?: string;
		attemptId?: string;
	},
) {
	const binding = input.runId
		? await store.get<{ workItemId: string; attemptId: string }>(
				delegatedWorkLeaseKey(input.runId),
			)
		: undefined;
	if (!input.workItemId) {
		if (binding)
			throw new Error(
				"Computer acquisition omitted its retained Work authority",
			);
		return null;
	}
	if (
		!input.runId ||
		!input.tediId ||
		!binding ||
		typeof binding.attemptId !== "string" ||
		!binding.attemptId.trim() ||
		binding.workItemId !== input.workItemId ||
		(input.attemptId && binding.attemptId !== input.attemptId)
	)
		throw new Error(
			"Original Computer acquisition Work binding is unavailable or changed",
		);
	const client = await getClient();
	if (!client)
		throw new Error("Computer acquisition Work authority is unavailable");
	return acquisitionWorkAuthority(client, {
		runId: input.runId,
		workItemId: input.workItemId,
		tediId: input.tediId,
		attemptId: binding.attemptId,
	});
}

/** Observe the original executor Attempt; neither renew nor adopt a successor. */
export async function acquisitionWorkAuthority(
	client: Pick<PlatformClient, "listWorkAttempts">,
	input: {
		workItemId: string;
		runId: string;
		tediId: string;
		attemptId?: string;
	},
): Promise<AcquisitionWorkAuthority> {
	const page = await client.listWorkAttempts({ workItemId: input.workItemId });
	const matches = page.data.filter(
		(row) =>
			row.runId === input.runId &&
			row.executorType === "tedi" &&
			row.executorId === input.tediId &&
			(!input.attemptId || row.id === input.attemptId) &&
			row.runtimeState === "running" &&
			!row.finishedAt &&
			row.expiresAt &&
			Number.isFinite(Date.parse(row.expiresAt)) &&
			Date.parse(row.expiresAt) > Date.now(),
	);
	const attempt = matches.length === 1 ? matches[0] : undefined;
	if (!attempt)
		throw new Error("Original Computer acquisition Work Attempt is not active");
	return {
		workItemId: input.workItemId,
		attemptId: attempt.id,
		tediId: input.tediId,
	};
}

// A DO has one live storage owner. Serialize every acquisition mutation for
// that owner across async reads/writes; a reset discards the prior instance.
const operations = new WeakMap<
	AcquisitionStore,
	Map<string, Promise<unknown>>
>();
export async function withAcquisitionLock<T>(
	store: AcquisitionStore,
	key: string,
	operation: () => Promise<T>,
): Promise<T> {
	let pending = operations.get(store);
	if (!pending) {
		pending = new Map();
		operations.set(store, pending);
	}
	const previous = pending.get(key) ?? Promise.resolve();
	const result = previous.catch(() => {}).then(operation);
	pending.set(key, result);
	try {
		return await result;
	} finally {
		if (pending.get(key) === result) pending.delete(key);
	}
}

function sameIdentity(a: ComputerAcquisition, b: ComputerAcquisition) {
	return (
		a.callId === b.callId &&
		a.scopeKey === b.scopeKey &&
		a.ownerRunId === b.ownerRunId &&
		a.generation === b.generation &&
		a.preparation === b.preparation &&
		JSON.stringify(a.work) === JSON.stringify(b.work)
	);
}

export async function beginComputerAcquisition(
	store: AcquisitionStore,
	intent: ComputerAcquisition,
) {
	return withAcquisitionLock(
		store,
		computerAcquisitionKey(intent.callId),
		async () => {
			const previous = await store.get<ComputerAcquisition>(
				computerAcquisitionKey(intent.callId),
			);
			if (previous) {
				if (!sameIdentity(previous, intent))
					throw new Error("Conflicting Computer acquisition identity");
				if (!previous.confirmed)
					throw new Error(
						"Computer provisioning outcome is unknown; do not reprovision",
					);
				return previous;
			}
			await store.put(computerAcquisitionKey(intent.callId), intent);
			return intent;
		},
	);
}

export async function confirmComputerAcquisition(
	store: AcquisitionStore,
	intent: ComputerAcquisition,
	environment: ComputerEnvironment,
) {
	return withAcquisitionLock(
		store,
		computerAcquisitionKey(intent.callId),
		async () => {
			const current = await store.get<ComputerAcquisition>(
				computerAcquisitionKey(intent.callId),
			);
			if (
				!current ||
				!sameIdentity(current, intent) ||
				environment.preparation !== intent.preparation ||
				(current.confirmed && current.confirmed.leaseId !== environment.leaseId)
			)
				throw new Error("Conflicting Computer acquisition confirmation");
			await store.put(computerAcquisitionKey(intent.callId), {
				...intent,
				confirmed: { ...environment },
			});
		},
	);
}

/** A new call may replace a proven dead selection; invalidate its old proof first. */
export async function replaceComputerAcquisition(
	store: AcquisitionStore,
	current: ComputerAcquisition,
	generation: string,
): Promise<ComputerAcquisition> {
	return withAcquisitionLock(
		store,
		computerAcquisitionKey(current.callId),
		async () => {
			const retained = await store.get<ComputerAcquisition>(
				computerAcquisitionKey(current.callId),
			);
			if (
				!retained?.confirmed ||
				!sameIdentity(retained, current) ||
				generation === current.generation
			)
				throw new Error(
					"Computer replacement lacks the exact confirmed acquisition",
				);
			const replacement = { ...current, generation };
			delete replacement.confirmed;
			await store.put(computerAcquisitionKey(current.callId), replacement);
			return replacement;
		},
	);
}

/** Only durable confirmation can resolve an interrupted mutating open call. */
export async function reconcileComputerAcquisition(
	store: AcquisitionStore,
	runId: string,
	callId: string,
	assertAuthority: (acquisition: ComputerAcquisition) => Promise<void>,
): Promise<ReconciledComputerAcquisition | null> {
	const receipt = await store.get<ComputerAcquisition>(
		computerAcquisitionKey(callId),
	);
	if (!receipt) return null;
	if (!receipt.confirmed) return null;
	if (receipt.callId !== callId || receipt.ownerRunId !== runId)
		throw new Error("Conflicting Computer acquisition owner");
	await assertAuthority(receipt);
	return withAcquisitionLock(store, receipt.scopeKey, async () => {
		const current = await store.get<ComputerAcquisition>(
			computerAcquisitionKey(callId),
		);
		const confirmed = current?.confirmed;
		if (
			!current ||
			!sameIdentity(current, receipt) ||
			!confirmed ||
			confirmed.leaseId !== receipt.confirmed?.leaseId
		)
			throw new Error(
				"Computer acquisition confirmation changed during recovery",
			);
		const [owner, generation, selected] = await Promise.all([
			store.get<string>(`${receipt.scopeKey}:owner`),
			store.get<string>(`${receipt.scopeKey}:generation`),
			store.get<ComputerEnvironment>(receipt.scopeKey),
		]);
		if (
			owner !== runId ||
			generation !== receipt.generation ||
			selected?.leaseId !== confirmed.leaseId ||
			selected.preparation !== receipt.preparation ||
			confirmed.preparation !== receipt.preparation
		)
			throw new Error(
				"Computer acquisition scope, generation or lease changed",
			);
		return {
			kind: "computer_acquisition",
			terminal: true,
			leaseId: selected.leaseId,
			preparation: selected.preparation,
			ready: false,
			...(selected.preparation === "shell"
				? { cwd: selected.cwd }
				: { instruction: REPOSITORY_STARTING_INSTRUCTION }),
		};
	});
}

export class ComputerAcquisitionDeadline extends Error {
	constructor() {
		super("Computer acquisition foreground deadline exceeded");
	}
}

/** Deadline covers the whole foreground action, not only its HTTP fetch. */
export class AcquisitionDeadline {
	private active = true;
	readonly at: number;
	constructor(budgetMs: number) {
		this.at = Date.now() + budgetMs;
	}
	check() {
		if (!this.active || Date.now() >= this.at)
			throw new ComputerAcquisitionDeadline();
	}
	remaining() {
		this.check();
		return Math.max(1, this.at - Date.now());
	}
	async run<T>(operation: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				operation,
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(
						() => {
							this.active = false;
							reject(new ComputerAcquisitionDeadline());
						},
						Math.max(0, this.at - Date.now()),
					);
				}),
			]);
		} finally {
			this.active = false;
			clearTimeout(timer);
		}
	}
}
