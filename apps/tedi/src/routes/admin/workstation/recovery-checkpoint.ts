import type { Context } from "hono";
import type { AppEnv } from "../../../types";
import {
	type RepoTreePreflight,
	type RepoSyncResult,
} from "../../../workstation/repo-sync";
import { type WorkstationLease } from "@tedix/api-contract/schemas/workstation";
import {
	type WorkstationRuntimeBody,
	type WorkstationExecResult,
	WorkstationDispatchUnknownError,
} from "../../../workstation/computer-body";
import {
	type LockedCheckpointNative,
	type RecoveryCheckpointProvenance,
	type WorkstationRecoveryCheckpointResult,
	restoreWorkstationRecoveryCheckpoint,
} from "../../../workstation/recovery-checkpoint";
import { startCheckoutOperation } from "../../../workstation/checkout-lock";
import { getWorkstationLeaseBundle } from "../../../workstation/persistence";
import { createDbClient } from "@tedix/db/client";
import { errorMessage } from "@tedix/worker-kit/error-message";
import {
	r2PrefixForTedi,
	shellSingleQuote,
	assertCheckoutAuthority,
	repoWorkdir,
	repoReady,
} from "./shared";
import { CHECKOUT_CLOSING_MARKER } from "./constants";

export function workstationRecoveryCheckpointKeys(c: Context<AppEnv>) {
	const selection = c.get("workstationRuntimeSelection");
	if (!selection?.workstationId)
		throw new Error("Computer recovery requires an exact computer identity");
	const prefix = `${r2PrefixForTedi(c)}/computers/${encodeURIComponent(selection.workItemId ?? selection.workstationId)}/recovery-checkpoints`;
	return {
		manifestKey: `${prefix}/active.json`,
		patchPrefix: `${prefix}/patches`,
	};
}

export function preparedPreflight(
	metadata: Record<string, unknown> | undefined,
): RepoTreePreflight | null {
	const repo = metadata?.repoSync;
	if (!repo || typeof repo !== "object") return null;
	const preflight = (repo as { treePreflight?: RepoTreePreflight })
		.treePreflight;
	return preflight?.startSha && /^[a-f0-9]{40}$/.test(preflight.startSha)
		? preflight
		: null;
}

export function immutableLeasePreflight(
	lease: WorkstationLease | undefined,
): RepoTreePreflight | null {
	if (!lease?.preparedStartSha || !lease.repositoryPath) return null;
	const observed = preparedPreflight(lease.metadata);
	if (!observed || !observed.workdir.endsWith(`/repos/${lease.repositoryPath}`))
		return null;
	const { authoritySource: _authoritySource, ...persisted } = observed;
	return { ...persisted, startSha: lease.preparedStartSha };
}

/** Uses the original persisted task base; a replacement's newer main is not
 * authority to change it. Missing local turn marker plus clean origin HEAD is
 * required before moving a fresh clone back to that base. */
export function restorePreparedBaseCommand(
	workdir: string,
	preflight: RepoTreePreflight,
): string {
	if (!preflight.startSha || !/^[a-f0-9]{40}$/.test(preflight.startSha))
		throw new Error("Invalid prepared base");
	return [
		"set -euo pipefail",
		`cd -- ${shellSingleQuote(workdir)}`,
		`test -z "$(git -c core.fsmonitor=false status --porcelain=v1 --untracked-files=all)" || { echo 'refusing replacement over dirty checkout' >&2; exit 1; }`,
		`test "$(git rev-parse HEAD)" = "$(git rev-parse ${shellSingleQuote(`refs/remotes/origin/${preflight.branch}`)})" || { echo 'refusing replacement over unrelated HEAD' >&2; exit 1; }`,
		`git cat-file -e ${shellSingleQuote(`${preflight.startSha}^{commit}`)} 2>/dev/null || git fetch --no-tags origin ${shellSingleQuote(preflight.startSha)}`,
		`git -c core.hooksPath=/dev/null checkout --detach --no-overwrite-ignore ${shellSingleQuote(preflight.startSha)}`,
		`git config tedix.preparedStartSha ${shellSingleQuote(preflight.startSha)}`,
	].join("\n");
}

