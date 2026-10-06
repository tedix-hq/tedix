import {
	THEME_SOURCE_MANIFEST_PATH,
	THEME_SOURCE_VERSION,
} from "../template-policy";
import { isPathEditable } from "./constraints";
import { sha256Hex } from "@tedix/worker-kit/crypto";

const WORKSPACE = "/workspace";
const ARTIFACTS_COMMIT = /^[a-f0-9]{40}$/;

interface EditableSourceSandbox {
	listFiles(
		path: string,
		options: { recursive: true },
	): Promise<Array<{ type: string; relativePath: string }>>;
	readFile(path: string): Promise<{ content: string; size: number }>;
}

/**
 * Hash every editable source file as a sorted path + content-hash manifest.
 * Locked platform files are deliberately excluded: their canonical source is
 * the Tedix release, while this digest identifies the tenant-authored theme
 * input that produced one deployed bundle.
 */
export interface EditableThemeSource {
	digest: string;
	fileCount: number;
}

/**
 * Prepare one explicit ownership migration from a pinned tenant commit and the
 * exact platform source used for that revision. previousLockedPaths is the
 * expanded concrete file inventory from that release's policy and snapshot.
 * Call separately for active source and draft; persist with expected-head CAS.
 */
export function migrateThemePresentationSource(input: {
	templateSlug: string;
	source: Readonly<Record<string, string>>;
	platformSource: Readonly<Record<string, string>>;
	previousLockedPaths: readonly string[];
}): { files: Record<string, string>; adoptedPaths: string[] } {
	if (input.source[THEME_SOURCE_MANIFEST_PATH] !== undefined) {
		throw new Error(
			"Theme source already has an ownership manifest; do not fill missing files",
		);
	}
	const files = { ...input.source };
	const adoptedPaths = [...new Set(input.previousLockedPaths)]
		.filter((path) => isPathEditable(path, input.templateSlug))
		.sort();
	if (adoptedPaths.length === 0)
		throw new Error("No presentation paths in the previous platform inventory");
	for (const path of adoptedPaths) {
		const content = input.platformSource[path];
		if (content === undefined) {
			throw new Error(`Exact previous platform source missing: ${path}`);
		}
		// Those files were overwritten by locked resync on every old build.
		// A stale copy in the tenant repository was not the deployed source.
		files[path] = content;
	}
	files[THEME_SOURCE_MANIFEST_PATH] =
		JSON.stringify({ version: THEME_SOURCE_VERSION }) + "\n";
	return { files, adoptedPaths };
}

/** Sorted editable `src/...` paths under `root` (a workspace or checkout). */
async function listEditablePaths(
	sandbox: EditableSourceSandbox,
	root: string,
	templateSlug: string,
): Promise<string[]> {
	const listing = await sandbox.listFiles(`${root}/src`, { recursive: true });
	return listing
		.filter((file) => file.type === "file")
		.map((file) =>
			file.relativePath.startsWith("src/")
				? file.relativePath
				: `src/${file.relativePath}`,
		)
		.filter((path) => isPathEditable(path, templateSlug))
		.sort();
}

export async function digestEditableThemeSource(
	sandbox: EditableSourceSandbox,
	templateSlug: string,
	root = WORKSPACE,
): Promise<EditableThemeSource> {
	const paths = await listEditablePaths(sandbox, root, templateSlug);
	if (paths.length === 0) {
		throw new Error("CMS theme has no editable source files to identify");
	}

	const entries: string[] = [];
	for (const path of paths) {
		const file = await sandbox.readFile(`${root}/${path}`);
		entries.push(`${path}:${await sha256Hex(file.content)}`);
	}

	return {
		digest: await sha256Hex(entries.join("\n")),
		fileCount: entries.length,
	};
}

/**
 * Re-identify the editable source on a build attempt and require it to equal
 * the identity pinned before the first attempt. The builder container is
 * disposable: a retry can land in a fresh container whose /workspace holds the
 * stock starter instead of the tenant theme, and building that would publish
 * the stock template over the live site. A changed identity is therefore a
 * permanent failure — `fail` lets the workflow raise its non-retryable error.
 */
export async function requirePinnedEditableThemeSource(
	sandbox: EditableSourceSandbox,
	templateSlug: string,
	pinned: EditableThemeSource,
	fail: (message: string) => Error = (message) => new Error(message),
	root = WORKSPACE,
): Promise<EditableThemeSource> {
	const current = await digestEditableThemeSource(sandbox, templateSlug, root);
	if (current.digest !== pinned.digest) {
		throw fail(
			`Editable theme source changed since deploy preflight ` +
				`(${pinned.fileCount} files ${pinned.digest.slice(0, 12)} -> ` +
				`${current.fileCount} files ${current.digest.slice(0, 12)}); ` +
				`the builder workspace was likely reset. Refusing to publish. ` +
				`Restore the theme source and deploy again.`,
		);
	}
	return current;
}

