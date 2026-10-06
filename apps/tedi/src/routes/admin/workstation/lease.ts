import { startCheckoutOperation } from "../../../workstation/checkout-lock";
import { WorkstationBootstrapReadinessSchema } from "@tedix/api-contract/schemas/workstation";
import { createDbClient } from "@tedix/db/client";
import { getAuthoritativeWorkItemAttempt } from "@tedix/db/queries/work-items/attempts";
import { scrubText } from "@tedix/context-core/trace-safety";
import type { Context } from "hono";
import { workstationEgressPolicySummary } from "../../../runtime/workstation-egress";
import type { AppEnv } from "../../../types";
import {
	WorkstationDispatchUnknownError,
	type WorkstationRuntimeBody,
} from "../../../workstation/computer-body";
import { isWorkstationPath, WORKSTATION_DIR } from "../../../workstation/paths";
import {
	getWorkstationLeaseBundle,
	joinWorkstationLease,
	releaseWorkstationLease,
	type WorkstationJoinContext,
	type WorkstationJoinSeat,
} from "../../../workstation/persistence";
import { persistWorkstationRecoveryCheckpoint } from "../../../workstation/recovery-checkpoint";
import {
	type RepoSyncResult,
	type RepoTreePreflight,
	ensureCleanRepoTreeForTurn,
} from "../../../workstation/repo-sync";
import { destroySandboxWithTimeout } from "../../../workstation/sandbox-destroy";
import {
	ACTIVE_WORKSTATION_PROFILE_ID,
	ACTIVE_WORKSTATION_BINDING,
	workstationPreparation,
	type WorkstationState,
	type WorkstationSessionSelection,
	workstationErrorStatus,
	CHECKOUT_CLOSING_MARKER,
	assertCheckoutAuthority,
	shellSingleQuote,
	repoReady,
	readBootstrapReadiness,
	workstationStatusForReadiness,
	parseJsonBody,
	workstationSessionSelectionForRequest,
	traceIdFromRequest,
	stringBodyValue,
	workstationCorrelationFromBody,
	workstationRecoveryCheckpointKeys,
	preparedPreflight,
	immutableLeasePreflight,
	checkpointNative,
	recoveryCheckpointOperation,
	restoreRecoveryCheckpoint,
	scheduleRepoSync,
	prepareWorkstationFastSafe,
	persistentWorkstationEnvelope,
	markWorkstationBodyStatus,
	REPO_SYNC_OPTIONS,
} from "./shared";
import { errorMessage } from "@tedix/worker-kit/error-message";

function isTransientWorkstationProvisioningError(error: unknown): boolean {
	const message =
		typeof error === "string"
			? error
			: error instanceof Error
				? error.message
				: String(error ?? "");
	return (
		message.startsWith("checkout preparation pending:") ||
		/durable object reset because its code was updated/i.test(message) ||
		/there is no container instance that can be provided to this durable object/i.test(
			message,
		)
	);
}

/**
 * The turn this workstation preparation belongs to. The clean-tree preflight is
 * keyed on it so the shared checkout is reset at most once per delegated coding
 * turn — a repeated `/wake` poll inside the same turn replays the recorded
 * outcome instead of resetting over work the turn has already produced.
 */
function workstationTreeTurnKey(
	body: Record<string, unknown> | null,
	session?: WorkstationSessionSelection,
): string | null {
	return (
		session?.leaseBundle?.workstationLease.attemptId ??
		stringBodyValue(body, "workItemId") ??
		stringBodyValue(body, "kernelRunId") ??
		stringBodyValue(body, "executionId") ??
		session?.leaseId ??
		stringBodyValue(body, "leaseId")
	);
}

function clearRepoPreflightAuthority(repoSync: RepoSyncResult): RepoSyncResult {
	if (!repoSync.configured || !repoSync.treePreflight) return repoSync;
	const { authoritySource: _authoritySource, ...persisted } =
		repoSync.treePreflight;
	return { ...repoSync, treePreflight: persisted };
}

/**
 * Run the runtime-owned clean-tree preflight for this turn and fold its outcome
 * (`clean` | `quarantined` | `refused`) into the repo-sync receipt the wake
 * response and the persisted lease metadata already carry. A `refused` outcome
 * blocks readiness: the delegated turn must not start from an unprovable tree.
 */
