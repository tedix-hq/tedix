import {
	DirectoryBackup,
	type DirectoryBackupGatewayBinding,
	type DirectoryBackupRecord,
} from "@cloudflare/sandbox";
import { NativeContainerSandbox } from "@tedix/container-runtime/sandbox";
import { WorkerEntrypoint } from "cloudflare:workers";
export { DirectoryBackupGateway } from "@cloudflare/sandbox";
import { outboundEgressHandler } from "./egress";
import { WORKSTATION_RUNTIME_EVENT_SHAPE_VERSION } from "./event-shape";
import { exceptionTopology } from "./exception-topology";
import { workstationHealth } from "./health";
import {
	inspectRepositoryNative,
	type RepositoryInspectionRequest,
} from "./repository-inspection";
import {
	NATIVE_SNAPSHOT_MAX_AGE_MS,
	snapshotFenceFromOutboundParams,
	snapshotMatches,
	snapshotMismatchReason,
	type WorkstationResumeSnapshot,
	type WorkstationSnapshotFence,
} from "./snapshot-resume";
import { emitSnapshotMetric } from "./snapshot-observability";

const RESUME_SNAPSHOT_KEY = "native-resume-snapshot";
const SNAPSHOT_ALARM_DELAY_MS = 9 * 60 * 1000;

export interface TediRuntimeEnv {
	API_SERVICE?: Fetcher;
	BACKUP_BUCKET: R2Bucket;
	CF_ACCOUNT_ID?: string;
	CLOUDFLARE_API_TOKEN?: string;
	CLOUDFLARE_ZONE_ID?: string;
	ENVIRONMENT?: string;
	GIT_SHA?: string;
	RUNTIME_ANALYTICS?: AnalyticsEngineDataset;
	WORKSTATION_EGRESS_PROXY?: Fetcher;
}
interface LaunchRequest {
	executionId: string;
	argv: readonly [string, ...string[]];
	cwd?: string;
	env?: Record<string, string>;
	timeout?: number;
	metadata?: {
		command: string;
		cwd: string;
		context: Record<string, unknown>;
		timeoutMs: number | null;
	};
}
type Association = { metadata?: LaunchRequest["metadata"] } & (
	| { fingerprint: string; state: "dispatching" }
	| { fingerprint: string; state: "started"; nativeId: string }
	| {
			fingerprint: string;
			state: "terminal";
			nativeId: string;
			exitCode: number | null;
			startedAt?: string;
			endedAt?: string;
			timedOut?: boolean;
			signal?: number;
			error?: string;
	  }
);

interface WorkstationOutboundProps {
	className: string;
	containerId: string;
	params?: unknown;
}

interface TediWorkstationState extends DurableObjectState {
	readonly exports: Cloudflare.Exports & {
		readonly WorkstationOutbound: (options: {
			props: WorkstationOutboundProps;
		}) => Fetcher;
		readonly DirectoryBackupGateway: DirectoryBackupGatewayBinding;
	};
}

export class WorkstationOutbound extends WorkerEntrypoint<
	TediRuntimeEnv,
	WorkstationOutboundProps
> {
	override fetch(request: Request): Promise<Response> {
		return outboundEgressHandler(request, this.env, this.ctx.props);
	}
}

export class TediWorkstationRuntimeSandbox extends NativeContainerSandbox<TediRuntimeEnv> {
	readonly #exports: TediWorkstationState["exports"];
	readonly #backups: DirectoryBackup;
	#outboundParams: unknown;
	#snapshotFence: WorkstationSnapshotFence | null | undefined;

