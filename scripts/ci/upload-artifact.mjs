import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * A workflow artifact upload a `run:` step performs itself. Every step's
 * environment already carries the results-service coordinates
 * (ACTIONS_RESULTS_URL + ACTIONS_RUNTIME_TOKEN) that upload-artifact uses,
 * so a script can preserve files as a bounded artifact without a workflow
 * step. rerun-on-infrastructure.mjs calls this when a browser shard fails;
 * a missing service or an empty directory is a no-op.
 */

// Mirrored from apps/os/browser-tests/failure-evidence.ts — this file runs
// under node, which cannot import the spec-side TypeScript module.
export const evidenceDirVariable = "TEDIX_BROWSER_EVIDENCE_DIR";
export const shardEvidenceDir = "browser-tests/.cache";
const retentionDays = 14;

/** @param {Record<string, string | undefined>} env */
export function artifactService(env) {
	const url = env.ACTIONS_RESULTS_URL;
	const token = env.ACTIONS_RUNTIME_TOKEN;
	if (!url || !token) return undefined;
	return { url: url.endsWith("/") ? url : `${url}/`, token };
}

/**
 * Slash-free, unique-per-matrix-cell name for a shard's diagnostics.
 * @param {Record<string, string | undefined>} env
 * @param {string} [prefix]
 */
export function shardArtifactName(env, prefix = "browser-diagnostics") {
	return [
		prefix,
		env.WORKSPACE ?? "workspace",
		env.TEST_SCRIPT || "test",
		env.TEST_SHARD || "all",
		`a${env.GITHUB_RUN_ATTEMPT || "1"}`,
	]
		.join("-")
		.replace(/[^A-Za-z0-9._-]+/g, "-");
}

async function artifactRequest({ url, token }, method, body, fetchImpl) {
	const response = await fetchImpl(
		`${url}twirp/github.actions.results.api.v1.ArtifactService/${method}`,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		},
	);
	if (!response.ok)
		throw new Error(`ArtifactService.${method} answered ${response.status}`);
	return response.json();
}

function zipDirectory(dir, archive) {
	const result = spawnSync("zip", ["-qr", archive, "."], { cwd: dir });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`zip exited ${result.status}`);
	return archive;
}

/**
 * @param {object} input
 * @param {string} input.dir evidence directory, workspace-relative or absolute
 * @param {string} input.name artifact name
 * @param {Record<string, string | undefined>} input.env
 * @param {typeof fetch} [input.fetchImpl]
 * @param {(dir: string, archive: string) => unknown} [input.zip]
 */
export async function uploadEvidenceArtifact({
	dir,
	name,
	env,
	fetchImpl = fetch,
	zip = zipDirectory,
}) {
	const service = artifactService(env);
	if (!service) return { uploaded: false, reason: "no artifact service" };
	if (!existsSync(dir) || readdirSync(dir).length === 0)
		return { uploaded: false, reason: "no evidence" };
	const staging = mkdtempSync(join(tmpdir(), "browser-evidence-"));
	try {
		const archive = join(staging, `${name}.zip`);
		await zip(dir, archive);
		const size = statSync(archive).size;
		const created = await artifactRequest(
			service,
			"CreateArtifact",
			{
				name,
				version: 4,
				expiresAt: new Date(
					Date.now() + retentionDays * 86_400_000,
				).toISOString(),
			},
			fetchImpl,
		);
		if (!created.signedUploadUrl)
			throw new Error("CreateArtifact returned no upload URL");
		const upload = await fetchImpl(created.signedUploadUrl, {
			method: "PUT",
			headers: {
				"content-type": "application/octet-stream",
				"content-length": String(size),
				"x-ms-blob-type": "BlockBlob",
			},
			body: readFileSync(archive),
		});
		if (!upload.ok)
			throw new Error(`artifact upload answered ${upload.status}`);
		const finalized = await artifactRequest(
			service,
			"FinalizeArtifact",
			{ name, size },
			fetchImpl,
		);
		return { uploaded: true, artifactId: finalized.artifactId, name, size };
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

/**
 * Never throws: a diagnostics upload must not change the shard's outcome.
 * @param {Record<string, string | undefined>} env
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {(dir: string, archive: string) => unknown} [deps.zip]
 */
export async function uploadShardEvidence(env, deps = {}) {
	try {
		const result = await uploadEvidenceArtifact({
			dir: resolve(
				env.WORKSPACE ?? ".",
				env[evidenceDirVariable] || shardEvidenceDir,
			),
			name: shardArtifactName(env),
			env,
			...deps,
		});
		if (!result.uploaded && result.reason !== "no artifact service")
			console.error(`[evidence] artifact upload skipped: ${result.reason}`);
		return result;
	} catch (error) {
		console.error(`[evidence] artifact upload failed: ${error}`);
		return { uploaded: false, reason: String(error) };
	}
}
