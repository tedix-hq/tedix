import { sha256Hex } from "@tedix/worker-kit/crypto";
import { resyncTemplate, snapshotForTemplate } from "./template-sync";
import { isPathLocked } from "./constraints";
import type { CmsSandbox } from "../sandbox";
import { normalizeCmsTemplateSlug } from "../template-policy";
import { materializeEditableThemeSource } from "./source-provenance";

type Sandbox = Parameters<typeof materializeEditableThemeSource>[0] &
	Pick<CmsSandbox, "mkdir">;
export interface AuthoringWorkspaceInput {
	templateSlug: string;
	existingSite: boolean;
	source?: { remote: string; token: string };
}
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
async function run(sandbox: Sandbox, script: string): Promise<string> {
	const result = await (
		await sandbox.exec(["sh", "-c", script])
	).output({ encoding: "utf8", maxBytes: 8192 });
	if (result.exitCode !== 0)
		throw new Error(
			"Authoring workspace preparation failed; existing source was preserved",
		);
	return result.stdout.trim();
}

/** Refresh only platform-owned files; the fingerprint survives DO hibernation. */
async function prepareLockedFiles(
	sandbox: Sandbox,
	template: string,
	workspace: string,
) {
	const { snapshot, paths } = snapshotForTemplate(template);
	const revision = await sha256Hex(
		JSON.stringify(
			paths
				.filter((path) => isPathLocked(path, template))
				.map((path) => [path, snapshot[path]]),
		),
	);
	const marker = `${workspace}/.tedix-authoring-platform`;
	if (
		await sandbox
			.readFile(marker)
			.then((file) => file.content === revision)
			.catch(() => false)
	)
		return;
	await resyncTemplate(sandbox as CmsSandbox, {
		scope: "locked",
		templateSlug: template,
		workspace,
	});
	await run(
		sandbox,
		`set -eu\ncd ${quote(workspace)}\nbun install --frozen-lockfile`,
	);
	await sandbox.writeFile(marker, revision);
}

/** The sentinel is on the container filesystem, never durable DO storage. */
export async function authoringWorkspaceState(
	sandbox: Sandbox,
): Promise<string> {
	return run(
		sandbox,
		`set -eu
if [ -f /workspace/.tedix-authoring-ready ]; then echo ready
elif diff -qr -x node_modules /workspace /workspace-templates/tedix >/dev/null; then echo pristine
else echo modified; fi`,
	);
}

/** Caller serializes this operation in the owning Sandbox Durable Object. */
export async function prepareAuthoringWorkspace(
	sandbox: Sandbox,
	input: AuthoringWorkspaceInput,
): Promise<string> {
	const state = await authoringWorkspaceState(sandbox);
	const template = normalizeCmsTemplateSlug(input.templateSlug);
	if (state === "ready") {
		await prepareLockedFiles(sandbox, template, "/workspace");
		return state;
	}
	if (state !== "pristine") return state;
	const stage = `/tmp/cms-authoring-${crypto.randomUUID()}`;
	const tokenPath = `${stage}.token`;
	let commit: string | undefined;
	try {
		if (input.source) {
			await sandbox.writeFile(tokenPath, input.source.token);
			const refs = await run(
				sandbox,
				`set -eu
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="Authorization: Bearer $(cat ${quote(tokenPath)})" git ls-remote ${quote(input.source.remote)} refs/heads/main`,
			);
			commit = refs.split(/\s+/)[0] || undefined;
			if (commit && !/^[a-f0-9]{40}$/.test(commit))
				throw new Error("Invalid authoring main revision");
		}
		if (!commit && input.existingSite)
			throw new Error(
				"Existing CMS site has no recoverable Artifacts main source; refusing starter editing",
			);
		await run(
			sandbox,
			`set -eu\nmkdir ${quote(stage)}\ncp -a /workspace-templates/${template}/. ${quote(stage)}/\nif [ -d /workspace/node_modules ]; then cp -a /workspace/node_modules ${quote(stage)}/; fi`,
		);
		if (commit && input.source)
			await materializeEditableThemeSource(sandbox, {
				...input.source,
				commit,
				templateSlug: template,
				workspace: stage,
			});
		await prepareLockedFiles(sandbox, template, stage);
		await sandbox.writeFile(
			`${stage}/.tedix-authoring-ready`,
			JSON.stringify({ templateSlug: template, sourceCommit: commit ?? null }),
		);
		// A second check fences edits made during source preparation. Swapping the
		// prepared directory keeps the complete old workspace recoverable afterward.
		await run(
			sandbox,
			`set -eu
[ ! -f /workspace/.tedix-authoring-ready ]
diff -qr -x node_modules /workspace /workspace-templates/tedix >/dev/null
mv /workspace ${quote(stage + ".previous")}
if ! mv ${quote(stage)} /workspace; then mv ${quote(stage + ".previous")} /workspace; exit 1; fi
`,
		);
		return commit ?? "starter";
	} finally {
		await run(
			sandbox,
			`rm -f ${quote(tokenPath)}; rm -rf ${quote(stage)}`,
		).catch(() => undefined);
	}
}

/** Discovery and CMS content APIs never start an authoring container. */
export const AUTHORING_TOOLS = new Set([
	"theme_list_files",
	"theme_read_file",
	"theme_write_file",
	"theme_write_files",
	"theme_delete_file",
	"theme_build",
	"theme_preview_start",
	"theme_preview_exec",
]);