async function applyRepoTreePreflight(
	c: Context<AppEnv>,
	state: WorkstationState,
	body: Record<string, unknown> | null,
	session?: WorkstationSessionSelection,
): Promise<WorkstationState> {
	const repoSync = clearRepoPreflightAuthority(state.repoSync);
	const clearedState =
		repoSync === state.repoSync ? state : { ...state, repoSync };
	if (state.preparation === "shell") return clearedState;
	if (!repoSync.configured) return clearedState;
	const turnKey = workstationTreeTurnKey(body, session);
	if (!turnKey) return clearedState;
	const tediConfig = c.get("tediConfig");
	let preflight: RepoTreePreflight | null;
	try {
		preflight = await ensureCleanRepoTreeForTurn(c.get("sandbox"), tediConfig, {
			...REPO_SYNC_OPTIONS,
			turnKey,
			workItemId: stringBodyValue(body, "workItemId"),
			originalPreflight:
				immutableLeasePreflight(session?.leaseBundle?.workstationLease) ??
				undefined,
			authorize: () => assertCheckoutAuthority(c),
		});
	} catch (err) {
		if (err instanceof WorkstationDispatchUnknownError) {
			const error = `checkout preparation pending: ${errorMessage(err)}`;
			return {
				...state,
				repoSync: {
					...repoSync,
					status: "syncing",
					executionId: err.executionId,
					executionState: "admitting",
					error,
				},
				setupError: error,
			};
		}
		preflight = {
			at: new Date().toISOString(),
			branch: repoSync.branch,
			outcome: "refused",
			reason: `clean-tree preflight failed: ${errorMessage(err)}`,
			turnKey,
			workdir: repoSync.workdir,
		};
	}
	if (!preflight) return clearedState;
	if (preflight.outcome !== "refused") {
		return {
			...clearedState,
			repoSync: { ...repoSync, treePreflight: preflight },
		};
	}
	const error =
		preflight.reason ??
		"the workstation checkout could not be verified clean; the turn must not start from this tree";
	return {
		...clearedState,
		repoSync: {
			...repoSync,
			error,
			status: "refused",
			treePreflight: preflight,
		},
		setupError: error,
	};
}

const WORKSTATION_SEAT_ROLES = new Set([
	"lead",
	"collaborator",
	"operator",
	"reviewer",
	"specialist",
]);

function parseJoinSeats(value: unknown): WorkstationJoinSeat[] {
	if (!Array.isArray(value)) return [];
	const seats: WorkstationJoinSeat[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const record = entry as Record<string, unknown>;
		if (typeof record.tediId !== "string" || !record.tediId) continue;
		const role =
			typeof record.role === "string" && WORKSTATION_SEAT_ROLES.has(record.role)
				? (record.role as WorkstationJoinSeat["role"])
				: undefined;
		seats.push({
			tediId: record.tediId,
			role,
			slug: typeof record.slug === "string" ? record.slug : undefined,
			permissionScopes: Array.isArray(record.permissionScopes)
				? record.permissionScopes.filter(
						(scope): scope is string => typeof scope === "string",
					)
				: undefined,
		});
	}
	return seats;
}

export async function provisionWorkstation(c: Context<AppEnv>) {
	const body = (await parseJsonBody(c)) ?? {};
	const attemptId = stringBodyValue(body, "attemptId");
	const workItemId = stringBodyValue(body, "workItemId");
	const tediConfig = c.get("tediConfig");
	if (attemptId || workItemId) {
		if (!attemptId || !workItemId || !tediConfig.organizationId)
			return c.json(
				{ ok: false, error: "Invalid governed Work authority" },
				403,
			);
		try {
			await getAuthoritativeWorkItemAttempt(createDbClient(c.env.DB), {
				orgId: tediConfig.organizationId,
				workItemId,
				attemptId,
				executor: { type: "tedi", id: tediConfig.id },
			});
		} catch {
			return c.json(
				{ ok: false, error: "Work Attempt is not authoritative" },
				403,
			);
		}
	}
	if (
		body.preparation !== undefined &&
		body.preparation !== "shell" &&
		body.preparation !== "repository"
	)
		return c.json({ ok: false, error: "Invalid preparation" }, 400);
	const envelope = await persistentWorkstationEnvelope(
		c,
		null,
		"provisioning",
		"shell",
		{
			attemptId,
			preparation: body.preparation === "shell" ? "shell" : "repository",
			executionId:
				typeof body.executionId === "string" ? body.executionId : null,
			...workstationCorrelationFromBody(body),
		},
	);
	const persisted = envelope.workstationPersistence.status === "persisted";
	return c.json(
		{
			accepted: persisted,
			ok: persisted,
			ready: false,
			status: "provisioning",
			...envelope,
		},
		persisted ? 202 : 503,
	);
}

