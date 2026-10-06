import {
	authoringWorkspaceState,
	prepareAuthoringWorkspace,
	type AuthoringWorkspaceInput,
} from "../agent/authoring-workspace";
import {
	DirectoryBackup,
	type DirectoryBackupGatewayBinding,
	type DirectoryBackupRecord,
} from "@cloudflare/sandbox";
import {
	NativeContainerSandbox,
	type SandboxCommand,
	type SandboxExecOptions,
} from "@tedix/container-runtime/sandbox";

interface SiteBuilderEnv {
	ENVIRONMENT?: string;
	DB: D1Database;
	SITE_BUILDER_STORAGE: R2Bucket;
}

interface SiteBuilderState extends DurableObjectState {
	readonly exports: Cloudflare.Exports & {
		readonly DirectoryBackupGateway: DirectoryBackupGatewayBinding;
	};
}

type StoredBackup = { backup: DirectoryBackupRecord; expiresAt: number };

const BACKUP_PREFIX = "directory-backup:";

export class SiteBuilderSandboxRuntime extends NativeContainerSandbox<SiteBuilderEnv> {
	readonly #backups: DirectoryBackup;

	constructor(ctx: SiteBuilderState, env: SiteBuilderEnv) {
		super(ctx, env);
		this.#backups = new DirectoryBackup(
			this.container,
			ctx.exports.DirectoryBackupGateway,
			{ binding: "SITE_BUILDER_STORAGE", prefix: "directory-backups/" },
		);
	}

	protected get containerTelemetrySurface(): string {
		return "cms";
	}

	protected override get inactivityTimeoutMs(): number {
		return 15 * 60 * 1000;
	}

	protected startOptions(): ContainerStartupOptions {
		return {
			image: this.container.images.sandbox,
			instance: "standard-1",
			enableInternet: true,
			labels: {
				orgSlug: this.ctx.id.name ?? this.ctx.id.toString(),
				platform: "tedix-site-builder",
				env: this.env.ENVIRONMENT ?? "production",
			},
		};
	}
	private authoringPreparation?: Promise<string>;
	async getAuthoringWorkspaceState(): Promise<string> {
		if (this.authoringPreparation) await this.authoringPreparation;
		return authoringWorkspaceState(this);
	}
	async prepareAuthoringWorkspace(
		input: AuthoringWorkspaceInput,
	): Promise<string> {
		if (this.authoringPreparation) return this.authoringPreparation;
		const pending = prepareAuthoringWorkspace(this, input);
		this.authoringPreparation = pending;
		try {
			return await pending;
		} finally {
			this.authoringPreparation = undefined;
		}
	}
	async getCmsJobId(key: string): Promise<string | null> {
		const row = await this.ctx.storage.get<{ id?: string }>(`cms-job:${key}`);
		if (row && !row.id)
			throw new Error(
				"CMS launch outcome is unknown; refusing duplicate launch",
			);
		return row?.id ?? null;
	}
	async launchCmsJob(
		key: string,
		command: SandboxCommand,
		options: SandboxExecOptions,
		replaceExited = false,
	): Promise<string> {
		const storageKey = `cms-job:${key}`;
		const canonical = JSON.stringify({
			command,
			cwd: options.cwd ?? null,
			env: Object.fromEntries(
				Object.entries(options.env ?? {}).sort(([a], [b]) =>
					a.localeCompare(b),
				),
			),
			timeout: options.timeout ?? null,
		});
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(canonical),
		);
		const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		const existing = await this.ctx.storage.get<{
			id?: string;
			fingerprint: string;
		}>(storageKey);
		if (existing) {
			if (!existing.id)
				throw new Error(
					"CMS launch outcome is unknown; refusing duplicate launch",
				);
			if (!replaceExited && existing.fingerprint !== fingerprint)
				throw new Error("CMS job already exists with different launch inputs");
			const process = await this.getProcess(existing.id);
			if (!process && !replaceExited)
				throw new Error(
					"CMS process was lost with its container; use a new job",
				);
			const status = process ? await process.status() : null;
			if (
				!replaceExited ||
				status?.state === "running" ||
				status?.state === "starting"
			)
				return existing.id;
			await this.deleteProcess(existing.id);
		}
		await this.ctx.storage.transaction(async (tx) => {
			const current = await tx.get<{ id?: string }>(storageKey);
			if (current && (!current.id || current.id !== existing?.id))
				throw new Error(
					"CMS launch already claimed; refusing duplicate launch",
				);
			await tx.put(storageKey, { pending: true, fingerprint });
		});
		const process = await this.startProcess(
			crypto.randomUUID(),
			command,
			options,
		);
		await this.ctx.storage.put(storageKey, { id: process.id, fingerprint });
		return process.id;
	}

	async createBackup(input: {
		dir: string;
		name?: string;
		ttl?: number;
		excludes?: string[];
	}): Promise<DirectoryBackupRecord> {
		await this.ensureContainer();
		const backup = await this.#backups.backup({
			dir: input.dir,
			name: input.name,
			exclude: input.excludes,
		});
		const expiresAt = Date.now() + (input.ttl ?? 7 * 24 * 60 * 60) * 1000;
		await this.ctx.storage.put(`${BACKUP_PREFIX}${backup.id}`, {
			backup,
			expiresAt,
		} satisfies StoredBackup);
		const alarm = await this.ctx.storage.getAlarm();
		if (alarm === null || expiresAt < alarm)
			await this.ctx.storage.setAlarm(expiresAt);
		return backup;
	}

	async restoreBackup(input: DirectoryBackupRecord & { dir?: string }) {
		await this.ensureContainer();
		await this.#backups.restore(input, { dir: input.dir });
		return { success: true as const };
	}

	override async alarm(): Promise<void> {
		const now = Date.now();
		let next: number | null = null;
		const records = await this.ctx.storage.list<StoredBackup>({
			prefix: BACKUP_PREFIX,
		});
		for (const [key, stored] of records) {
			if (stored.expiresAt <= now) {
				await this.#backups.delete(stored.backup);
				await this.ctx.storage.delete(key);
			} else if (next === null || stored.expiresAt < next)
				next = stored.expiresAt;
		}
		if (next !== null) await this.ctx.storage.setAlarm(next);
	}
}