	constructor(ctx: TediWorkstationState, env: TediRuntimeEnv) {
		super(ctx, env);
		this.#exports = ctx.exports;
		this.#backups = new DirectoryBackup(
			this.container,
			ctx.exports.DirectoryBackupGateway,
			{ binding: "BACKUP_BUCKET", prefix: "directory-backups/" },
		);
	}

	protected get containerTelemetrySurface(): string {
		return "workstation";
	}

	protected startOptions(): ContainerStartupOptions {
		return {
			image: this.container.images.workstation,
			instance: "standard-1",
			enableInternet: false,
			labels: {
				platform: "tedix",
				env: this.env.ENVIRONMENT ?? "production",
				workstation: this.ctx.id.name ?? this.ctx.id.toString(),
			},
		};
	}

	async #currentSnapshotFence(): Promise<WorkstationSnapshotFence | null> {
		if (this.#snapshotFence !== undefined) return this.#snapshotFence;
		this.#outboundParams ??= await this.ctx.storage.get("outbound-params");
		this.#snapshotFence = snapshotFenceFromOutboundParams(this.#outboundParams);
		return this.#snapshotFence;
	}

	protected override async startContainer(): Promise<void> {
		const options = this.startOptions();
		const image = options.image;
		if (!image) throw new Error("Workstation container image is unavailable");
		const fence = await this.#currentSnapshotFence();
		const saved =
			await this.ctx.storage.get<WorkstationResumeSnapshot>(
				RESUME_SNAPSHOT_KEY,
			);
		const createdAtMs = saved ? Date.parse(saved.createdAt) : Number.NaN;
		const ageMs = Number.isFinite(createdAtMs)
			? Math.max(0, Date.now() - createdAtMs)
			: 0;
		let fallbackReason:
			| "expired"
			| "image_mismatch"
			| "fence_mismatch"
			| "missing_fence"
			| "provider_rejected"
			| null = null;
		if (saved && fence && snapshotMatches(saved, { fence, image })) {
			const startedAt = Date.now();
			try {
				const { image: _image, ...restoreOptions } = options;
				this.container.start({
					...restoreOptions,
					containerSnapshot: { id: saved.snapshot.id },
				});
				if (!(await this.container.inspect()))
					throw new Error("Snapshot restore did not start a container");
				await this.ctx.storage.delete(RESUME_SNAPSHOT_KEY);
				emitSnapshotMetric(this.env.RUNTIME_ANALYTICS, {
					operation: "restore",
					outcome: "success",
					reason: "none",
					durationMs: Date.now() - startedAt,
					ageMs,
					retainedReference: 0,
				});
				return;
			} catch {
				fallbackReason = "provider_rejected";
				if (this.container.running)
					await this.container.destroy("native snapshot restore rejected");
				await this.ctx.storage.delete(RESUME_SNAPSHOT_KEY);
				emitSnapshotMetric(this.env.RUNTIME_ANALYTICS, {
					operation: "restore",
					outcome: "failure",
					reason: "provider_rejected",
					durationMs: Date.now() - startedAt,
					ageMs,
					retainedReference: 0,
				});
			}
		} else if (saved) {
			fallbackReason =
				snapshotMismatchReason(saved, { fence, image }) ?? "fence_mismatch";
			await this.ctx.storage.delete(RESUME_SNAPSHOT_KEY);
			emitSnapshotMetric(this.env.RUNTIME_ANALYTICS, {
				operation: "discard",
				outcome: "success",
				reason: fallbackReason,
				ageMs,
				retainedReference: 0,
			});
		}
		if (fallbackReason)
			emitSnapshotMetric(this.env.RUNTIME_ANALYTICS, {
				operation: "fallback",
				outcome: "success",
				reason: fallbackReason,
				ageMs,
				retainedReference: 0,
			});
		await super.startContainer();
	}

	protected override async afterContainerAccess(): Promise<void> {
		await this.ctx.storage.setAlarm(Date.now() + SNAPSHOT_ALARM_DELAY_MS);
	}

	async alarm(): Promise<void> {
		const result = await this.snapshotForResume();
		if (result.status === "saved" && this.container.running)
			await this.container.destroy("native snapshot saved for idle resume");
	}

	protected override async configureContainer(): Promise<void> {
		this.#outboundParams ??= await this.ctx.storage.get("outbound-params");
		await this.#backups.intercept();
		const outbound = this.#exports.WorkstationOutbound({
			props: {
				className: "TediWorkstationRuntimeSandbox",
				containerId: this.ctx.id.toString(),
				params: this.#outboundParams,
			},
		});
		await this.container.interceptAllOutboundHttp(outbound);
		await this.container.interceptOutboundHttps("*", outbound);
	}

	async setOutboundPolicy(params: unknown): Promise<void> {
		this.#outboundParams = params;
		this.#snapshotFence = snapshotFenceFromOutboundParams(params);
		await this.ctx.storage.put("outbound-params", params);
		if (this.container.running) {
			await this.configureContainer();
			await this.afterContainerAccess();
		}
	}

	async snapshotForResume(): Promise<
		| { status: "saved"; snapshotId: string; expiresAt: string }
		| { status: "not_running" | "missing_fence" }
	> {
		if (!this.container.running) {
			emitSnapshotMetric(this.env.RUNTIME_ANALYTICS, {
				operation: "create",
				outcome: "skipped",
				reason: "not_running",
				retainedReference: 0,
			});
			return { status: "not_running" };
		}
		const fence = await this.#currentSnapshotFence();
		if (!fence) {
			emitSnapshotMetric(this.env.RUNTIME_ANALYTICS, {
				operation: "create",
				outcome: "skipped",
				reason: "missing_fence",
				retainedReference: 0,
			});
			return { status: "missing_fence" };
		}
		const image = this.container.images.workstation;
		if (!image) throw new Error("Workstation container image is unavailable");
		const existing =
			await this.ctx.storage.get<WorkstationResumeSnapshot>(
				RESUME_SNAPSHOT_KEY,
			);
		if (existing && snapshotMatches(existing, { fence, image }))
			return {
				status: "saved",
				snapshotId: existing.snapshot.id,
				expiresAt: existing.expiresAt,
			};
		const startedAt = Date.now();
		const sync = await (await this.container.exec(["sync"])).output();
		if (sync.exitCode !== 0) {
			emitSnapshotMetric(this.env.RUNTIME_ANALYTICS, {
				operation: "create",
				outcome: "failure",
				reason: "sync_failed",
				durationMs: Date.now() - startedAt,
				retainedReference: 0,
			});
			throw new Error("Container filesystem sync failed before snapshot");
		}
		const createdAt = new Date();
		let snapshot: ContainerSnapshot;
		try {
			snapshot = await this.container.snapshotContainer({
				name: `tedix-${fence.workstationId.slice(0, 32)}-${createdAt.getTime()}`,
			});
		} catch (error) {
			emitSnapshotMetric(this.env.RUNTIME_ANALYTICS, {
				operation: "create",
				outcome: "failure",
				reason: "provider_rejected",
				durationMs: Date.now() - startedAt,
				retainedReference: 0,
			});
			throw error;
		}
		const expiresAt = new Date(
			createdAt.getTime() + NATIVE_SNAPSHOT_MAX_AGE_MS,
		).toISOString();
		await this.ctx.storage.put(RESUME_SNAPSHOT_KEY, {
			createdAt: createdAt.toISOString(),
			expiresAt,
			fence,
			image,
			snapshot,
		} satisfies WorkstationResumeSnapshot);
		emitSnapshotMetric(this.env.RUNTIME_ANALYTICS, {
			operation: "create",
			outcome: "success",
			reason: "none",
			durationMs: Date.now() - startedAt,
			retainedReference: 1,
		});
		return { status: "saved", snapshotId: snapshot.id, expiresAt };
	}

	async inspectRepository(request: RepositoryInspectionRequest) {
		return inspectRepositoryNative(async (argv, options) => {
			const started = await this.exec(argv, options);
			const process = await this.getProcess(started.id);
			if (!process)
				throw new Error("Repository inspection process disappeared");
			return process;
		}, request);
	}

	async launchExecution(request: LaunchRequest) {
		if (!request.executionId) throw new Error("Execution identity is required");
		const canonical = JSON.stringify([
			request.argv,
			request.cwd ?? null,
			Object.entries(request.env ?? {}).sort(([a], [b]) => a.localeCompare(b)),
			request.timeout ?? null,
			request.metadata ?? null,
		]);
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(canonical),
		);
		const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		const key = `execution:${request.executionId}`;
		const claimed = await this.ctx.storage.transaction(async (storage) => {
			const existing = await storage.get<Association>(key);
			if (existing) {
				if (existing.fingerprint !== fingerprint)
					throw new Error(
						"Execution identity was reused with different launch arguments",
					);
				return false;
			}
			await storage.put(key, {
				state: "dispatching",
				fingerprint,
				metadata: request.metadata,
			} satisfies Association);
			return true;
		});
		if (!claimed)
			return (await this.readExecutionAssociation(request.executionId))!;
		// No native launch occurs within the storage transaction. A lost response
		// leaves the durable dispatching record and can never trigger a repeat.
		try {
			const process = await this.startProcess(
				request.executionId,
				request.argv,
				{
					cwd: request.cwd,
					env: request.env,
					timeout: request.timeout,
				},
			);
			await this.ctx.storage.put(key, {
				state: "started",
				fingerprint,
				nativeId: process.id,
				metadata: request.metadata,
			} satisfies Association);
			return {
				state: "started" as const,
				executionId: request.executionId,
				nativeId: process.id,
				metadata: request.metadata,
			};
		} catch (error) {
			console.error({
				component: "tedi.workstation.runtime",
				event: "native_launch_unconfirmed",
				message:
					"workstation native launch outcome could not be durably confirmed",
				exception: exceptionTopology(error),
			});
			return {
				state: "unknown" as const,
				executionId: request.executionId,
				observation: "unavailable" as const,
				metadata: request.metadata,
			};
		}
	}

	async readExecutionAssociation(executionId: string) {
		let record = await this.ctx.storage.get<Association>(
			`execution:${executionId}`,
		);
		if (!record) return null;
		if (record.state === "started") {
			const startedRecord = record;
			try {
				const process = await this.getProcess(startedRecord.nativeId);
				const status = process ? await process.status() : null;
				if (status && (status.state === "exited" || status.state === "error")) {
					const terminal: Association = {
						...startedRecord,
						state: "terminal",
						exitCode: status.state === "exited" ? status.exit.code : null,
						startedAt: status.startedAt,
						endedAt: status.endedAt,
						...(status.state === "exited"
							? {
									timedOut: status.exit.timedOut,
									signal: status.exit.signal,
								}
							: { error: status.error.message }),
					};
					record = await this.ctx.storage.transaction(async (storage) => {
						const current = await storage.get<Association>(
							`execution:${executionId}`,
						);
						if (
							current?.state === "started" &&
							current.fingerprint === startedRecord.fingerprint &&
							current.nativeId === startedRecord.nativeId
						) {
							await storage.put(`execution:${executionId}`, terminal);
							return terminal;
						}
						return current ?? startedRecord;
					});
				}
			} catch {
				// Native observation is not authority to mutate or replay the launch.
			}
		}
		if (record.state === "terminal") {
			return {
				state: "terminal" as const,
				executionId,
				nativeId: record.nativeId,
				exitCode: record.exitCode,
				startedAt: record.startedAt,
				endedAt: record.endedAt,
				timedOut: record.timedOut,
				signal: record.signal,
				error: record.error,
				metadata: record.metadata,
			};
		}
		return record.state === "started"
			? {
					state: "started" as const,
					executionId,
					nativeId: record.nativeId,
					metadata: record.metadata,
				}
			: {
					state: "unknown" as const,
					executionId,
					observation: "unavailable" as const,
					metadata: record.metadata,
				};
	}

	getWorkstationIdentity() {
		return this.ctx.id.toString();
	}
	async createBackup(input: {
		dir: string;
		name?: string;
		excludes?: string[];
	}): Promise<DirectoryBackupRecord> {
		await this.ensureContainer();
		return this.#backups.backup({
			dir: input.dir,
			name: input.name,
			exclude: input.excludes,
		});
	}

	async restoreBackup(input: DirectoryBackupRecord & { dir?: string }) {
		await this.ensureContainer();
		await this.#backups.restore(input, { dir: input.dir });
		return { success: true as const };
	}
}

export default {
	fetch(request: Request, env: TediRuntimeEnv): Response {
		const url = new URL(request.url);
		// authz: public — liveness + deployed-sha probe; serves no tenant data.
		if (url.pathname === "/health") {
			return Response.json(
				workstationHealth(env, WORKSTATION_RUNTIME_EVENT_SHAPE_VERSION),
			);
		}

		return Response.json({
			backupBucketConfigured: Boolean(env.BACKUP_BUCKET),
			eventShapeVersion: WORKSTATION_RUNTIME_EVENT_SHAPE_VERSION,
			status: "ok",
			service: "tedi-workstation-runtime",
		});
	},
};
