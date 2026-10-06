import { DurableObject } from "cloudflare:workers";
import type { WorkspaceStub, Workspace } from "@cloudflare/computer";
import {
	createTediWorkspaceVfs,
	adaptVfsToWorkspaceFs,
	restoreWorkspaceFile,
	writeReversibleWorkspaceFile,
	type WorkspaceVfsStorage,
	type R2IdentityMountBucket,
	type TediComputerExecution,
} from "./workspace-fs";

export interface ComputerWorkspaceIdentity {
	ownerId: string;
	tediId: string;
	scope: string;
}

type ComputerWorkspaceEnv = {
	LOADER: TediComputerExecution["loader"];
	TEDI_STORAGE?: R2IdentityMountBucket;
};

/** One SQLite filesystem per immutable conversation or delegated execution. */
export class TediComputerWorkspaceDO extends DurableObject<ComputerWorkspaceEnv> {
	private readonly workspace = createTediWorkspaceVfs(
		this.ctx.storage as unknown as WorkspaceVfsStorage,
		{
			execution: {
				ctx: this.ctx,
				loader: this.env.LOADER,
				workspace: {
					binding: "TEDI_COMPUTER_WORKSPACE",
					id: this.ctx.id.toString(),
				},
			},
			identityMount: async () => {
				const identity =
					await this.ctx.storage.get<ComputerWorkspaceIdentity>("identity");
				if (!identity)
					throw new Error("Computer workspace identity is not initialized");
				return this.env.TEDI_STORAGE
					? { bucket: this.env.TEDI_STORAGE, prefix: `${identity.tediId}/` }
					: null;
			},
		},
	);

	async initialize(identity: ComputerWorkspaceIdentity): Promise<void> {
		if (!identity.ownerId || !identity.tediId || !identity.scope)
			throw new Error("Computer workspace identity is required");
		const mismatch = await this.ctx.blockConcurrencyWhile(async () => {
			const current =
				await this.ctx.storage.get<ComputerWorkspaceIdentity>("identity");
			if (
				current &&
				(current.ownerId !== identity.ownerId ||
					current.tediId !== identity.tediId ||
					current.scope !== identity.scope)
			) {
				return true;
			}
			if (!current) await this.ctx.storage.put("identity", identity);
			return false;
		});
		if (mismatch) throw new Error("Computer workspace identity cannot change");
	}

	async writeReversibleFile(
		path: string,
		content: string,
	): Promise<{ previousContent: string | null }> {
		return this.withGuardedFileOperation(async () => {
			await this.__getWorkspaceStub();
			return writeReversibleWorkspaceFile(
				adaptVfsToWorkspaceFs(this.workspace),
				path,
				content,
			);
		});
	}

	async restoreFile(
		path: string,
		expectedContent: string,
		previousContent: string | null,
	): Promise<void> {
		await this.withGuardedFileOperation(async () => {
			await this.__getWorkspaceStub();
			await restoreWorkspaceFile(
				adaptVfsToWorkspaceFs(this.workspace),
				path,
				expectedContent,
				previousContent,
			);
		});
	}

	private async withGuardedFileOperation<T>(run: () => Promise<T>): Promise<T> {
		// Expected conflicts must leave the barrier normally: rejecting its
		// callback resets the DO and invalidates existing Computer RPC clients.
		const result = await this.ctx.blockConcurrencyWhile(async () => {
			try {
				return { ok: true as const, value: await run() };
			} catch (error) {
				return { ok: false as const, error };
			}
		});
		if (!result.ok) throw result.error;
		return result.value;
	}

	async clone(
		options: Parameters<Workspace["git"]["clone"]>[0],
	): Promise<Awaited<ReturnType<Workspace["git"]["clone"]>>> {
		await this.workspace.ready();
		return this.workspace.git.clone(options);
	}

	async __getWorkspaceStub(): Promise<WorkspaceStub> {
		if (!(await this.ctx.storage.get("identity")))
			throw new Error("Computer workspace is not initialized");
		await this.workspace.ready();
		return this.workspace.stub();
	}
}
