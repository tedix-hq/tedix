import { createHash, randomUUID } from "node:crypto";
import {
	link,
	lstat,
	mkdtemp,
	mkdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	PortableTediGitReadAccessOutputSchema,
	PortableTediImportBeginOutputSchema,
	PortableTediManifestSchema,
	PortableTediSnapshotSectionSchema,
	PortableTediSnapshotPageOutputSchema,
	type PortableTediManifest,
} from "@tedix/api-contract/schemas/portable-tedi";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import {
	parsePortableTediImportSnapshot,
	verifyPortableTediSnapshotFiles,
} from "@tedix/api-contract/utils/portable-tedi";
import { normalizeCodeResult, truncationErrorMessage } from "./code-result";
import type { TedixHomeClient } from "./home-client";

const PORTABLE_DIR = ".tedix-portable";
const CREDENTIAL_PATTERN =
	/-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----|\b(?:sk_|ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_-]{24,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{24,}\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:password|client_secret|api_key|access_token)\s*[:=]\s*[^\s]{8,}/i;

type Section = (typeof PortableTediSnapshotSectionSchema.options)[number];
type GitAccess = ReturnType<typeof PortableTediGitReadAccessOutputSchema.parse>;
type ImportAccess = ReturnType<
	typeof PortableTediImportBeginOutputSchema.parse
>;

function portableGatewayValue(raw: unknown): unknown {
	const normalized = normalizeCodeResult(raw);
	if (normalized.truncated) {
		throw new Error(truncationErrorMessage(normalized));
	}
	const value = normalized.value;
	if (isRecord(value) && value.ok === false) {
		const detail = value.error;
		const message =
			typeof detail === "string"
				? detail
				: isRecord(detail) && typeof detail.message === "string"
					? detail.message
					: "Portable tedi gateway call failed";
		throw new Error(message);
	}
	return value;
}

export interface PortableTediSource {
	gitAccess(tediId: string): Promise<GitAccess>;
	readPage(input: {
		access: GitAccess;
		tediId: string;
		section: Section;
		afterId?: string;
	}): Promise<{ text: string; nextAfterId: string | null; rowCount: number }>;
}

export interface PortableTediDestination {
	begin(
		manifest: PortableTediManifest,
		destinationSlug: string,
	): Promise<ImportAccess>;
	upload(input: {
		access: ImportAccess;
		section: Section | "skillLinks";
		rows: unknown[];
	}): Promise<void>;
	verify(input: {
		tediId: string;
		manifest: PortableTediManifest;
	}): Promise<void>;
}

