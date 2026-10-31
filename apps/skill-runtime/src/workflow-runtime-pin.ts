import { recordArtifactOnceForRun } from "./artifact-immutability";
import { getSkillRunArtifactInlineContent } from "./db";
import { buildWorkflowLoaderConfigHash } from "./workflow-runtime-compatibility";

export interface WorkflowRuntimePin {
	executionEpoch: number;
	provenance: {
		source: {
			workflowSha256: string;
			skillDocSha256: string;
			skillRevision: number | null;
			skillSlug: string | null;
		};
		runtime: {
			workerVersionId: string;
			workerVersionTag: string;
			workerVersionTimestamp: string;
			executionCompatibilityHash: string;
			dispatchShimVersion: string;
			compatibilityDate: string;
			dynamicWorkflowsVersion: string;
			loaderConfigHash: string;
			tenantCpuMs: number;
			tenantSubRequests: number;
		};
	};
}

interface StoredRuntimePin {
	provenance?: {
		runtime?: {
			loaderConfigHash?: unknown;
			executionCompatibilityHash?: unknown;
			workerVersionId?: unknown;
			workerVersionTag?: unknown;
			workerVersionTimestamp?: unknown;
		};
	};
}

interface StoredRuntimeIdentity {
	loaderConfigHash: string;
	executionCompatibilityHash: string;
	deployment: {
		workerVersionId: string;
		workerVersionTag: string;
		workerVersionTimestamp: string;
	};
}

function runtimePinPath(executionEpoch: number): string {
	if (!Number.isInteger(executionEpoch) || executionEpoch < 0) {
		throw new Error("executionEpoch must be a non-negative integer");
	}
	return `epochs/${executionEpoch}/runtime-pin.json`;
}

async function readPinnedRuntimeIdentity(
	db: D1Database,
	runId: string,
	path: string,
): Promise<StoredRuntimeIdentity> {
	const content = await getSkillRunArtifactInlineContent(db, runId, path);
	if (!content) {
		throw new Error(
			`WORKFLOW_RUNTIME_PIN_UNREADABLE: run ${runId} has no inline runtime pin at ${path}`,
		);
	}
	try {
		const parsed = JSON.parse(content) as StoredRuntimePin;
		const loaderConfigHash = parsed.provenance?.runtime?.loaderConfigHash;
		const executionCompatibilityHash =
			parsed.provenance?.runtime?.executionCompatibilityHash;
		const workerVersionId = parsed.provenance?.runtime?.workerVersionId;
		const workerVersionTag = parsed.provenance?.runtime?.workerVersionTag;
		const workerVersionTimestamp =
			parsed.provenance?.runtime?.workerVersionTimestamp;
		if (
			typeof loaderConfigHash === "string" &&
			loaderConfigHash.length > 0 &&
			typeof executionCompatibilityHash === "string" &&
			executionCompatibilityHash.length > 0 &&
			typeof workerVersionId === "string" &&
			typeof workerVersionTag === "string" &&
			typeof workerVersionTimestamp === "string"
		) {
			return {
				loaderConfigHash,
				executionCompatibilityHash,
				deployment: {
					workerVersionId,
					workerVersionTag,
					workerVersionTimestamp,
				},
			};
		}
	} catch {
		// Fall through to the stable operator-facing error below.
	}
	throw new Error(
		`WORKFLOW_RUNTIME_PIN_UNREADABLE: run ${runId} has an invalid runtime pin at ${path}`,
	);
}

/**
 * Pin one immutable Loader/runtime identity to an execution epoch.
 *
 * Cloudflare may re-enter the static Workflow factory after a deployment when
 * a run wakes from sleep or waitForEvent. Continuing under that new Worker
 * would mix runtime code inside one epoch. The first factory entry therefore
 * seals a canonical pin; every later entry must present the same Loader config.
 * A native restart opens a new epoch and can deliberately adopt a new runtime.
 */
export async function assertWorkflowExecutionEpochRuntimePin(input: {
	db: D1Database;
	runId: string;
	pin: WorkflowRuntimePin;
	legacyCompatibility?: {
		executionCompatibilityHash: string;
		secretVersions: {
			serviceToken: string;
			outboundCredential: string | null;
		};
	};
}): Promise<void> {
	const path = runtimePinPath(input.pin.executionEpoch);
	await recordArtifactOnceForRun(input.db, input.runId, {
		path,
		value: input.pin,
	});
	const pinned = await readPinnedRuntimeIdentity(input.db, input.runId, path);
	const observedLoaderConfigHash =
		input.pin.provenance.runtime.loaderConfigHash;
	if (pinned.loaderConfigHash === observedLoaderConfigHash) return;

	const observedExecutionCompatibilityHash =
		input.pin.provenance.runtime.executionCompatibilityHash;
	let compatibilityPolicy: "compatible" | "legacy-compatible" | null =
		pinned.executionCompatibilityHash === observedExecutionCompatibilityHash
			? "compatible"
			: null;
	if (
		!compatibilityPolicy &&
		input.legacyCompatibility?.executionCompatibilityHash ===
			pinned.executionCompatibilityHash
	) {
		const reconstructedPinnedLoaderConfigHash =
			await buildWorkflowLoaderConfigHash({
				executionCompatibilityHash: pinned.executionCompatibilityHash,
				deployment: pinned.deployment,
				secretVersions: input.legacyCompatibility.secretVersions,
			});
		if (reconstructedPinnedLoaderConfigHash === pinned.loaderConfigHash) {
			compatibilityPolicy = "legacy-compatible";
		}
	}
	if (compatibilityPolicy) {
		await recordArtifactOnceForRun(input.db, input.runId, {
			path: `epochs/${input.pin.executionEpoch}/runtime-compatible/${observedLoaderConfigHash}.json`,
			value: {
				...input.pin,
				policy: compatibilityPolicy,
				pinnedLoaderConfigHash: pinned.loaderConfigHash,
				pinnedExecutionCompatibilityHash: pinned.executionCompatibilityHash,
			},
			outcome: "success",
		});
		return;
	}

	await recordArtifactOnceForRun(input.db, input.runId, {
		path: `epochs/${input.pin.executionEpoch}/runtime-drift/${observedLoaderConfigHash}.json`,
		value: {
			...input.pin,
			policy: "blocked",
			pinnedLoaderConfigHash: pinned.loaderConfigHash,
			pinnedExecutionCompatibilityHash: pinned.executionCompatibilityHash,
			observedExecutionCompatibilityHash,
		},
		outcome: "failure",
	});
	throw new Error(
		`WORKFLOW_RUNTIME_DRIFT_BLOCKED: execution epoch ${input.pin.executionEpoch} is pinned to execution surface ${pinned.executionCompatibilityHash} (Loader ${pinned.loaderConfigHash}), but ${observedExecutionCompatibilityHash} (Loader ${observedLoaderConfigHash}) attempted to resume it; restart the workflow to enter a new execution epoch`,
	);
}
