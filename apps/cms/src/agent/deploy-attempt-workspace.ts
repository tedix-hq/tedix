import type { CmsTemplateSlug } from "../template-policy";
import type { CmsSandbox } from "../sandbox";
import { CmsUnknownProcessOutcomeError } from "./cms-restore-permit";

type WorkspaceSandbox = Pick<CmsSandbox, "exec">;

const ATTEMPT_ROOT = "/tmp/tedix-cms-deploy-";

function assertAttemptWorkspace(path: string): void {
	if (!new RegExp(`^${ATTEMPT_ROOT}[0-9a-f-]{36}$`).test(path)) {
		throw new Error("Invalid CMS deploy attempt workspace");
	}
}

/**
 * Give each workflow attempt its own source, dependencies and dist output.
 * A timed-out attempt can leave a native Astro process running in the shared
 * tenant sandbox; it must not be able to rewrite a later attempt's inputs or
 * erase a file while that attempt is staging its bundle.
 */
export async function createDeployAttemptWorkspace(
	sandbox: WorkspaceSandbox,
	jobId: string,
	sourceRoot:
		| "/workspace"
		| `/workspace-templates/${CmsTemplateSlug}` = "/workspace",
): Promise<{ path: string; stagingAttemptId: string }> {
	if (!/^[a-zA-Z0-9._-]{1,128}$/.test(jobId)) {
		throw new Error("Invalid CMS deploy job ID");
	}
	const nonce = crypto.randomUUID();
	const path = `${ATTEMPT_ROOT}${nonce}`;
	const result = await (
		await sandbox.exec([
			"bash",
			"-lc",
			`set -e; mkdir -p -- '${path}'; cd '${sourceRoot}'; shopt -s dotglob nullglob; ` +
				`for source in *; do ` +
				`case "$source" in node_modules|dist|.astro|.wrangler) continue;; esac; ` +
				`cp -a -- "$source" '${path}/'; done`,
		])
	).output({ encoding: "utf8", maxBytes: 1024 * 1024 });
	if (result.timedOut) {
		throw new CmsUnknownProcessOutcomeError(
			"CMS deploy attempt workspace copy outcome is unknown",
		);
	}
	if (
		result.exitCode !== 0 ||
		result.signal !== undefined ||
		result.truncated
	) {
		throw new Error(
			`CMS deploy attempt workspace copy failed: ${result.stderr || result.stdout}`,
		);
	}
	return { path, stagingAttemptId: `${jobId}-a${nonce}` };
}

/** Clear only the copied attempt's build caches and prior dist output. */
export async function clearDeployAttemptBuildOutput(
	sandbox: WorkspaceSandbox,
	path: string,
): Promise<void> {
	assertAttemptWorkspace(path);
	const result = await (
		await sandbox.exec([
			"bash",
			"-lc",
			`rm -rf -- '${path}/node_modules/.vite' '${path}/.astro' '${path}/dist'`,
		])
	).output({ encoding: "utf8", maxBytes: 1024 * 1024 });
	if (result.timedOut) {
		throw new CmsUnknownProcessOutcomeError(
			"CMS deploy attempt cache cleanup outcome is unknown",
		);
	}
	if (
		result.exitCode !== 0 ||
		result.signal !== undefined ||
		result.truncated
	) {
		throw new Error("CMS deploy attempt cache cleanup failed");
	}
}

/** Only remove a path minted by createDeployAttemptWorkspace. */
export async function removeDeployAttemptWorkspace(
	sandbox: WorkspaceSandbox,
	path: string,
): Promise<void> {
	assertAttemptWorkspace(path);
	const result = await (
		await sandbox.exec(["bash", "-lc", `rm -rf -- '${path}'`])
	).output({ encoding: "utf8", maxBytes: 1024 * 1024 });
	if (result.timedOut) {
		throw new CmsUnknownProcessOutcomeError(
			"CMS deploy attempt workspace cleanup outcome is unknown",
		);
	}
	if (
		result.exitCode !== 0 ||
		result.signal !== undefined ||
		result.truncated
	) {
		throw new Error(`CMS deploy attempt workspace cleanup failed`);
	}
}
