import {
	cleanupWorkflowImages,
	type WorkflowImageDeletePage,
	type WorkflowImageBucket,
	type WorkflowImageRef,
} from "./workflow-image-handoff";

export const WORKFLOW_IMAGE_CLEANUP_PREFIX = "workflow-image-cleanup:";
const CURSOR_KEY = "workflow-image-cleanup-cursor";
const SCAN_LIMIT = 16;
type Storage = Pick<
	DurableObjectStorage,
	"get" | "put" | "delete" | "list" | "transaction" | "kv"
>;
type Intent = "terminal" | "cancelled";
interface Marker {
	hasImages: boolean;
	workflowInstanceId: string;
	refs?: WorkflowImageRef[];
}
export interface WorkflowImageCleanupInput {
	kind: "workflow_image_cleanup";
	tediId: string;
	orgId: string;
	runId: string;
	workflowInstanceId: string;
	sessionKey: string;
	refs: WorkflowImageRef[];
	intent: "uploaded_images";
}
export interface WorkflowImageCleanupAuthority {
	runId: string;
	generation: number;
	requestHash: string;
}
export interface WorkflowImageCleanupObligation extends WorkflowImageCleanupInput {
	authority: WorkflowImageCleanupAuthority;
	dispatchRequested: boolean;
	terminalIntent?: Intent;
	page?: WorkflowImageDeletePage & { stage: "issued" | "acknowledged" };
	completed?: boolean;
}
export type ImageCleanupResult = "cleaned" | "retained" | "failed" | "absent";

/** Compact obligations survive partial R2 writes and exhausted scheduler delivery. */
export class WorkflowImageCleanup {
	private readonly writers = new Map<string, Promise<unknown>>();
	constructor(
		private readonly deps: {
			storage: Storage;
			owner(): { tediId: string; orgId: string };
			admitCleanup(
				input: WorkflowImageCleanupInput,
			): Promise<WorkflowImageCleanupAuthority>;
			assertCleanupOriginal(
				authority: WorkflowImageCleanupAuthority,
				input: WorkflowImageCleanupInput,
			): Promise<void>;
			assertCleanupActive(
				authority: WorkflowImageCleanupAuthority,
				input: WorkflowImageCleanupInput,
			): Promise<() => void>;
			completeCleanup(
				authority: WorkflowImageCleanupAuthority,
				input: WorkflowImageCleanupInput,
				receipt: WorkflowImageDeletePage,
			): Promise<void>;
			bucket(): WorkflowImageBucket | undefined;
			nativeStatus(workflowInstanceId: string): Promise<string>;
			canceled(runId: string): Promise<boolean>;
			scheduleRetry?(input: {
				runId: string;
				workflowInstanceId: string;
				intent: Intent;
				attempt: number;
			}): Promise<unknown>;
		},
	) {}

	/** Caller dispatch and cleanup share one owner-run queue, including awaited R2 work. */
	async withRun<T>(runId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.writers.get(runId) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(operation);
		this.writers.set(runId, next);
		try {
			return await next;
		} finally {
			if (this.writers.get(runId) === next) this.writers.delete(runId);
		}
	}

