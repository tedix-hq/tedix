import { callRpc, serviceBindingFetch } from "@tedix/api-client/internal";
import { exceptionTopology } from "@tedix/worker-kit/exception-topology";
import { TEDIX_ARTIFACTS_NAMESPACE_PRODUCTION } from "./artifacts-contract";
import { tediRuntimeServiceBindingHeaders } from "./platform-client-factory";
import {
	commitIdentityWorkspaceFiles,
	type IdentityReadDiagnostics,
	selectIdentityWorkspaceFiles,
	type WorkspaceFile,
} from "./workspace";

const IDENTITY_CONFIG_FETCH_TIMEOUT_MS = 20_000;

export interface IdentityProvisioningDeps {
	fetchWorkspaceFiles(
		env: IdentityProvisioningEnv & { API_SERVICE: Fetcher },
		tediId: string,
		organizationId: string,
	): Promise<Record<string, unknown>>;
	commit: typeof commitIdentityWorkspaceFiles;
}

const defaultDeps: IdentityProvisioningDeps = {
	async fetchWorkspaceFiles(env, tediId, organizationId) {
		const config = await callRpc<{ workspaceFiles?: Record<string, unknown> }>(
			"tedis/syncConfig",
			{ tediId },
			{
				apiUrl: "https://api",
				fetch: serviceBindingFetch(env.API_SERVICE),
				headers: tediRuntimeServiceBindingHeaders(
					tediId,
					"apps:write",
					organizationId,
				),
				timeoutMs: IDENTITY_CONFIG_FETCH_TIMEOUT_MS,
			},
		);
		return config.workspaceFiles ?? {};
	},
	commit: commitIdentityWorkspaceFiles,
};

export interface IdentityProvisioningEnv {
	API_SERVICE?: Fetcher;
	ARTIFACTS?: Artifacts;
	CF_ACCOUNT_ID?: string;
}

/**
 * Write a tedi's missing instruction files (SOUL, IDENTITY, USER, AGENTS,
 * TOOLS, memory/MEMORY.md) from its generated defaults, then return them so
 * this turn already uses them. Only a repo that was read successfully, or one
 * that does not exist yet (the commit creates it), counts: an unreadable repo
 * is not "missing" and is never overwritten. Every failure
 * leaves the files missing for this turn and is retried on the next cold load.
 */
export async function provisionMissingIdentityFiles(
	env: IdentityProvisioningEnv,
	input: {
		tediId: string;
		organizationId: string;
		slug: string;
		diagnostics: IdentityReadDiagnostics;
	},
	deps: IdentityProvisioningDeps = defaultDeps,
): Promise<WorkspaceFile[]> {
	const { diagnostics } = input;
	if (
		!diagnostics.missingFiles.length ||
		diagnostics.artifacts.error ||
		// A repo that exists but could not be read is not missing its files.
		(diagnostics.artifacts.repoFound !== false &&
			diagnostics.artifacts.cloneOk !== true) ||
		!env.API_SERVICE ||
		!env.ARTIFACTS ||
		!env.CF_ACCOUNT_ID
	)
		return [];
	try {
		const workspaceFiles = await deps.fetchWorkspaceFiles(
			{ ...env, API_SERVICE: env.API_SERVICE },
			input.tediId,
			input.organizationId,
		);
		const files = selectIdentityWorkspaceFiles(
			workspaceFiles,
			diagnostics.missingFiles,
		);
		if (!files.length) return [];
		await deps.commit(env.ARTIFACTS, {
			assertReady: async () => {},
			accountId: env.CF_ACCOUNT_ID,
			namespace: TEDIX_ARTIFACTS_NAMESPACE_PRODUCTION,
			tediId: input.tediId,
			slug: input.slug,
			files,
		});
		console.info("[isolate.workspace] provisioned identity files", {
			tediId: input.tediId,
			files: files.map((file) => file.path),
		});
		return files.map((file) => ({ key: file.path, text: file.content }));
	} catch (err) {
		console.warn("[isolate.workspace] identity provisioning failed", {
			tediId: input.tediId,
			exception: exceptionTopology(err),
		});
		return [];
	}
}