export function checkpointNative(
	body: WorkstationRuntimeBody,
	workdir: string,
	authorize: () => Promise<void>,
	options: { closingLeaseId?: string; onProcess?: (id: string) => void } = {},
): LockedCheckpointNative {
	return {
		async exec(command, execOptions) {
			const timeout = (execOptions?.timeout ?? 10000) + 30000;
			const operation = await startCheckoutOperation(body, {
				command: options.closingLeaseId
					? `set -e\nprintf %s ${shellSingleQuote(`${options.closingLeaseId}\n`)} > ${shellSingleQuote(CHECKOUT_CLOSING_MARKER)}\n${command}`
					: command,
				cwd: workdir,
				timeout,
				allowClosing: !!options.closingLeaseId,
				authorize,
			});
			options.onProcess?.(operation.process.id);
			let result: WorkstationExecResult;
			try {
				result = await operation.process.output({
					encoding: "utf8",
					maxBytes: 16 * 1024 * 1024,
					timeout: timeout + 15000,
				});
			} catch {
				// Its native process retains the fence until the actual transaction ends.
				throw new WorkstationDispatchUnknownError(operation.id);
			}
			if (result.truncated || result.timedOut || result.signal !== undefined)
				throw new Error(
					"Checkpoint command output incomplete or execution timed out",
				);
			return result;
		},
		async writeFile(path, content) {
			if (
				!/^\/tmp\/tedix-restore-[a-f0-9-]+\.(patch|bundle)\.base64$/.test(path)
			)
				throw new Error("Checkpoint staging must use unique scratch inputs");
			await body.writeFile(path, content);
		},
	};
}

export function unpreparedCheckoutProbeCommand(workdir: string): string {
	const script = `const fs = require("node:fs"); const path = require("node:path");
let target = ${JSON.stringify(workdir)};
if (!path.isAbsolute(target) || target.split("/").some(part => part === "." || part === "..")) process.exit(1);
const imageRoot = "/home/tedi/workstation";
const canonicalRoot = "/workspace";
if (target === imageRoot || target.startsWith(imageRoot + "/")) {
 for (let parent = path.dirname(imageRoot); parent !== "/"; parent = path.dirname(parent)) {
  const entry = fs.lstatSync(parent);
  if (entry.isSymbolicLink() || !entry.isDirectory()) process.exit(1);
 }
 const alias = fs.lstatSync(imageRoot);
 const canonical = fs.lstatSync(canonicalRoot);
 if (!alias.isSymbolicLink() || fs.readlinkSync(imageRoot) !== canonicalRoot ||
     canonical.isSymbolicLink() || !canonical.isDirectory()) process.exit(1);
 target = canonicalRoot + target.slice(imageRoot.length);
}
let current = "/";
for (const part of target.split("/").filter(Boolean)) {
 current = path.join(current, part);
 let entry;
 try { entry = fs.lstatSync(current); } catch (error) {
  if (error.code === "ENOENT") { console.log("no-checkpoint-needed"); process.exit(0); }
  throw error;
 }
 if (entry.isSymbolicLink() || !entry.isDirectory()) process.exit(1);
}
const dir = fs.opendirSync(target);
try { if (dir.readSync() !== null) process.exitCode = 1;
 else console.log("no-checkpoint-needed"); } finally { dir.closeSync(); }`;
	return `bun -e ${shellSingleQuote(script)}`;
}

export async function recoveryCheckpointOperation(
	c: Context<AppEnv>,
	workdir: string,
	preflight: RepoTreePreflight | undefined,
	run: (input: {
		preparedStartSha: string;
		provenance: RecoveryCheckpointProvenance;
		withLockedCheckpoint: <T>(
			operation: (native: LockedCheckpointNative) => Promise<T>,
		) => Promise<T>;
	}) => Promise<WorkstationRecoveryCheckpointResult>,
	closingLeaseId?: string,
	allowUnpreparedEmpty = false,
): Promise<
	WorkstationRecoveryCheckpointResult & { reason?: "no-checkpoint-needed" }