interface ThemeSourceSandbox extends EditableSourceSandbox {
	exec(argv: [string, ...string[]]): Promise<{
		output(options: { encoding: "utf8"; maxBytes: number }): Promise<{
			exitCode: number | null;
			stdout: string;
			stderr: string;
		}>;
	}>;
	writeFile(path: string, content: string): Promise<unknown>;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

async function runScript(
	sandbox: ThemeSourceSandbox,
	label: string,
	script: string,
): Promise<string> {
	const result = await (
		await sandbox.exec(["sh", "-c", script])
	).output({
		encoding: "utf8",
		maxBytes: 1024 * 1024,
	});
	if (result.exitCode !== 0) {
		throw new Error(`${label} failed: ${result.stderr || result.stdout}`);
	}
	return result.stdout;
}

/**
 * Replace the builder workspace's editable theme files with exactly the
 * editable files of one commit in the tenant's Cloudflare Artifacts theme
 * repository. The container is disposable and may hold the stock starter at
 * any point, so a deploy that names its source commit never lets the
 * container's current contents decide what ships. Locked files are left to
 * the template resync; the short-lived read token never leaves the sandbox
 * temp files, which are removed on every path.
 */
export async function materializeEditableThemeSource(
	sandbox: ThemeSourceSandbox,
	input: {
		remote: string;
		token: string;
		commit: string;
		templateSlug: string;
		workspace?: string;
	},
): Promise<void> {
	if (!ARTIFACTS_COMMIT.test(input.commit)) {
		throw new Error(`Invalid theme source commit: ${input.commit}`);
	}
	const checkout = `/tmp/tedix-theme-source-${input.commit}-${crypto.randomUUID()}`;
	const workspace = input.workspace ?? WORKSPACE;
	const tokenPath = `${checkout}.token`;
	const deletePath = `${checkout}.delete`;
	const copyPath = `${checkout}.copy`;
	await sandbox.writeFile(tokenPath, input.token);
	const head = await runScript(
		sandbox,
		"Theme source fetch",
		`set -eu
TOKEN_FILE=${shellQuote(tokenPath)}
trap 'rm -f "$TOKEN_FILE"' EXIT
rm -rf ${shellQuote(checkout)}
git init -q ${shellQuote(checkout)}
cd ${shellQuote(checkout)}
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader \
GIT_CONFIG_VALUE_0="Authorization: Bearer $(cat "$TOKEN_FILE")" \
git fetch -q --depth 1 ${shellQuote(input.remote)} ${input.commit}
git -c advice.detachedHead=false checkout -q FETCH_HEAD
git rev-parse HEAD`,
	);
	if (head.trim() !== input.commit) {
		throw new Error(
			`Theme source fetch resolved ${head.trim()} instead of ${input.commit}`,
		);
	}

	// Older repositories stored only the previous editable subset. Never infer
	// missing presentation from today's starter: that could replace tenant bytes
	// or undo intentional deletions. Require an explicit, reviewed migration.
	try {
		const manifest = JSON.parse(
			(await sandbox.readFile(`${checkout}/${THEME_SOURCE_MANIFEST_PATH}`))
				.content,
		) as { version?: unknown };
		if (manifest.version !== THEME_SOURCE_VERSION)
			throw new Error("Unsupported theme source version");
	} catch {
		await runScript(
			sandbox,
			"Theme source cleanup",
			`rm -rf ${shellQuote(checkout)}`,
		);
		throw new Error(
			`Theme source commit ${input.commit} requires the site-owned presentation migration. ` +
				`Preserve its exact presentation files and add ${THEME_SOURCE_MANIFEST_PATH} ` +
				`with version ${THEME_SOURCE_VERSION} before deploying. The destination was not changed.`,
		);
	}

	const incoming = await listEditablePaths(
		sandbox,
		checkout,
		input.templateSlug,
	);
	if (incoming.length === 0) {
		throw new Error(
			`Theme source commit ${input.commit} has no editable source files`,
		);
	}
	const current = await listEditablePaths(
		sandbox,
		workspace,
		input.templateSlug,
	);
	await sandbox.writeFile(deletePath, current.join("\n") + "\n");
	await sandbox.writeFile(copyPath, incoming.join("\n") + "\n");
	await runScript(
		sandbox,
		"Theme source materialization",
		`set -eu
trap 'rm -rf ${shellQuote(checkout)} ${shellQuote(deletePath)} ${shellQuote(copyPath)}' EXIT
cd ${shellQuote(workspace)}
while IFS= read -r p; do
  if [ -n "$p" ]; then rm -f -- "$p"; fi
done < ${shellQuote(deletePath)}
while IFS= read -r p; do
  if [ -n "$p" ]; then
    mkdir -p -- "$(dirname -- "$p")"
    cp -- ${shellQuote(checkout)}/"$p" "$p"
  fi
done < ${shellQuote(copyPath)}`,
	);
}