export async function wakeWorkstation(c: Context<AppEnv>) {
	const body = (await parseJsonBody(c)) ?? {};
	const tediConfig = c.get("tediConfig");
	let selectedSession: WorkstationSessionSelection | undefined;
	if (stringBodyValue(body, "leaseId")) {
		const selection = await workstationSessionSelectionForRequest(
			c,
			body,
			"shell",
		);
		if (!selection.ok) {
			return c.json(
				{ ok: false, error: selection.error },
				workstationErrorStatus(selection.status),
			);
		}
		selectedSession = selection.session;
	}
	let state = await prepareWorkstationFastSafe(
		c,
		workstationPreparation(selectedSession),
	);
	if (!state.setupError && state.repoSync.status === "syncing") {
		scheduleRepoSync(c);
	}
	// The clean-tree preflight runs before any checkpoint is restored: it is the
	// runtime's own gate on the shared checkout, and resetting after a restore
	// would destroy exactly the work the checkpoint brought back.
	if (!state.setupError && repoReady(state.repoSync)) {
		state = await applyRepoTreePreflight(c, state, body, selectedSession);
	}
	if (!state.setupError && repoReady(state.repoSync)) {
		const checkpoint = await restoreRecoveryCheckpoint(c, state.repoSync);
		if (checkpoint.status === "failed")
			state = {
				...state,
				setupError: `Computer recovery failed: ${checkpoint.error ?? "unknown error"}`,
			};
	}

	const bootstrap = await readBootstrapReadiness(
		c,
		state,
		body,
		selectedSession,
		body.cacheBackupMode === "synchronous" ? "synchronous" : "deferred",
	);
	const transientProvisioningError = isTransientWorkstationProvisioningError(
		state.setupError,
	);
	const status = transientProvisioningError
		? "provisioning"
		: workstationStatusForReadiness(state, bootstrap);
	const envelope = await persistentWorkstationEnvelope(
		c,
		state,
		status,
		"shell",
		{
			bindRepositoryAuthority: true,
			executionId:
				typeof body.executionId === "string" ? body.executionId : null,
			...workstationCorrelationFromBody(body),
			readiness: bootstrap,
			session: selectedSession,
		},
	);
	await markWorkstationBodyStatus(c, status);

	return c.json({
		ok: transientProvisioningError || !state.setupError,
		ready: bootstrap.environmentReady,
		bootstrap,
		readiness: bootstrap.dimensions,
		bodyAdapter: ACTIVE_WORKSTATION_BINDING.bodyAdapter,
		egressPolicy: workstationEgressPolicySummary(tediConfig),
		runtimeKind: tediConfig.runtimeKind ?? "agent",
		sandboxKind: ACTIVE_WORKSTATION_BINDING.adapterKind,
		workstationRoot: WORKSTATION_DIR,
		slug: tediConfig.slug,
		tediId: tediConfig.id,
		credentials: state.credentials,
		repoSync: state.repoSync,
		setupError: state.setupError,
		transientProvisioningError,
		tools: state.tools,
		...envelope,
	});
}

export async function readWorkstationStatus(c: Context<AppEnv>) {
	const body = (await parseJsonBody(c)) ?? {};
	const selectedSession = await workstationSessionSelectionForRequest(
		c,
		body,
		"shell",
	);
	if (!selectedSession.ok) {
		return c.json(
			{ ok: false, error: selectedSession.error },
			workstationErrorStatus(selectedSession.status),
		);
	}
	if (!c.env.DB) {
		return c.json(
			{ ok: false, error: "workstation persistence is not configured" },
			503,
		);
	}
	const bundle = await getWorkstationLeaseBundle(
		createDbClient(c.env.DB),
		selectedSession.session.leaseId,
	);
	if (!bundle) {
		return c.json(
			{
				ok: false,
				error: `workstation lease not found: ${selectedSession.session.leaseId}`,
			},
			404,
		);
	}
	const metadata = bundle.workstation.metadata;
	const parsedBootstrap = WorkstationBootstrapReadinessSchema.safeParse(
		metadata.bootstrapReadiness,
	);
	const bootstrap = parsedBootstrap.success ? parsedBootstrap.data : null;
	const ready =
		bundle.workstation.status === "ready" &&
		bootstrap?.environmentReady === true;

	return c.json({
		ok: true,
		ready,
		status: bundle.workstation.status,
		bootstrap,
		readiness: bootstrap?.dimensions ?? null,
		bodyAdapter:
			typeof metadata.bodyAdapter === "string"
				? metadata.bodyAdapter
				: ACTIVE_WORKSTATION_BINDING.bodyAdapter,
		credentials: metadata.credentials ?? null,
		repoSync: metadata.repoSync ?? null,
		runtimeKind:
			typeof metadata.runtimeKind === "string" ? metadata.runtimeKind : "agent",
		sandboxKind:
			typeof metadata.sandboxKind === "string"
				? metadata.sandboxKind
				: ACTIVE_WORKSTATION_BINDING.adapterKind,
		setupError:
			typeof metadata.setupError === "string" ? metadata.setupError : null,
		tools: metadata.tools ?? null,
		workstationRoot:
			typeof metadata.workstationRoot === "string"
				? metadata.workstationRoot
				: WORKSTATION_DIR,
		workstation: bundle.workstation,
		workstationLease: bundle.workstationLease,
		workstationPersistence: { status: "persisted" as const },
	});
}