> {
	const selection = c.get("workstationRuntimeSelection");
	if (!selection?.workstationId || !selection.leaseId)
		return {
			status: "failed",
			error: "Checkpoint requires exact lease authority",
		};
	const bundle = c.env.DB
		? await getWorkstationLeaseBundle(
				createDbClient(c.env.DB),
				selection.leaseId,
			)
		: null;
	if (c.env.DB && !bundle)
		return {
			status: "failed",
			error: "Checkpoint lease authority unavailable",
		};
	const assertAuthority = async () => {
		await assertCheckoutAuthority(c, !!closingLeaseId);
		if (!c.env.DB || !bundle) return;
		const current = await getWorkstationLeaseBundle(
			createDbClient(c.env.DB),
			selection.leaseId!,
		);
		if (
			!current ||
			current.workstationLease.status === "released" ||
			current.workstationLease.workstationId !== selection.workstationId ||
			current.workstationLease.workItemId !== (selection.workItemId ?? null)
		)
			throw new Error("Checkpoint lease authority changed");
	};
	const original =
		preparedPreflight(bundle?.workstationLease.metadata) ??
		preparedPreflight(bundle?.workstation.metadata) ??
		preflight;
	if (
		bundle &&
		(bundle.workstationLease.workstationId !== selection.workstationId ||
			bundle.workstationLease.workItemId !== (selection.workItemId ?? null))
	)
		return { status: "failed", error: "Checkpoint task authority changed" };
	try {
		const provenance: RecoveryCheckpointProvenance = {
			taskId: selection.workItemId ?? selection.workstationId,
			workstationId: selection.workstationId,
			leaseId: selection.leaseId,
			// Replaced by the actual capturing process before any manifest is published.
			containerPlacementId: "capture-pending",
		};
		const native = checkpointNative(
			c.get("sandbox"),
			original?.startSha ? workdir : "/",
			assertAuthority,
			{
				closingLeaseId,
				onProcess: (id) => {
					provenance.containerPlacementId = `native-process:${id}`;
				},
			},
		);
		if (!original?.startSha) {
			const recordedRepo = bundle?.workstationLease.metadata.repoSync;
			if (
				!allowUnpreparedEmpty ||
				!closingLeaseId ||
				!bundle ||
				!recordedRepo ||
				typeof recordedRepo !== "object" ||
				Array.isArray(recordedRepo) ||
				recordedRepo.workdir !== workdir
			)
				return {
					status: "failed",
					error: "Checkpoint requires original prepared task base",
				};
			const result = await native.exec(
				unpreparedCheckoutProbeCommand(workdir),
				{ timeout: 10000 },
			);
			if (
				result.exitCode !== 0 ||
				result.stdout.trim() !== "no-checkpoint-needed"
			)
				return {
					status: "failed",
					error:
						"Unprepared repository is not proven absent or empty; Computer retained",
				};
			return { status: "clean", reason: "no-checkpoint-needed" };
		}
		return await run({
			preparedStartSha: original.startSha,
			provenance,
			async withLockedCheckpoint(operation) {
				await assertAuthority();
				return operation(native);
			},
		});
	} catch (error) {
		return {
			status: "failed",
			error: errorMessage(error),
			...(error instanceof WorkstationDispatchUnknownError
				? { executionId: error.executionId, observation: "unknown" as const }
				: {}),
		};
	}
}

export async function restoreRecoveryCheckpoint(
	c: Context<AppEnv>,
	repoSync: RepoSyncResult,
): Promise<WorkstationRecoveryCheckpointResult> {
	const workdir = repoWorkdir(repoSync);
	if (!workdir || !repoReady(repoSync)) return { status: "missing" };
	const manifestKey = workstationRecoveryCheckpointKeys(c).manifestKey;
	if (!c.env.TEDI_STORAGE) return { status: "unavailable" };
	try {
		if (!(await c.env.TEDI_STORAGE.get(manifestKey)))
			return { status: "missing" };
	} catch (error) {
		return { status: "failed", error: errorMessage(error) };
	}
	return recoveryCheckpointOperation(
		c,
		workdir,
		repoSync.configured ? repoSync.treePreflight : undefined,
		(input) =>
			restoreWorkstationRecoveryCheckpoint({
				...input,
				manifestKey: workstationRecoveryCheckpointKeys(c).manifestKey,
				storage: c.env.TEDI_STORAGE ?? null,
				workdir,
			}),
	);
}