	/** Immutable independent cleanup authority is persisted before the first upload. */
	async claim(
		runId: string,
		workflowInstanceId: string,
		refs: WorkflowImageRef[],
		sessionKey: string,
	): Promise<void> {
		const { tediId, orgId } = this.deps.owner();
		this.validateRefs(tediId, runId, refs);
		if (!orgId || !sessionKey || !workflowInstanceId)
			throw new Error("workflow_image_owner_invalid");
		const input: WorkflowImageCleanupInput = {
			kind: "workflow_image_cleanup",
			tediId,
			orgId,
			runId,
			workflowInstanceId,
			sessionKey,
			refs,
			intent: "uploaded_images",
		};
		const key = `${WORKFLOW_IMAGE_CLEANUP_PREFIX}${runId}`;
		const existing =
			await this.deps.storage.get<WorkflowImageCleanupObligation>(key);
		const marker = await this.deps.storage.get<Marker>(`wfimages:${runId}`);
		if (
			marker &&
			(marker.workflowInstanceId !== workflowInstanceId ||
				marker.hasImages !== refs.length > 0 ||
				JSON.stringify(marker.refs) !== JSON.stringify(refs))
		)
			throw new Error("workflow_image_conflict");
		if (existing) {
			if (JSON.stringify(this.input(existing)) !== JSON.stringify(input))
				throw new Error("workflow_image_conflict");
			await this.original(existing);
			if (existing.page || existing.completed)
				throw new Error("workflow_image_cleanup_already_started");
			await this.active(existing);
			return;
		}
		// A historical marker cannot be upgraded by a retry or late callback.
		if (marker && refs.length)
			throw new Error("workflow_image_authority_missing");
		if (!refs.length) {
			await this.deps.storage.put(`wfimages:${runId}`, {
				hasImages: false,
				workflowInstanceId,
				refs,
			});
			return;
		}
		const authority = await this.deps.admitCleanup(input);
		this.validateAuthority(authority);
		if (authority.runId === runId)
			throw new Error("workflow_image_authority_invalid");
		await this.deps.assertCleanupOriginal(authority, input);
		await this.deps.assertCleanupActive(authority, input);
		await this.deps.storage.transaction(async (storage) => {
			if (await storage.get(key)) throw new Error("workflow_image_conflict");
			await storage.put(key, { ...input, authority, dispatchRequested: false });
			await storage.put(`wfimages:${runId}`, {
				hasImages: true,
				workflowInstanceId,
				refs,
			});
		});
	}

	/** Upload guard reads the persisted original obligation after every await. */
	async assertUploadReady(runId: string): Promise<() => void> {
		const row = await this.deps.storage.get<WorkflowImageCleanupObligation>(
			`${WORKFLOW_IMAGE_CLEANUP_PREFIX}${runId}`,
		);
		if (!row) throw new Error("workflow_image_authority_missing");
		await this.original(row);
		if (row.page || row.completed)
			throw new Error("workflow_image_cleanup_already_started");
		return this.active(row);
	}

	private input(
		row: WorkflowImageCleanupObligation,
	): WorkflowImageCleanupInput {
		return {
			kind: row.kind,
			tediId: row.tediId,
			orgId: row.orgId,
			runId: row.runId,
			workflowInstanceId: row.workflowInstanceId,
			sessionKey: row.sessionKey,
			refs: row.refs,
			intent: row.intent,
		};
	}
	private validateAuthority(value: WorkflowImageCleanupAuthority): void {
		if (
			!value ||
			!value.runId ||
			!Number.isSafeInteger(value.generation) ||
			value.generation < 1 ||
			!/^[a-f0-9]{64}$/.test(value.requestHash)
		)
			throw new Error("workflow_image_authority_missing");
	}
	private async original(row: WorkflowImageCleanupObligation): Promise<void> {
		this.validateAuthority(row.authority);
		const owner = this.deps.owner();
		if (
			row.kind !== "workflow_image_cleanup" ||
			row.intent !== "uploaded_images" ||
			row.tediId !== owner.tediId ||
			row.orgId !== owner.orgId ||
			!row.sessionKey ||
			!row.workflowInstanceId
		)
			throw new Error("workflow_image_owner_invalid");
		this.validateRefs(row.tediId, row.runId, row.refs);
		await this.deps.assertCleanupOriginal(row.authority, this.input(row));
	}
	private async active(
		row: WorkflowImageCleanupObligation,
	): Promise<() => void> {
		const expected = JSON.stringify(row);
		const assertAccepted = await this.deps.assertCleanupActive(
			row.authority,
			this.input(row),
		);
		return () => {
			if (
				typeof assertAccepted !== "function" ||
				assertAccepted() !== undefined
			)
				throw new Error("workflow_image_sync_guard_invalid");
			if (
				JSON.stringify(
					this.deps.storage.kv.get(
						`${WORKFLOW_IMAGE_CLEANUP_PREFIX}${row.runId}`,
					),
				) !== expected
			)
				throw new Error("workflow_image_journal_changed");
		};
	}

