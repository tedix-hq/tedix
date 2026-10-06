import { assertDocsFilePath } from "./authoring-policy";
import { getDocsSandbox } from "./sandbox";
import {
	assertArtifactsRepositoryUrl,
	assertBranch,
	shellQuote,
} from "./source";
import type { AppBindings, DocsChange, DocsSite } from "./types";

const MAX_AUTHORING_FILE_BYTES = 512 * 1024;
const MAX_DIFF_CHARS = 40_000;
const MAX_LISTED_FILES = 2_000;
const GIT_REVISION_RE = /^[a-f0-9]{40,64}$/i;

function assertWritableSite(site: DocsSite): asserts site is DocsSite & {
	artifactsRepository: string;
} {
	if (site.sourceProvider !== "artifacts" || !site.artifactsRepository) {
		throw new Error(
			"Git authoring requires a Cloudflare Artifacts-backed documentation site",
		);
	}
}

function trimDiff(value: string): string {
	if (value.length <= MAX_DIFF_CHARS) return value;
	return `${value.slice(0, MAX_DIFF_CHARS)}\n… diff truncated …`;
}

export async function docsFileEvidence(value: string): Promise<{
	contentSha256: string;
	byteLength: number;
}> {
	const bytes = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return {
		contentSha256: [...new Uint8Array(digest)]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join(""),
		byteLength: bytes.byteLength,
	};
}

async function sha256(value: string): Promise<string> {
	return (await docsFileEvidence(value)).contentSha256;
}

async function checkout(
	env: AppBindings,
	site: DocsSite,
	operationId: string,
	options: { branch?: string; write: boolean },
) {
	assertWritableSite(site);
	if (!env.ARTIFACTS) {
		throw new Error("Cloudflare Artifacts binding is unavailable");
	}
	const repository = await env.ARTIFACTS.get(site.artifactsRepository);
	const token = await repository.createToken(
		options.write ? "write" : "read",
		900,
	);
	const plaintext = await token.plaintext;
	const remote = site.repositoryUrl
		? assertArtifactsRepositoryUrl(site.repositoryUrl, site.artifactsRepository)
		: await repository.remote;
	const sandbox = getDocsSandbox(env, `author-${operationId}`);
	const root = `/tmp/tedix-docs-author-${operationId}`;
	const tokenFile = `/tmp/tedix-docs-author-token-${operationId}`;
	await sandbox.writeFile(tokenFile, plaintext);
	const branch = assertBranch(options.branch ?? site.branch);
	const script = `set -eu
rm -rf ${shellQuote(root)}
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=http.extraHeader
export GIT_CONFIG_VALUE_0="Authorization: Bearer $(cat ${shellQuote(tokenFile)})"
git clone --single-branch --branch ${shellQuote(branch)} ${shellQuote(remote)} ${shellQuote(root)}
rm -f ${shellQuote(tokenFile)}
git -C ${shellQuote(root)} rev-parse HEAD`;
	const cloned = await (
		await sandbox.exec(["bash", "-lc", script], {
			timeout: 120_000,
		})
	).output({ encoding: "utf8", maxBytes: 16 * 1024 * 1024 });
	if (
		cloned.exitCode !== 0 ||
		cloned.timedOut ||
		cloned.signal !== undefined ||
		cloned.truncated
	) {
		throw new Error(`Git checkout failed: ${cloned.stderr.slice(-1200)}`);
	}
	const revision = cloned.stdout
		.split("\n")
		.map((line) => line.trim())
		.find((line) => GIT_REVISION_RE.test(line));
	if (!revision) throw new Error("Git checkout returned no valid revision");
	return { branch, plaintext, remote, revision, root, sandbox, tokenFile };
}

function contentPath(site: DocsSite, path: string): string {
	return site.contentRoot === "." ? path : `${site.contentRoot}/${path}`;
}

export async function listDocsFiles(
	env: AppBindings,
	site: DocsSite,
): Promise<{ files: string[]; revision: string }> {
	const operationId = crypto.randomUUID();
	const checked = await checkout(env, site, operationId, { write: false });
	const prefix = site.contentRoot === "." ? "." : site.contentRoot;
	const listed = await (
		await checked.sandbox.exec([
			"bash",
			"-lc",
			`bash -lc ${shellQuote(
				`git -C ${shellQuote(checked.root)} ls-files -- ${shellQuote(prefix)}`,
			)}`,
		])
	).output({ encoding: "utf8", maxBytes: 16 * 1024 * 1024 });
	if (
		listed.exitCode !== 0 ||
		listed.timedOut ||
		listed.signal !== undefined ||
		listed.truncated
	)
		throw new Error("Unable to list documentation files");
	const contentPrefix = site.contentRoot === "." ? "" : `${site.contentRoot}/`;
	const files = listed.stdout
		.split("\n")
		.map((path) => path.trim())
		.filter((path) => /\.(?:md|mdx)$/i.test(path))
		.map((path) =>
			contentPrefix && path.startsWith(contentPrefix)
				? path.slice(contentPrefix.length)
				: path,
		)
		.slice(0, MAX_LISTED_FILES);
	return { files, revision: checked.revision };
}