// Append participant seats to an EXISTING persisted lease (multi-tedi
// collaboration join). Pure D1 mutation — does not provision or touch the
// workstation sandbox. A missing lease returns structured not-found evidence
// rather than throwing.
export async function joinWorkstation(c: Context<AppEnv>) {
	const body = await parseJsonBody(c);
	if (!body) return c.json({ ok: false, error: "Invalid JSON body" }, 400);
	const leaseId = typeof body.leaseId === "string" ? body.leaseId.trim() : "";
	if (!leaseId) {
		return c.json({ ok: false, error: "leaseId is required" }, 400);
	}
	const seats = parseJoinSeats(body.seats);
	if (seats.length === 0) {
		return c.json(
			{ ok: false, error: "seats must include at least one tediId" },
			400,
		);
	}
	if (!c.env.DB) {
		return c.json({
			ok: false,
			leaseId,
			workstationPersistence: { status: "skipped" },
			error: "workstation persistence is not configured (DB unbound)",
		});
	}
	try {
		const tediConfig = c.get("tediConfig");
		const joinContext: WorkstationJoinContext = {
			joinedBySlug: tediConfig.slug,
			joinedByTediId: tediConfig.id,
			kernelRunId: stringBodyValue(body, "kernelRunId"),
			traceBundleId: stringBodyValue(body, "traceBundleId"),
			traceId: traceIdFromRequest(c) ?? stringBodyValue(body, "traceId"),
			workItemId: stringBodyValue(body, "workItemId"),
		};
		const result = await joinWorkstationLease(
			createDbClient(c.env.DB),
			leaseId,
			seats,
			{
				expectedOrganizationId: tediConfig.organizationId,
				expectedProfileId: ACTIVE_WORKSTATION_PROFILE_ID,
				joinContext,
			},
		);
		if (!result.ok) {
			if (result.reason === "not_lease_lead") {
				return c.json(
					{
						ok: false,
						leaseId,
						reason: result.reason,
						error: "only the lead tedi may add workstation collaborators",
						leadTediId: result.leadTediId,
					},
					403,
				);
			}
			if (result.reason === "organization_mismatch") {
				return c.json(
					{
						ok: false,
						leaseId,
						reason: result.reason,
						error: `workstation lease ${leaseId} is not in this organization`,
						expectedOrganizationId: result.expectedOrganizationId,
						actualOrganizationId: result.actualOrganizationId,
					},
					403,
				);
			}
			if (result.reason === "profile_mismatch") {
				return c.json(
					{
						ok: false,
						leaseId,
						reason: result.reason,
						error: `workstation lease ${leaseId} is not a workstation`,
						expectedProfileId: result.expectedProfileId,
						actualProfileId: result.actualProfileId,
					},
					400,
				);
			}
			return c.json(
				{
					ok: false,
					leaseId,
					reason: result.reason,
					error: `workstation lease not found: ${leaseId}`,
				},
				404,
			);
		}
		return c.json({
			ok: true,
			leaseId,
			added: result.added,
			joinEvidence: {
				...joinContext,
				addedTediIds: result.added,
				leaseId,
			},
			workstation: result.bundle.workstation,
			workstationLease: result.bundle.workstationLease,
			workstationPersistence: { status: "persisted" },
		});
	} catch (error) {
		const message = errorMessage(error);
		console.warn("[workstation] join failed", message);
		return c.json(
			{
				ok: false,
				leaseId,
				error: message,
				workstationPersistence: { status: "failed", error: message },
			},
			500,
		);
	}
}