	/** Must commit before the SDK create call, including ambiguous provider failures. */
	async beforeDispatch(
		runId: string,
		workflowInstanceId: string,
	): Promise<void> {
		await this.deps.storage.transaction(async (storage) => {
			const key = `${WORKFLOW_IMAGE_CLEANUP_PREFIX}${runId}`;
			const row = await storage.get<WorkflowImageCleanupObligation>(key);
			if (!row) {
				const marker = await storage.get<Marker>(`wfimages:${runId}`);
				if (marker?.hasImages)
					throw new Error("workflow_image_obligation_missing");
				return;
			}
			await this.original(row);
			await this.active(row);
			if (row.workflowInstanceId !== workflowInstanceId)
				throw new Error("workflow_image_conflict");
			await storage.put(key, { ...row, dispatchRequested: true });
		});
	}

	/** Terminal callbacks upgrade the existing obligation; cleanup never blocks settlement. */
	async terminal(input: {
		runId: string;
		workflowInstanceId: string;
		intent: Intent;
		attempt?: number;
	}): Promise<ImageCleanupResult> {
		try {
			const authorized = await this.deps.storage.transaction(
				async (storage) => {
					const marker = await storage.get<Marker>(`wfimages:${input.runId}`);
					if (
						marker?.hasImages !== true ||
						marker.workflowInstanceId !== input.workflowInstanceId
					)
						return false;
					const key = `${WORKFLOW_IMAGE_CLEANUP_PREFIX}${input.runId}`;
					const row = await storage.get<WorkflowImageCleanupObligation>(key);
					if (!row) throw new Error("workflow_image_authority_missing");
					await this.original(row);
					if (row.workflowInstanceId !== input.workflowInstanceId)
						throw new Error("workflow_image_conflict");
					await storage.put(key, { ...row, terminalIntent: input.intent });
					return true;
				},
			);
			if (!authorized) return "absent";
			const result = await this.attempt(input.runId);
			if (
				(result === "retained" || result === "failed") &&
				(input.attempt ?? 0) < 10 &&
				this.deps.scheduleRetry
			) {
				try {
					const row =
						await this.deps.storage.get<WorkflowImageCleanupObligation>(
							`${WORKFLOW_IMAGE_CLEANUP_PREFIX}${input.runId}`,
						);
					if (!row || row.page?.stage === "issued" || row.completed)
						return result;
					await this.active(row);
					await this.deps.scheduleRetry({
						...input,
						attempt: (input.attempt ?? 0) + 1,
					});
				} catch (error) {
					this.failure(input.runId, error);
				}
			}
			return result;
		} catch (error) {
			this.failure(input.runId, error);
			return "failed";
		}
	}

	/** Active original writers and retained native/Computer contexts fence every deletion. */
	async attempt(runId: string): Promise<ImageCleanupResult> {
		if (this.writers.has(runId)) return "retained";
		return this.withRun(runId, async () => {
			try {
				const key = `${WORKFLOW_IMAGE_CLEANUP_PREFIX}${runId}`;
				const loaded =
					await this.deps.storage.get<WorkflowImageCleanupObligation>(key);
				if (!loaded) return "absent";
				let row: WorkflowImageCleanupObligation = loaded;
				await this.original(row);
				if (row.page?.stage === "issued")
					throw new Error("workflow_image_delete_ack_unknown");
				if (row.page?.stage === "acknowledged" && !row.page.truncated) {
					await this.deps.completeCleanup(row.authority, this.input(row), {
						keys: row.page.keys,
						cursor: row.page.cursor,
						nextCursor: row.page.nextCursor,
						truncated: row.page.truncated,
					});
					if (!row.completed)
						await this.deps.storage.put(key, { ...row, completed: true });
					return "cleaned";
				}
				await this.active(row);
				const marker = await this.deps.storage.get<Marker>(`wfimages:${runId}`);
				if (
					row.tediId !== this.deps.owner().tediId ||
					row.runId !== runId ||
					typeof row.dispatchRequested !== "boolean" ||
					(marker?.refs !== undefined &&
						JSON.stringify(marker.refs) !== JSON.stringify(row.refs)) ||
					marker?.hasImages !== true ||
					marker.workflowInstanceId !== row.workflowInstanceId
				)
					throw new Error("workflow_image_owner_invalid");
				this.validateRefs(row.tediId, row.runId, row.refs ?? []);
				if (await this.deps.storage.get(`wfctx:${row.workflowInstanceId}`))
					return "retained";
				let status: string;
				try {
					status = await this.deps.nativeStatus(row.workflowInstanceId);
				} catch (error) {
					if (
						!(error instanceof Error) ||
						!error.message.includes("(instance.not_found)")
					)
						throw error;
					status = "not_found";
				}
				const missingBeforeDispatch =
					status === "not_found" && !row.dispatchRequested;
				const missingCanceled =
					status === "not_found" &&
					row.terminalIntent === "cancelled" &&
					(await this.deps.canceled(runId));
				if (
					!["complete", "errored", "terminated"].includes(status) &&
					!missingBeforeDispatch &&
					!missingCanceled
				)
					return "retained";
				const bucket = this.deps.bucket();
				if (!bucket) throw new Error("workflow_image_bucket_missing");
				await cleanupWorkflowImages(bucket, row.tediId, runId, {
					cursor: row.page?.nextCursor ?? null,
					allowedKeys: [
						...row.refs.map((ref) => ref.key),
						`__runtime/workflow-images/${encodeURIComponent(row.tediId)}/${encodeURIComponent(row.runId)}/manifest.json`,
					],
					assertReady: () => this.active(row),
					issued: async (page) => {
						row = { ...row, page: { ...page, stage: "issued" } };
						await this.deps.storage.put(key, row);
					},
					acknowledged: async (page) => {
						row = { ...row, page: { ...page, stage: "acknowledged" } };
						await this.deps.storage.put(key, row);
						if (!page.truncated) {
							await this.deps.completeCleanup(
								row.authority,
								this.input(row),
								page,
							);
							row = { ...row, completed: true };
							await this.deps.storage.put(key, row);
						}
					},
				});
				return "cleaned";
			} catch (error) {
				this.failure(runId, error);
				return "failed";
			}
		});
	}