export async function getDocsFile(
	env: AppBindings,
	site: DocsSite,
	pathInput: string,
): Promise<{
	content: string;
	path: string;
	revision: string;
	contentSha256: string;
	byteLength: number;
}> {
	const path = assertDocsFilePath(pathInput);
	const operationId = crypto.randomUUID();
	const checked = await checkout(env, site, operationId, { write: false });
	const repoPath = contentPath(site, path);
	const read = await (
		await checked.sandbox.exec([
			"bash",
			"-lc",
			`bash -lc ${shellQuote(
				`git -C ${shellQuote(checked.root)} show ${shellQuote(checked.revision)}:${shellQuote(repoPath)}`,
			)}`,
		])
	).output({ encoding: "utf8", maxBytes: 16 * 1024 * 1024 });
	if (
		read.exitCode !== 0 ||
		read.timedOut ||
		read.signal !== undefined ||
		read.truncated
	)
		throw new Error("Documentation file not found");
	const evidence = await docsFileEvidence(read.stdout);
	if (evidence.byteLength > MAX_AUTHORING_FILE_BYTES) {
		throw new Error("Documentation file exceeds the authoring size limit");
	}
	return {
		content: read.stdout,
		path,
		revision: checked.revision,
		...evidence,
	};
}

export async function proposeDocsChange(
	env: AppBindings,
	site: DocsSite,
	input: {
		changeId: string;
		content: string;
		expectedRevision?: string;
		message: string;
		path: string;
	},
): Promise<{
	baseRevision: string;
	contentSha256: string;
	diff: string;
	proposalBranch: string;
	proposalRevision: string;
}> {
	const path = assertDocsFilePath(input.path);
	const bytes = new TextEncoder().encode(input.content).byteLength;
	if (bytes > MAX_AUTHORING_FILE_BYTES) {
		throw new Error(
			`Documentation content exceeds ${MAX_AUTHORING_FILE_BYTES} bytes`,
		);
	}
	if (!input.message.trim()) throw new Error("Change message is required");
	const checked = await checkout(env, site, input.changeId, { write: true });
	if (
		input.expectedRevision &&
		input.expectedRevision.toLowerCase() !== checked.revision.toLowerCase()
	) {
		throw new Error(
			`Repository revision changed; expected ${input.expectedRevision} but found ${checked.revision}`,
		);
	}
	const proposalBranch = assertBranch(`tedix/docs/${input.changeId}`);
	const stagedFile = `/tmp/tedix-docs-content-${input.changeId}`;
	await checked.sandbox.writeFile(stagedFile, input.content);
	await checked.sandbox.writeFile(checked.tokenFile, checked.plaintext);
	const repoPath = contentPath(site, path);
	const script = `set -eu
cd ${shellQuote(checked.root)}
git checkout -b ${shellQuote(proposalBranch)}
mkdir -p $(dirname ${shellQuote(repoPath)})
cp ${shellQuote(stagedFile)} ${shellQuote(repoPath)}
git add -- ${shellQuote(repoPath)}
git diff --cached --check
git diff --cached --quiet && { echo "Proposed content does not change the repository" >&2; exit 4; }
git config user.name "Tedix Docs"
git config user.email "docs@tedix.dev"
git commit -m ${shellQuote(input.message.trim())}
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=http.extraHeader
export GIT_CONFIG_VALUE_0="Authorization: Bearer $(cat ${shellQuote(checked.tokenFile)})"
git push origin HEAD:refs/heads/${shellQuote(proposalBranch)}
rm -f ${shellQuote(checked.tokenFile)} ${shellQuote(stagedFile)}
git rev-parse HEAD
git diff --no-ext-diff --unified=3 ${shellQuote(checked.revision)}..HEAD -- ${shellQuote(repoPath)}`;
	const pushed = await (
		await checked.sandbox.exec(["bash", "-lc", script], {
			timeout: 120_000,
		})
	).output({ encoding: "utf8", maxBytes: 16 * 1024 * 1024 });
	if (
		pushed.exitCode !== 0 ||
		pushed.timedOut ||
		pushed.signal !== undefined ||
		pushed.truncated
	) {
		throw new Error(
			`Unable to propose docs change: ${pushed.stderr.slice(-1600)}`,
		);
	}
	const lines = pushed.stdout.split("\n");
	const revisionIndex = lines.findIndex((line) =>
		GIT_REVISION_RE.test(line.trim()),
	);
	const proposalRevision =
		revisionIndex >= 0 ? lines[revisionIndex]?.trim() : undefined;
	if (!proposalRevision) throw new Error("Proposal returned no valid revision");
	return {
		baseRevision: checked.revision,
		contentSha256: await sha256(input.content),
		diff: trimDiff(lines.slice(revisionIndex + 1).join("\n")),
		proposalBranch,
		proposalRevision,
	};
}

