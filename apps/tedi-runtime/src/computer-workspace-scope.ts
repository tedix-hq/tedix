import {
	getWorkspace,
	type WorkspaceClient,
	type Workspace,
} from "@cloudflare/computer";
import type { ToolSet } from "ai";
import {
	adaptVfsToWorkspaceFs,
	createTediComputerTools,
	type ComputerWorkspaceSurface,
} from "./workspace-fs";
import type {
	ComputerWorkspaceIdentity,
	TediComputerWorkspaceDO,
} from "./computer-workspace-do";

export interface ComputerWorkspaceScope {
	kind: "conversation" | "delegated-run" | "operator";
	key: string;
}

/** Preserve complete keys: replacing punctuation aliases unrelated conversations. */
export function computerWorkspaceScope(input: {
	sessionKey: string;
	runId?: string;
	workItemId?: string;
}): ComputerWorkspaceScope {
	if (!input.sessionKey)
		throw new Error("Computer workspace requires a session key");
	if (input.workItemId) {
		if (!input.runId)
			throw new Error("Delegated Computer workspace requires a run ID");
		return {
			kind: "delegated-run",
			key: input.workItemId,
		};
	}
	return { kind: "conversation", key: input.sessionKey };
}

export const OPERATOR_COMPUTER_SCOPE: ComputerWorkspaceScope = {
	kind: "operator",
	key: "direct-control",
};

/** Lazy acquisition lets Pi describe tools synchronously without a mutable active workspace. */
export class ScopedComputerWorkspace {
	readonly id: string;
	readonly snapshotPrefix: string;
	readonly surface: ComputerWorkspaceSurface;
	readonly workspace;
	readonly git: Pick<Workspace["git"], "clone" | "cli">;
	private readonly stub: DurableObjectStub<TediComputerWorkspaceDO>;

	constructor(
		namespace: DurableObjectNamespace<TediComputerWorkspaceDO>,
		readonly scope: ComputerWorkspaceScope,
		private readonly ownerId: string,
		private readonly resolveTediId: () => Promise<string>,
	) {
		this.scope = { kind: scope.kind, key: scope.key };
		const id = namespace.idFromName(
			JSON.stringify([ownerId, scope.kind, scope.key]),
		);
		this.id = id.toString();
		this.snapshotPrefix = `workspace/${this.id}/`;
		this.stub = namespace.get(id);
		const fsMethod = <K extends keyof ComputerWorkspaceSurface["fs"]>(
			name: K,
		): ComputerWorkspaceSurface["fs"][K] => {
			// The selected method keeps its public Computer overloads. No path rewriting occurs here.
			return ((...args: unknown[]) =>
				this.withClient((client) =>
					Reflect.apply(client.fs[name], client.fs, args),
				)) as ComputerWorkspaceSurface["fs"][K];
		};
		this.surface = {
			fs: {
				stat: fsMethod("stat"),
				lstat: fsMethod("lstat"),
				readFile: fsMethod("readFile"),
				writeFile: fsMethod("writeFile"),
				mkdir: fsMethod("mkdir"),
				rm: fsMethod("rm"),
				rename: fsMethod("rename"),
				find: fsMethod("find"),
				grep: fsMethod("grep"),
				readdir: fsMethod("readdir"),
				symlink: fsMethod("symlink"),
				readlink: fsMethod("readlink"),
			},
			runtime: {
				exec: ((...args: unknown[]) =>
					this.withClient((client) =>
						Reflect.apply(client.runtime.exec, client.runtime, args),
					)) as WorkspaceClient["runtime"]["exec"],
			},
		};
		this.git = {
			clone: async (options) => {
				await this.initialize();
				return this.stub.clone(options);
			},
			cli: (...args) => this.withClient((client) => client.git.cli(...args)),
		};
		this.workspace = {
			...adaptVfsToWorkspaceFs(this.surface),
			writeReversibleFile: async (path: string, content: string) => {
				await this.initialize();
				return this.stub.writeReversibleFile(path, content);
			},
			restoreFile: async (
				path: string,
				expectedContent: string,
				previousContent: string | null,
			) => {
				await this.initialize();
				await this.stub.restoreFile(path, expectedContent, previousContent);
			},
		};
	}

	tools(): ToolSet {
		return createTediComputerTools(this.surface);
	}

	private async initialize(): Promise<void> {
		const identity: ComputerWorkspaceIdentity = {
			ownerId: this.ownerId,
			tediId: await this.resolveTediId(),
			scope: JSON.stringify(this.scope),
		};
		await this.stub.initialize(identity);
	}

	private async withClient<T>(
		run: (client: WorkspaceClient) => Promise<T>,
	): Promise<T> {
		await this.initialize();
		// Computer types its host as the local RpcTarget; Workers maps that target to a remote stub.
		using client = await getWorkspace(
			this.stub as unknown as Parameters<typeof getWorkspace>[0],
		);
		return await run(client);
	}
}