	/** One bounded rotating pass on an existing canonical maintenance wake; no new timer. */
	async redrive(): Promise<{
		examined: number;
		cleaned: number;
		failed: number;
	}> {
		const report = { examined: 0, cleaned: 0, failed: 0 };
		try {
			let cursor = await this.deps.storage.get<string>(CURSOR_KEY);
			let rows = await this.deps.storage.list<WorkflowImageCleanupObligation>({
				prefix: WORKFLOW_IMAGE_CLEANUP_PREFIX,
				limit: SCAN_LIMIT,
				...(cursor ? { startAfter: cursor } : {}),
			});
			if (!rows.size && cursor) {
				cursor = undefined;
				rows = await this.deps.storage.list({
					prefix: WORKFLOW_IMAGE_CLEANUP_PREFIX,
					limit: SCAN_LIMIT,
				});
			}
			for (const [key, row] of rows) {
				report.examined++;
				const result =
					key === `${WORKFLOW_IMAGE_CLEANUP_PREFIX}${row?.runId}`
						? await this.attempt(row.runId)
						: "failed";
				if (result === "cleaned") report.cleaned++;
				if (result === "failed") report.failed++;
				cursor = key;
			}
			if (rows.size === SCAN_LIMIT && cursor)
				await this.deps.storage.put(CURSOR_KEY, cursor);
			else await this.deps.storage.delete(CURSOR_KEY);
		} catch (error) {
			this.failure("maintenance", error);
			report.failed++;
		}
		return report;
	}

	private validateRefs(
		tediId: string,
		runId: string,
		refs: WorkflowImageRef[],
	): void {
		if (!tediId || !runId || !Array.isArray(refs) || refs.length > 4)
			throw new Error("workflow_image_owner_invalid");
		const prefix = `__runtime/workflow-images/${encodeURIComponent(tediId)}/${encodeURIComponent(runId)}/`;
		for (const ref of refs)
			if (
				!ref ||
				!/^[a-f0-9]{64}$/.test(ref.sha256) ||
				ref.key !== `${prefix}${ref.sha256}.json` ||
				typeof ref.mediaType !== "string" ||
				typeof ref.fileName !== "string" ||
				ref.fileName.length > 512
			)
				throw new Error("workflow_image_owner_invalid");
	}
	private failure(runId: string, error: unknown): void {
		console.error({
			event: "tedi.runtime.workflow_image_cleanup_failed",
			runId,
			error: error instanceof Error ? error.message : "image cleanup failed",
		});
	}
}