export function gatewayPortableTediDestination(
	client: TedixHomeClient,
): PortableTediDestination {
	const readback = gatewayPortableTediSource(client);
	return {
		async begin(manifest, destinationSlug) {
			const value = portableGatewayValue(
				await client.runCode(
					`async () => await tedis.portable_import_begin(${JSON.stringify({ manifest, destinationSlug })})`,
				),
			);
			if (!isRecord(value))
				throw new Error("Invalid portable import access result");
			const payload = { ...value };
			delete payload.completionEvidence;
			return PortableTediImportBeginOutputSchema.parse(payload);
		},
		async upload({ access, section, rows }) {
			const base = new URL(access.snapshot.url);
			if (
				base.pathname !== `/portable/tedis/${access.tediId}/import` ||
				base.username ||
				base.password ||
				base.search ||
				base.hash
			) {
				throw new Error("Portable import URL does not match the destination");
			}
			const url = new URL(`${base.pathname}/${section}`, base.origin);
			const response = await fetch(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${access.snapshot.token}`,
					"X-Tedix-Portable-Manifest": access.manifestSha256,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ section, rows }),
				redirect: "error",
			});
			if (!response.ok) {
				throw new Error(`Portable import ${section} HTTP ${response.status}`);
			}
			const receipt = (await response.json()) as unknown;
			if (!isRecord(receipt) || receipt.acceptedRows !== rows.length) {
				throw new Error(`Portable import ${section} receipt mismatch`);
			}
		},
		async verify({ tediId, manifest }) {
			const access = await readback.gitAccess(tediId);
			if (
				access.identity.name !== manifest.identity.name ||
				access.identity.avatar !== manifest.identity.avatar ||
				JSON.stringify(access.identity.installedSkills) !==
					JSON.stringify(manifest.identity.installedSkills) ||
				access.identity.installedPlugins.length !== 0 ||
				access.bindings.apps.length !== 0
			) {
				throw new Error("Portable destination identity or grants mismatch");
			}
			for (const { section } of SECTIONS) {
				let afterId: string | undefined;
				let observed = 0;
				for (let pageIndex = 0; pageIndex < 10_000; pageIndex++) {
					const page = await readback.readPage({
						access,
						tediId,
						section,
						afterId,
					});
					observed += page.rowCount;
					if (!page.nextAfterId) break;
					if (page.nextAfterId === afterId || pageIndex === 9_999) {
						throw new Error(
							`Portable destination ${section} cursor did not advance`,
						);
					}
					afterId = page.nextAfterId;
				}
				if (observed !== manifest.files[section].count) {
					throw new Error(`Portable destination ${section} count mismatch`);
				}
			}
		},
	};
}

/** Code Mode authorizes the transfer; bounded bulk pages use its signed URL. */
export function gatewayPortableTediSource(
	client: TedixHomeClient,
): PortableTediSource {
	async function runGatewayCode(code: string): Promise<unknown> {
		for (let attempt = 0; attempt < 4; attempt++) {
			try {
				return await client.runCode(code);
			} catch (error) {
				const message = String(error);
				if (
					attempt === 3 ||
					!/Rate limit exceeded|Too many requests/i.test(message)
				) {
					throw error;
				}
				const retryAfter = /"retryAfter":(\d+)/.exec(message);
				const seconds = retryAfter ? Number(retryAfter[1]) : 60;
				await Bun.sleep(Math.min(120, Math.max(1, seconds)) * 1000);
			}
		}
		throw new Error("Portable snapshot gateway retry exhausted");
	}
	return {
		async gitAccess(tediId) {
			const value = portableGatewayValue(
				await runGatewayCode(
					`async () => await tedis.portable_git_read_access({tediId:${JSON.stringify(tediId)}})`,
				),
			);
			if (!isRecord(value))
				throw new Error("Invalid portable Git access result");
			// Code Mode attaches its receipt to tool results; it is not bundle data.
			const payload = { ...value };
			delete payload.completionEvidence;
			return PortableTediGitReadAccessOutputSchema.parse(payload);
		},
		async readPage({ access, tediId, section, afterId }) {
			const base = new URL(access.snapshot.url);
			if (
				base.pathname !== `/portable/tedis/${tediId}/snapshot` ||
				base.username ||
				base.password ||
				base.search ||
				base.hash
			) {
				throw new Error("Portable snapshot URL does not match the tedi");
			}
			const url = new URL(`${base.pathname}/${section}`, base.origin);
			url.searchParams.set("limit", "500");
			if (afterId) url.searchParams.set("afterId", afterId);
			const response = await fetch(url, {
				headers: { Authorization: `Bearer ${access.snapshot.token}` },
				redirect: "error",
			});
			if (!response.ok) {
				throw new Error(`Portable snapshot ${section} HTTP ${response.status}`);
			}
			const page = PortableTediSnapshotPageOutputSchema.parse(
				await response.json(),
			);
			if (page.section !== section) {
				throw new Error(`Portable snapshot ${section} response mismatch`);
			}
			return {
				text: page.rows.map((row) => JSON.stringify(row)).join("\n"),
				nextAfterId: page.nextAfterId,
				rowCount: page.rows.length,
			};
		},
	};
}
const SECTIONS: ReadonlyArray<{ section: Section; path: string }> = [
	{ section: "memoryDomains", path: "snapshot/memory-domains.ndjson" },
	{ section: "memoryFacts", path: "snapshot/memory-facts.ndjson" },
	{ section: "memoryEdges", path: "snapshot/memory-edges.ndjson" },
	{ section: "skills", path: "snapshot/skills.ndjson" },
	{ section: "rationale", path: "snapshot/rationale.ndjson" },
];

async function runGit(
	args: string[],
	options: { env?: Record<string, string | undefined>; token?: string } = {},
): Promise<string> {
	const child = Bun.spawn(["git", ...args], {
		env: options.env ?? process.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exit !== 0) {
		const safeError = options.token
			? stderr.replaceAll(options.token, "[redacted]")
			: stderr;
		throw new Error(`Git ${args[0]} failed: ${safeError.slice(0, 1200)}`);
	}
	return stdout.trim();
}

function gitBearerEnv(token: string): Record<string, string | undefined> {
	return {
		...process.env,
		// Command-local config keeps the token out of argv, URLs, and .git/config.
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "http.extraHeader",
		GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
		GIT_TERMINAL_PROMPT: "0",
	};
}

async function snapshotSection(
	source: PortableTediSource,
	access: GitAccess,
	tediId: string,
	section: Section,
): Promise<{ bytes: Uint8Array; count: number }> {
	const pages: string[] = [];
	let count = 0;
	let afterId: string | undefined;
	for (let pageNumber = 0; pageNumber < 10_000; pageNumber++) {
		const page = await source.readPage({ access, tediId, section, afterId });
		if (page.rowCount === 0) {
			if (page.nextAfterId || page.text) {
				throw new Error(`Invalid empty portable ${section} page`);
			}
			const text = pages.join("\n");
			return {
				bytes: new TextEncoder().encode(text ? `${text}\n` : ""),
				count,
			};
		}
		if (!page.text || page.rowCount > 500) {
			throw new Error(`Invalid portable ${section} page`);
		}
		pages.push(page.text);
		count += page.rowCount;
		if (!page.nextAfterId) {
			const text = pages.join("\n");
			return { bytes: new TextEncoder().encode(`${text}\n`), count };
		}
		if (page.nextAfterId === afterId) {
			throw new Error(`Portable ${section} cursor did not advance`);
		}
		afterId = page.nextAfterId;
	}
	throw new Error(`Portable ${section} snapshot exceeded the page limit`);
}

async function snapshotAll(
	source: PortableTediSource,
	access: GitAccess,
	tediId: string,
) {
	const files: Record<string, Uint8Array> = {};
	const entries: Record<
		string,
		{ path: string; sha256: string; count: number }
	> = {};
	for (const { section, path } of SECTIONS) {
		const { bytes, count } = await snapshotSection(
			source,
			access,
			tediId,
			section,
		);
		files[path] = bytes;
		entries[section] = {
			path,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			count,
		};
	}
	return { files, entries };
}

/** A second complete read catches mutation during pagination; retry at the operator level. */
async function stableSnapshot(
	source: PortableTediSource,
	access: GitAccess,
	tediId: string,
) {
	const first = await snapshotAll(source, access, tediId);
	const second = await snapshotAll(source, access, tediId);
	for (const { section } of SECTIONS) {
		if (first.entries[section]?.sha256 !== second.entries[section]?.sha256) {
			throw new Error(`Portable ${section} changed during export; retry`);
		}
	}
	return first;
}

/** Scan source Git objects in bounded chunks, including historical commits and tags. */
async function rejectCredentialObject(
	repoDir: string,
	oid: string,
	type: string,
) {
	const child = Bun.spawn(["git", "-C", repoDir, "cat-file", type, oid], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const errorText = new Response(child.stderr).text();
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let tail = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const text = tail + decoder.decode(value, { stream: true });
			if (CREDENTIAL_PATTERN.test(text)) {
				throw new Error(
					`Artifacts Git contains credential-shaped content in ${type} ${oid}`,
				);
			}
			tail = text.slice(-256);
		}
		if (CREDENTIAL_PATTERN.test(tail + decoder.decode())) {
			throw new Error(
				`Artifacts Git contains credential-shaped content in ${type} ${oid}`,
			);
		}
		if ((await child.exited) !== 0) {
			throw new Error(
				`Git cat-file failed: ${(await errorText).slice(0, 300)}`,
			);
		}
	} finally {
		child.kill();
		reader.releaseLock();
	}
}

/** Scan all objects before adding the already validated, potentially large snapshot. */
async function rejectCredentialHistory(repoDir: string): Promise<void> {
	const objects = await runGit([
		"-C",
		repoDir,
		"cat-file",
		"--batch-all-objects",
		"--batch-check=%(objectname) %(objecttype) %(objectsize)",
	]);
	for (const line of objects.split("\n")) {
		const [oid, type] = line.split(" ");
		if (!oid || !type || !["blob", "commit", "tag", "tree"].includes(type))
			continue;
		await rejectCredentialObject(repoDir, oid, type);
	}
}

export async function exportPortableTedi(options: {
	tediId: string;
	outputPath: string;
	source: PortableTediSource;
}): Promise<{
	bundlePath: string;
	sourceHead: string | null;
	snapshotRows: number;
}> {
	const outputPath = resolve(options.outputPath);
	const access = await options.source.gitAccess(options.tediId);
	const scratch = await mkdtemp(join(tmpdir(), "tedix-portable-"));
	const repoDir = join(scratch, "repo");
	const verificationDir = join(scratch, "verification");
	const bundlePath = `${outputPath}.pending-${randomUUID()}`;
	try {
		let sourceHead: string | null = null;
		if (access.repoFound) {
			await runGit(["clone", "--no-single-branch", access.remote, repoDir], {
				token: access.token,
				env: gitBearerEnv(access.token),
			});
			let refs = "";
			try {
				refs = await runGit(["-C", repoDir, "show-ref"]);
			} catch {
				// A newly created Artifacts repo can have no commits yet.
			}
			if (refs) {
				sourceHead = await runGit([
					"-C",
					repoDir,
					"rev-parse",
					"refs/remotes/origin/main",
				]);
				await runGit(["-C", repoDir, "checkout", "--detach", sourceHead]);
			}
		} else {
			await mkdir(repoDir);
			await runGit(["-C", repoDir, "init", "-b", "main"]);
		}
		await rejectCredentialHistory(repoDir);
		const snapshot = await stableSnapshot(
			options.source,
			access,
			options.tediId,
		);
		const manifest: PortableTediManifest = PortableTediManifestSchema.parse({
			format: "tedix-tedi-git-bundle",
			version: 1,
			exportedAt: new Date().toISOString(),
			sourceTediId: options.tediId,
			identity: access.identity,
			bindings: access.bindings,
			artifacts: { defaultBranch: "main", head: sourceHead },
			files: snapshot.entries,
		});
		await verifyPortableTediSnapshotFiles(manifest, snapshot.files);
		const payloadDir = join(repoDir, PORTABLE_DIR);
		try {
			await lstat(payloadDir);
			throw new Error(
				"Artifacts Git already contains a portable export directory",
			);
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "ENOENT")
			) {
				throw error;
			}
		}
		await mkdir(join(payloadDir, "snapshot"), { recursive: true });
		for (const [path, bytes] of Object.entries(snapshot.files)) {
			await writeFile(join(payloadDir, path), bytes);
		}
		await writeFile(
			join(payloadDir, "manifest.json"),
			`${JSON.stringify(manifest, null, 2)}\n`,
		);
		await runGit(["-C", repoDir, "add", PORTABLE_DIR]);
		await runGit([
			"-C",
			repoDir,
			"-c",
			"user.name=Tedix Portable Export",
			"-c",
			"user.email=portable-export@tedix.dev",
			"commit",
			"-m",
			"Portable tedi snapshot",
		]);
		await runGit(["-C", repoDir, "branch", "portable-export", "HEAD"]);
		await runGit(["-C", repoDir, "switch", "portable-export"]);
		await mkdir(dirname(outputPath), { recursive: true });
		await runGit(["-C", repoDir, "bundle", "create", bundlePath, "--all"]);
		await runGit(["-C", repoDir, "bundle", "verify", bundlePath]);
		await runGit(["clone", bundlePath, verificationDir]);
		const bundleManifest = JSON.parse(
			await readFile(
				join(verificationDir, PORTABLE_DIR, "manifest.json"),
				"utf8",
			),
		) as unknown;
		const bundleFiles: Record<string, Uint8Array> = {};
		for (const { path } of SECTIONS) {
			bundleFiles[path] = await readFile(
				join(verificationDir, PORTABLE_DIR, path),
			);
		}
		await verifyPortableTediSnapshotFiles(bundleManifest, bundleFiles);
		await link(bundlePath, outputPath);
		return {
			bundlePath: outputPath,
			sourceHead,
			snapshotRows: Object.values(snapshot.entries).reduce(
				(sum, entry) => sum + entry.count,
				0,
			),
		};
	} finally {
		await rm(scratch, { recursive: true, force: true });
		await rm(bundlePath, { force: true });
	}
}

async function readRegularFile(path: string): Promise<Uint8Array> {
	const info = await lstat(path);
	if (!info.isFile()) throw new Error("Portable bundle payload is not a file");
	return readFile(path);
}

/** Verify everything locally before creating a paused destination tedi. */
export async function importPortableTedi(options: {
	bundlePath: string;
	destinationSlug: string;
	destination: PortableTediDestination;
}): Promise<{
	tediId: string;
	sourceHead: string | null;
	importedRows: number;
	gitRestored: boolean;
	status: "paused";
}> {
	const scratch = await mkdtemp(join(tmpdir(), "tedix-portable-import-"));
	const repoDir = join(scratch, "repo");
	let destinationId: string | null = null;
	try {
		await runGit([
			"clone",
			"--no-single-branch",
			resolve(options.bundlePath),
			repoDir,
		]);
		await runGit([
			"-C",
			repoDir,
			"bundle",
			"verify",
			resolve(options.bundlePath),
		]);
		await rejectCredentialHistory(repoDir);
		const payloadDir = join(repoDir, PORTABLE_DIR);
		if (
			!(await lstat(payloadDir)).isDirectory() ||
			!(await lstat(join(payloadDir, "snapshot"))).isDirectory()
		) {
			throw new Error(
				"Portable bundle payload directories must be regular directories",
			);
		}
		const manifest = JSON.parse(
			new TextDecoder().decode(
				await readRegularFile(join(payloadDir, "manifest.json")),
			),
		) as unknown;
		const parsedManifest = PortableTediManifestSchema.parse(manifest);
		const files: Record<string, Uint8Array> = {};
		for (const { path } of Object.values(parsedManifest.files)) {
			files[path] = await readRegularFile(join(payloadDir, path));
		}
		const parsed = await parsePortableTediImportSnapshot(manifest, files);
		const sourceHead = parsed.manifest.artifacts.head;
		if (sourceHead) {
			await runGit([
				"-C",
				repoDir,
				"merge-base",
				"--is-ancestor",
				sourceHead,
				"HEAD",
			]);
		}
		const ordered: Array<{
			section: Section | "skillLinks";
			rows: unknown[];
		}> = [
			{ section: "memoryDomains", rows: parsed.rows.memoryDomains },
			{ section: "memoryFacts", rows: parsed.rows.memoryFacts },
			{ section: "memoryEdges", rows: parsed.rows.memoryEdges },
			{ section: "skills", rows: parsed.rows.skills },
			{ section: "rationale", rows: parsed.rows.rationale },
			{ section: "skillLinks", rows: parsed.rows.skills },
		];
		const maxRequestBytes = 32 * 1024 * 1024;
		for (const { rows } of ordered) {
			for (const row of rows) {
				if (Buffer.byteLength(JSON.stringify(row)) > maxRequestBytes - 128) {
					throw new Error("Portable snapshot row exceeds the import limit");
				}
			}
		}
		const access = await options.destination.begin(
			parsed.manifest,
			options.destinationSlug,
		);
		destinationId = access.tediId;
		const expectedDigest = createHash("sha256")
			.update(JSON.stringify(parsed.manifest))
			.digest("hex");
		if (access.manifestSha256 !== expectedDigest) {
			throw new Error("Portable import manifest digest mismatch");
		}
		for (const { section, rows } of ordered) {
			for (let start = 0; start < rows.length;) {
				let end = Math.min(start + 100, rows.length);
				while (
					end > start + 1 &&
					Buffer.byteLength(
						JSON.stringify({ section, rows: rows.slice(start, end) }),
					) >
						16 * 1024 * 1024
				) {
					end = start + Math.ceil((end - start) / 2);
				}
				await options.destination.upload({
					access,
					section,
					rows: rows.slice(start, end),
				});
				start = end;
			}
		}
		if (sourceHead) {
			await runGit([
				"-C",
				repoDir,
				"remote",
				"add",
				"destination",
				access.git.remote,
			]);
			await runGit(
				["-C", repoDir, "push", "destination", `${sourceHead}:refs/heads/main`],
				{ token: access.git.token, env: gitBearerEnv(access.git.token) },
			);
			const observed = await runGit(
				["-C", repoDir, "ls-remote", "destination", "refs/heads/main"],
				{ token: access.git.token, env: gitBearerEnv(access.git.token) },
			);
			if (!observed.startsWith(`${sourceHead}\trefs/heads/main`)) {
				throw new Error("Portable destination Git head mismatch");
			}
		}
		await options.destination.verify({
			tediId: access.tediId,
			manifest: parsed.manifest,
		});
		return {
			tediId: access.tediId,
			sourceHead,
			importedRows: Object.values(parsed.manifest.files).reduce(
				(sum, entry) => sum + entry.count,
				0,
			),
			gitRestored: Boolean(sourceHead),
			status: "paused",
		};
	} catch (error) {
		if (destinationId) {
			throw new Error(
				`Portable import into paused tedi ${destinationId} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		throw error;
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}