export async function getDocsDiff(
	env: AppBindings,
	site: DocsSite,
	change: DocsChange,
): Promise<{ diff: string }> {
	const checked = await checkout(env, site, crypto.randomUUID(), {
		write: false,
	});
	await checked.sandbox.writeFile(checked.tokenFile, checked.plaintext);
	const repoPath = contentPath(site, change.path);
	const script = `set -eu
cd ${shellQuote(checked.root)}
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=http.extraHeader
export GIT_CONFIG_VALUE_0="Authorization: Bearer $(cat ${shellQuote(checked.tokenFile)})"
git fetch origin ${shellQuote(change.proposalBranch)}
rm -f ${shellQuote(checked.tokenFile)}
test "$(git rev-parse FETCH_HEAD)" = ${shellQuote(change.proposalRevision)}
git diff --no-ext-diff --unified=3 ${shellQuote(change.baseRevision)}..${shellQuote(change.proposalRevision)} -- ${shellQuote(repoPath)}`;
	const diff = await (
		await checked.sandbox.exec(["bash", "-lc", script], {
			timeout: 120_000,
		})
	).output({ encoding: "utf8", maxBytes: 16 * 1024 * 1024 });
	if (
		diff.exitCode !== 0 ||
		diff.timedOut ||
		diff.signal !== undefined ||
		diff.truncated
	) {
		throw new Error(`Unable to read docs diff: ${diff.stderr.slice(-1200)}`);
	}
	return { diff: trimDiff(diff.stdout) };
}

export async function commitDocsChange(
	env: AppBindings,
	site: DocsSite,
	change: DocsChange,
): Promise<{ revision: string }> {
	if (change.status === "committed") {
		throw new Error("Documentation change is already committed");
	}
	if (change.status !== "validated") {
		throw new Error(
			"Documentation change must have a successful preview build",
		);
	}
	const checked = await checkout(env, site, crypto.randomUUID(), {
		write: true,
	});
	if (checked.revision !== change.baseRevision) {
		throw new Error(
			`The public branch advanced from ${change.baseRevision} to ${checked.revision}; create a new proposal against the current revision`,
		);
	}
	await checked.sandbox.writeFile(checked.tokenFile, checked.plaintext);
	const script = `set -eu
cd ${shellQuote(checked.root)}
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=http.extraHeader
export GIT_CONFIG_VALUE_0="Authorization: Bearer $(cat ${shellQuote(checked.tokenFile)})"
git fetch origin ${shellQuote(change.proposalBranch)}
test "$(git rev-parse FETCH_HEAD)" = ${shellQuote(change.proposalRevision)}
git merge-base --is-ancestor ${shellQuote(change.baseRevision)} ${shellQuote(change.proposalRevision)}
git push origin ${shellQuote(change.proposalRevision)}:refs/heads/${shellQuote(checked.branch)}
rm -f ${shellQuote(checked.tokenFile)}
printf '%s\\n' ${shellQuote(change.proposalRevision)}`;
	const pushed = await (
		await checked.sandbox.exec(["bash", "-lc", script], {
			timeout: 120_000,
		})
	).output({ encoding: "utf8", maxBytes: 16 * 1024 * 1024 });
	if (
		pushed.exitCode !== 0 ||
		pushed.timedOut ||
		pushed.signal !== undefined ||
		pushed.truncated
	) {
		throw new Error(
			`Unable to commit docs change: ${pushed.stderr.slice(-1600)}`,
		);
	}
	return { revision: change.proposalRevision };
}