export async function releaseWorkstation(c: Context<AppEnv>) {
	const body = await parseJsonBody(c);
	if (!body) return c.json({ ok: false, error: "Invalid JSON body" }, 400);
	const leaseId = stringBodyValue(body, "leaseId");
	if (!leaseId) {
		return c.json({ ok: false, error: "leaseId is required" }, 400);
	}
	if (!c.env.DB) {
		return c.json(
			{
				error: "workstation persistence is not configured (DB unbound)",
				leaseId,
				ok: false,
				workstationPersistence: { status: "skipped" },
			},
			503,
		);
	}
	const tediConfig = c.get("tediConfig");
	const bundle = await getWorkstationLeaseBundle(
		createDbClient(c.env.DB),
		leaseId,
	);
	if (
		!bundle ||
		c.get("workstationRuntimeSelection")?.leaseId !== leaseId ||
		c.get("workstationRuntimeSelection")?.workstationId !==
			bundle.workstationLease.workstationId ||
		bundle.workstationLease.organizationId !== tediConfig.organizationId ||
		bundle.workstationLease.workItemId !==
			(c.get("workstationRuntimeSelection")?.workItemId ?? null) ||
		bundle.workstationLease.participants.find((p) => p.role === "lead")
			?.tediId !== tediConfig.id
	)
		return c.json(
			{ ok: false, error: "Computer release requires its owner", leaseId },
			403,
		);
	let destroyedSuccessfully = false;
	async function finishRelease(
		result: Extract<
			Awaited<ReturnType<typeof releaseWorkstationLease>>,
			{ ok: true }
		>,
	) {
		// A released ledger does not prove destruction completed. Retry cleanup
		// against this exact immutable lease body after an interrupted release.
		let nativeSnapshot:
			| Awaited<ReturnType<WorkstationRuntimeBody["snapshotForResume"]>>
			| { status: "failed"; error: string };
		try {
			nativeSnapshot = await c.get("sandbox").snapshotForResume();
		} catch (error) {
			nativeSnapshot = {
				status: "failed",
				error: scrubText(errorMessage(error)).slice(0, 700),
			};
		}

		let adapterCleanup: {
			error?: string;
			status: "destroyed" | "failed" | "timed_out";
		};
		try {
			const destroyed = await destroySandboxWithTimeout(c.get("sandbox"), {
				timeoutMs: 30_000,
			});
			destroyedSuccessfully = destroyed.completed && !destroyed.timedOut;
			adapterCleanup = {
				status: destroyedSuccessfully ? "destroyed" : "timed_out",
			};
			await c
				.get("runtimeBodyLauncher")
				?.terminateGeneration("workstation lease released");
		} catch (error) {
			adapterCleanup = { error: errorMessage(error), status: "failed" };
		}

		return c.json({
			adapterCleanup,
			nativeSnapshot,
			// The caller retries on `ok: false` and its retry destroys the container
			// again, so the reason has to travel with the refusal. Buried in
			// `adapterCleanup.error` it reached no log: a release that failed on
			// every attempt looked identical to one that had never been tried.
			...(adapterCleanup.status === "destroyed"
				? {}
				: {
						error: `workstation adapter cleanup ${adapterCleanup.status}${
							adapterCleanup.error
								? `: ${scrubText(adapterCleanup.error).slice(0, 700)}`
								: ""
						}`,
					}),
			alreadyReleased: result.alreadyReleased,
			leaseId,
			ok: adapterCleanup.status === "destroyed",
			workstation: result.bundle.workstation,
			workstationLease: result.bundle.workstationLease,
			workstationPersistence: { status: "persisted" },
		});
	}
	if (bundle.workstationLease.status === "released")
		return finishRelease({ ok: true, alreadyReleased: true, bundle });
	try {
		// The lease may have changed while this release waited for other writers.
		const current = await getWorkstationLeaseBundle(
			createDbClient(c.env.DB),
			leaseId,
		);
		if (
			!current ||
			current.workstationLease.organizationId !== tediConfig.organizationId ||
			current.workstationLease.workstationId !==
				bundle.workstationLease.workstationId ||
			current.workstationLease.workItemId !==
				bundle.workstationLease.workItemId ||
			current.workstationLease.participants.find((p) => p.role === "lead")
				?.tediId !== tediConfig.id
		)
			throw new Error("Release lease authority changed");
		const recordedRepo = current.workstationLease.metadata.repoSync;
		// A repository-mode request can be blocked before any checkout exists.
		// There is no repository to checkpoint in that exact state, and refusing
		// release would pin the task to an unusable Computer forever.
		const noConfiguredCheckout =
			recordedRepo &&
			typeof recordedRepo === "object" &&
			!Array.isArray(recordedRepo) &&
			recordedRepo.configured === false &&
			recordedRepo.status === "not_configured" &&
			!recordedRepo.workdir;
		const preserveRepositoryChanges =
			body.preserveChanges === true && !noConfiguredCheckout;
		if (
			preserveRepositoryChanges &&
			current.workstationLease.status !== "released"
		) {
			// Acquisition may still carry the shell root; only the current lease
			// identifies the repository this release must preserve.
			const cwd =
				recordedRepo &&
				typeof recordedRepo === "object" &&
				!Array.isArray(recordedRepo)
					? recordedRepo.workdir
					: null;
			if (
				typeof cwd !== "string" ||
				!isWorkstationPath(cwd) ||
				cwd.includes("\0") ||
				cwd.split("/").some((part) => part === "." || part === "..")
			)
				return c.json(
					{
						ok: false,
						error: "Computer release requires its recorded repository cwd",
						leaseId,
					},
					400,
				);
			const checkpoint = await recoveryCheckpointOperation(
				c,
				cwd,
				preparedPreflight(bundle.workstationLease.metadata) ?? undefined,
				(input) =>
					persistWorkstationRecoveryCheckpoint({
						...input,
						...workstationRecoveryCheckpointKeys(c),
						storage: c.env.TEDI_STORAGE ?? null,
						workdir: cwd,
						reason: "computer-release",
					}),
				leaseId,
				true,
			);
			if (checkpoint.status !== "clean" && checkpoint.status !== "persisted")
				return c.json({
					ok: false,
					leaseId,
					error: `Computer retained because repository preservation failed: ${scrubText(checkpoint.error ?? checkpoint.status).slice(0, 2000)}`,
					checkpoint,
				});
		}
		if (!preserveRepositoryChanges) {
			const closed = await checkpointNative(
				c.get("sandbox"),
				"/",
				() => assertCheckoutAuthority(c, true),
				{ closingLeaseId: leaseId },
			).exec("true");
			if (closed.exitCode !== 0)
				throw new Error("Failed to fence closing workstation");
		}
		await assertCheckoutAuthority(c, true);

		const result = await releaseWorkstationLease(
			createDbClient(c.env.DB),
			leaseId,
			{
				expectedOrganizationId: tediConfig.organizationId,
				releaseContext: {
					reason: stringBodyValue(body, "reason"),
					releasedBySlug: tediConfig.slug,
					releasedByTediId: tediConfig.id,
					traceId: traceIdFromRequest(c) ?? stringBodyValue(body, "traceId"),
				},
			},
		);
		if (!result.ok) {
			// A definite refusal is safe to reopen only with fresh unchanged authority.
			const reopened = await startCheckoutOperation(c.get("sandbox"), {
				command: `test "$(cat ${shellSingleQuote(CHECKOUT_CLOSING_MARKER)})" = ${shellSingleQuote(leaseId)} && rm -- ${shellSingleQuote(CHECKOUT_CLOSING_MARKER)}`,
				allowClosing: true,
				timeout: 40000,
				authorize: () => assertCheckoutAuthority(c, true),
			});
			const reopenResult = await reopened.process.output({
				encoding: "utf8",
				timeout: 55000,
			});
			if (reopenResult.exitCode !== 0)
				throw new Error("Failed to reopen retained workstation");

			if (result.reason === "not_lease_lead") {
				return c.json(
					{
						error: "only the lead tedi may release the workstation lease",
						leadTediId: result.leadTediId,
						leaseId,
						ok: false,
						reason: result.reason,
					},
					403,
				);
			}
			if (result.reason === "organization_mismatch") {
				return c.json(
					{
						error: `workstation lease ${leaseId} is not in this organization`,
						leaseId,
						ok: false,
						reason: result.reason,
					},
					403,
				);
			}
			return c.json(
				{
					error: `workstation lease not found: ${leaseId}`,
					leaseId,
					ok: false,
					reason: result.reason,
				},
				404,
			);
		}
		return await finishRelease(result);
	} catch (error) {
		return c.json({
			ok: false,
			leaseId,
			error: `Computer retained: ${scrubText(errorMessage(error))}`,
		});
	}
}
