import type { TreeEntry } from "isomorphic-git";
import { RepositoryCandidateSelectedPathsSchema } from "@tedix/api-contract/schemas/repository-candidate";
import { repositoryCandidateContentError } from "@tedix/api-contract/utils/repository-candidate";
import { CandidateGitMemoryFs } from "./repository-candidate-git-fs";

export const CANDIDATE_GIT_LIMITS = {
	trees: 64,
	treeEntries: 1024,
	treeBytes: 64 * 1024,
	totalTreeBytes: 1024 * 1024,
	looseObjects: 137,
	rawObjectBytes: 1536 * 1024,
	storedBytes: 4 * 1024 * 1024,
	packBytes: 2 * 1024 * 1024,
	advertisementBytes: 64 * 1024,
	advertisedRefs: 512,
	responseBytes: 64 * 1024,
	totalMs: 30_000,
	httpMs: 10_000,
} as const;
const SHA = /^[a-f0-9]{40}$/;
const encoder = new TextEncoder();

export class CandidateGitError extends Error {
	constructor(readonly reason: string) {
		super(reason);
		this.name = "CandidateGitError";
	}
}
type GitPerson = {
	name: string;
	email: string;
	timestamp: number;
	timezoneOffset: number;
};
export type CandidateCommitRecipe = {
	message: string;
	author: GitPerson;
	committer: GitPerson;
};
export type CandidateCommitBuild = {
	unchanged: boolean;
	commitOid: string;
	treeOid: string;
	pack: Uint8Array;
	objectManifestDigest: string;
	counters: {
		treeCount: number;
		treeBytes: number;
		rawObjectBytes: number;
		looseObjectCount: number;
		storedBytes: number;
		packBytes: number;
	};
};
export type CandidateGitSendResult =
	| { kind: "acknowledged"; ref: string; oldOid: string; newOid: string }
	| { kind: "rejected"; reason: string }
	| { kind: "unknown"; reason: string };

function check(condition: unknown, reason: string): asserts condition {
	if (!condition) throw new CandidateGitError(reason);
}
function deadline(at: number) {
	check(Number.isFinite(at) && at > Date.now(), "candidate_git_deadline");
	return Math.min(at, Date.now() + CANDIDATE_GIT_LIMITS.totalMs);
}
function alive(at: number) {
	check(Date.now() < at, "candidate_git_deadline");
}
async function until<T>(promise: Promise<T>, at: number): Promise<T> {
	alive(at);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new CandidateGitError("candidate_git_deadline")),
					Math.max(1, at - Date.now()),
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
async function digest(text: string) {
	return [
		...new Uint8Array(
			await crypto.subtle.digest("SHA-256", encoder.encode(text)),
		),
	]
		.map((n) => n.toString(16).padStart(2, "0"))
		.join("");
}
function validateRecipe(recipe: CandidateCommitRecipe) {
	check(
		utf8Size(recipe.message, 8192, "candidate_git_commit_recipe") <= 8192 &&
			!recipe.message.includes("\0"),
		"candidate_git_commit_recipe",
	);
	for (const person of [recipe.author, recipe.committer])
		check(
			person.name.length > 0 &&
				person.name.length <= 128 &&
				!/[<>\r\n\0]/.test(person.name) &&
				/^[^<>\s\0]{1,128}@[^<>\s\0]{1,128}$/.test(person.email) &&
				Number.isSafeInteger(person.timestamp) &&
				person.timestamp >= 0 &&
				Number.isInteger(person.timezoneOffset) &&
				Math.abs(person.timezoneOffset) <= 840,
			"candidate_git_commit_recipe",
		);
}

function utf8Size(text: string, limit: number, reason: string): number {
	check(text.length <= limit, reason);
	let bytes = 0;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code < 0x80) bytes++;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff) {
			const low = text.charCodeAt(++index);
			check(low >= 0xdc00 && low <= 0xdfff, reason);
			bytes += 4;
		} else {
			check(code < 0xdc00 || code > 0xdfff, reason);
			bytes += 3;
		}
		check(bytes <= limit, reason);
	}
	return bytes;
}

export async function buildCandidateCommit(input: {
	baseCommitOid: string;
	baseTreeOid: string;
	frozenFiles: Record<string, string>;
	selectedEntries: Array<{ path: string; blobRevision: string; bytes: number }>;
	commitRecipe: CandidateCommitRecipe;
	readTree: (oid: string) => Promise<ArtifactsTreeEntry[] | null>;
	deadlineAt: number;
}): Promise<CandidateCommitBuild> {
	const at = deadline(input.deadlineAt);
	check(
		SHA.test(input.baseCommitOid) && SHA.test(input.baseTreeOid),
		"candidate_git_base",
	);
	const paths = input.selectedEntries.map((entry) => entry.path);
	check(
		RepositoryCandidateSelectedPathsSchema.safeParse(paths).success,
		"candidate_git_paths",
	);
	check(
		Object.keys(input.frozenFiles).length === paths.length,
		"candidate_git_content",
	);
	let contentBytes = 0;
	for (const text of Object.values(input.frozenFiles))
		contentBytes += utf8Size(text, 65536, "candidate_git_content");
	check(contentBytes <= 256 * 1024, "candidate_git_content");
	check(
		!repositoryCandidateContentError(input.frozenFiles, paths),
		"candidate_git_content",
	);
	check(
		input.selectedEntries.every(
			(entry) =>
				SHA.test(entry.blobRevision) &&
				Number.isInteger(entry.bytes) &&
				entry.bytes >= 0 &&
				entry.bytes <= 65536,
		),
		"candidate_git_selection",
	);
	validateRecipe(input.commitRecipe);
	const git = (await until(import("isomorphic-git"), at)).default;
	const fs = new CandidateGitMemoryFs(),
		dir = "/candidate";
	await until(git.init({ fs, dir, defaultBranch: "candidate" }), at);
	const objects = new Map<string, { type: string; bytes: number }>(),
		packObjects = new Set<string>();
	const trees = new Map<string, TreeEntry[]>();
	let treeBytes = 0,
		rawObjectBytes = 0;
	function preflightObject(size: number) {
		check(
			objects.size < CANDIDATE_GIT_LIMITS.looseObjects &&
				rawObjectBytes + size <= CANDIDATE_GIT_LIMITS.rawObjectBytes,
			"candidate_git_object_budget",
		);
	}
	function preflightTree(entries: TreeEntry[]) {
		let bytes = 0;
		for (const entry of entries)
			bytes +=
				entry.mode.length +
				1 +
				utf8Size(entry.path, 255, "candidate_git_tree_entry") +
				1 +
				20;
		check(
			bytes <= CANDIDATE_GIT_LIMITS.treeBytes &&
				treeBytes + bytes <= CANDIDATE_GIT_LIMITS.totalTreeBytes,
			"candidate_git_tree_budget",
		);
		preflightObject(bytes);
	}
	async function record(
		oid: string,
		type: "tree" | "blob" | "commit",
		include: boolean,
	) {
		if (!objects.has(oid)) {
			const result = await until(
				git.readObject({ fs, dir, oid, format: "content" }),
				at,
			);
			check(result.object instanceof Uint8Array, "candidate_git_object");
			const size = result.object.byteLength;
			check(
				objects.size < CANDIDATE_GIT_LIMITS.looseObjects &&
					rawObjectBytes + size <= CANDIDATE_GIT_LIMITS.rawObjectBytes,
				"candidate_git_object_budget",
			);
			if (type === "tree") {
				check(
					size <= CANDIDATE_GIT_LIMITS.treeBytes &&
						treeBytes + size <= CANDIDATE_GIT_LIMITS.totalTreeBytes,
					"candidate_git_tree_budget",
				);
				treeBytes += size;
			}
			objects.set(oid, { type, bytes: size });
			rawObjectBytes += size;
		}
		if (include) packObjects.add(oid);
	}
	async function originalTree(oid: string): Promise<TreeEntry[]> {
		const prior = trees.get(oid);
		if (prior) return prior;
		check(trees.size < CANDIDATE_GIT_LIMITS.trees, "candidate_git_tree_count");
		const entries = await until(input.readTree(oid), at);
		check(
			entries && entries.length <= CANDIDATE_GIT_LIMITS.treeEntries,
			"candidate_git_tree_entries",
		);
		const names = new Set<string>();
		const mapped: TreeEntry[] = entries.map((entry) => {
			check(
				entry.name.length > 0 &&
					utf8Size(entry.name, 255, "candidate_git_tree_entry") <= 255 &&
					!entry.name.includes("/") &&
					!entry.name.includes("\0") &&
					entry.name !== "." &&
					entry.name !== ".." &&
					!names.has(entry.name) &&
					SHA.test(entry.hash),
				"candidate_git_tree_entry",
			);
			names.add(entry.name);
			const mode = entry.mode === "040000" ? "40000" : entry.mode;
			const valid =
				(mode === "40000" && entry.type === "tree") ||
				(mode === "100644" && entry.type === "blob") ||
				(mode === "100755" && entry.type === "exec") ||
				(mode === "120000" && entry.type === "symlink") ||
				(mode === "160000" && entry.type === "gitlink");
			check(valid, "candidate_git_tree_mode");
			return {
				mode,
				path: entry.name,
				oid: entry.hash,
				type: mode === "40000" ? "tree" : mode === "160000" ? "commit" : "blob",
			};
		});
		preflightTree(mapped);
		const roundTrip = await until(git.writeTree({ fs, dir, tree: mapped }), at);
		check(roundTrip === oid, "candidate_git_tree_roundtrip");
		await record(oid, "tree", false);
		trees.set(oid, mapped);
		return mapped;
	}
	const selected = new Map(
		input.selectedEntries.map((entry) => [entry.path, entry]),
	);
	async function rebuild(
		oid: string,
		prefix: string,
		selectedPaths: string[],
	): Promise<string> {
		const original = await originalTree(oid),
			updated = original.map((entry) => ({ ...entry }));
		const groups = new Map<string, string[]>();
		for (const path of selectedPaths) {
			const name = path.slice(prefix.length).split("/")[0]!;
			groups.set(name, [...(groups.get(name) ?? []), path]);
		}
		for (const [name, children] of groups) {
			const entry = updated.find((item) => item.path === name);
			check(entry, "candidate_git_file_missing");
			const path = `${prefix}${name}`;
			if (children.length === 1 && children[0] === path) {
				check(
					entry.type === "blob" &&
						["100644", "100755"].includes(entry.mode) &&
						entry.oid === selected.get(path)?.blobRevision,
					"candidate_git_file_base",
				);
				preflightObject(
					utf8Size(input.frozenFiles[path]!, 65536, "candidate_git_content"),
				);
				const blob = await until(
					git.writeBlob({
						fs,
						dir,
						blob: encoder.encode(input.frozenFiles[path]!),
					}),
					at,
				);
				await record(blob, "blob", blob !== entry.oid);
				entry.oid = blob;
			} else {
				check(entry.type === "tree", "candidate_git_parent_type");
				entry.oid = await rebuild(entry.oid, `${path}/`, children);
			}
		}
		preflightTree(updated);
		const newOid = await until(git.writeTree({ fs, dir, tree: updated }), at);
		await record(newOid, "tree", newOid !== oid);
		return newOid;
	}
	const treeOid = await rebuild(input.baseTreeOid, "", paths);
	let commitOid = input.baseCommitOid,
		pack = new Uint8Array();
	if (treeOid !== input.baseTreeOid) {
		preflightObject(12 * 1024);
		commitOid = await until(
			git.writeCommit({
				fs,
				dir,
				commit: {
					...input.commitRecipe,
					tree: treeOid,
					parent: [input.baseCommitOid],
				},
			}),
			at,
		);
		await record(commitOid, "commit", true);
		const result = await until(
			git.packObjects({ fs, dir, oids: [...packObjects].sort(), write: false }),
			at,
		);
		check(
			result.packfile &&
				result.packfile.byteLength <= CANDIDATE_GIT_LIMITS.packBytes,
			"candidate_git_pack_budget",
		);
		pack = new Uint8Array(result.packfile);
	}
	alive(at);
	return {
		unchanged: treeOid === input.baseTreeOid,
		commitOid,
		treeOid,
		pack,
		objectManifestDigest: await digest(
			JSON.stringify(
				[...packObjects].sort().map((oid) => ({ oid, ...objects.get(oid)! })),
			),
		),
		counters: {
			treeCount: trees.size,
			treeBytes,
			rawObjectBytes,
			looseObjectCount: objects.size,
			storedBytes: fs.storedBytes,
			packBytes: pack.byteLength,
		},
	};
}

function validateDestination(remote: string, targetRef: string) {
	let url: URL;
	try {
		url = new URL(remote);
	} catch {
		throw new CandidateGitError("candidate_git_remote");
	}
	check(
		url.protocol === "https:" &&
			/^[a-f0-9]{32}\.artifacts\.cloudflare\.net$/.test(url.hostname) &&
			!url.port &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			/^\/git\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*\.git$/.test(
				url.pathname,
			),
		"candidate_git_remote",
	);
	check(
		/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(targetRef) &&
			!targetRef.includes("..") &&
			!targetRef.includes("//") &&
			!targetRef.endsWith("/") &&
			!targetRef.endsWith(".") &&
			!targetRef
				.split("/")
				.some((part) => part.endsWith(".lock") || part.startsWith(".")),
		"candidate_git_ref",
	);
	return url.toString();
}
function packet(text: string) {
	const bytes = encoder.encode(text);
	const prefix = encoder.encode(
		(bytes.byteLength + 4).toString(16).padStart(4, "0"),
	);
	const out = new Uint8Array(prefix.length + bytes.length);
	out.set(prefix);
	out.set(bytes, 4);
	return out;
}
function packets(bytes: Uint8Array): Array<string | null> {
	const result: Array<string | null> = [];
	let offset = 0;
	while (offset < bytes.length) {
		check(offset + 4 <= bytes.length, "candidate_git_packet");
		const prefix = new TextDecoder().decode(bytes.subarray(offset, offset + 4));
		check(/^[a-f0-9]{4}$/i.test(prefix), "candidate_git_packet");
		const length = Number.parseInt(prefix, 16);
		offset += 4;
		if (length === 0) {
			result.push(null);
			continue;
		}
		check(
			length >= 4 && length <= 65520 && offset + length - 4 <= bytes.length,
			"candidate_git_packet",
		);
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
				bytes.subarray(offset, offset + length - 4),
			);
		} catch {
			throw new CandidateGitError("candidate_git_packet");
		}
		result.push(text);
		offset += length - 4;
	}
	return result;
}
async function boundedBody(
	response: Response,
	limit: number,
	at: number,
): Promise<Uint8Array> {
	const length = response.headers.get("Content-Length");
	check(
		!length || (/^\d+$/.test(length) && Number(length) <= limit),
		"candidate_git_response_budget",
	);
	check(response.body, "candidate_git_response_missing");
	const reader = response.body.getReader();
	const parts: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const next = await until(reader.read(), at);
			if (next.done) break;
			size += next.value.byteLength;
			check(size <= limit, "candidate_git_response_budget");
			check(parts.length < 1024, "candidate_git_response_budget");
			parts.push(next.value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const part of parts) {
			bytes.set(part, offset);
			offset += part.byteLength;
		}
		return bytes;
	} catch (error) {
		void reader.cancel().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
}

export async function sendCandidateCommit(input: {
	remote: string;
	targetRef: string;
	expectedOldOid: string;
	commitOid: string;
	pack: Uint8Array;
	authorization: string;
	fetcher?: typeof fetch;
	deadlineAt: number;
	beforePost: () => Promise<void>;
}): Promise<CandidateGitSendResult> {
	const at = deadline(input.deadlineAt),
		remote = validateDestination(input.remote, input.targetRef);
	check(
		SHA.test(input.expectedOldOid) &&
			SHA.test(input.commitOid) &&
			input.commitOid !== input.expectedOldOid,
		"candidate_git_oids",
	);
	check(
		input.pack.byteLength >= 32 &&
			input.pack.byteLength <= CANDIDATE_GIT_LIMITS.packBytes &&
			new TextDecoder().decode(input.pack.subarray(0, 4)) === "PACK",
		"candidate_git_pack",
	);
	check(
		input.authorization.startsWith("Bearer ") &&
			input.authorization.length <= 512 &&
			!/[\r\n\0]/.test(input.authorization),
		"candidate_git_authorization",
	);
	const fetcher = input.fetcher ?? fetch;
	async function request(path: string, init: RequestInit) {
		const controller = new AbortController();
		const end = Math.min(at, Date.now() + CANDIDATE_GIT_LIMITS.httpMs);
		const timer = setTimeout(
			() => controller.abort(),
			Math.max(1, end - Date.now()),
		);
		try {
			const response = await until(
				fetcher(`${remote}${path}`, {
					...init,
					redirect: "manual",
					signal: controller.signal,
					headers: { ...init.headers, Authorization: input.authorization },
				}),
				end,
			);
			check(response.status === 200, "candidate_git_http_status");
			return { response, end, timer, controller };
		} catch {
			clearTimeout(timer);
			controller.abort();
			throw new CandidateGitError("candidate_git_http");
		}
	}
	const advertised = await request("/info/refs?service=git-receive-pack", {
		method: "GET",
		headers: { Accept: "application/x-git-receive-pack-advertisement" },
	});
	let lines: Array<string | null>;
	try {
		check(
			advertised.response.headers.get("Content-Type")?.split(";")[0]?.trim() ===
				"application/x-git-receive-pack-advertisement",
			"candidate_git_advertisement_type",
		);
		lines = packets(
			await boundedBody(
				advertised.response,
				CANDIDATE_GIT_LIMITS.advertisementBytes,
				advertised.end,
			),
		);
	} finally {
		clearTimeout(advertised.timer);
		advertised.controller.abort();
	}
	check(
		lines.length >= 4 &&
			lines[0] === "# service=git-receive-pack\n" &&
			lines[1] === null &&
			lines.at(-1) === null,
		"candidate_git_advertisement",
	);
	const refs = new Map<string, string>();
	let capabilities: string[] = [];
	for (let index = 2; index < lines.length - 1; index++) {
		const line = lines[index];
		check(typeof line === "string", "candidate_git_advertisement");
		const parts = line.replace(/\n$/, "").split("\0");
		check(
			parts.length === (index === 2 ? 2 : 1),
			"candidate_git_advertisement",
		);
		if (index === 2) capabilities = parts[1]!.split(" ");
		const match = /^([a-f0-9]{40}) (refs\/[A-Za-z0-9._/-]+)$/.exec(parts[0]!);
		check(
			match &&
				!refs.has(match[2]!) &&
				refs.size < CANDIDATE_GIT_LIMITS.advertisedRefs,
			"candidate_git_advertisement_ref",
		);
		refs.set(match[2]!, match[1]!);
	}
	check(
		capabilities.includes("report-status"),
		"candidate_git_report_status_required",
	);
	if (refs.get(input.targetRef) !== input.expectedOldOid)
		return { kind: "rejected", reason: "candidate_git_base_changed" };
	const update = packet(
		`${input.expectedOldOid} ${input.commitOid} ${input.targetRef}\0report-status\n`,
	);
	const body = new Uint8Array(update.length + 4 + input.pack.length);
	body.set(update);
	body.set(encoder.encode("0000"), update.length);
	body.set(input.pack, update.length + 4);
	alive(at);
	await until(input.beforePost(), at);
	alive(at);
	try {
		const sent = await request("/git-receive-pack", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-git-receive-pack-request",
				Accept: "application/x-git-receive-pack-result",
			},
			body,
		});
		try {
			check(
				sent.response.headers.get("Content-Type")?.split(";")[0]?.trim() ===
					"application/x-git-receive-pack-result",
				"candidate_git_result_type",
			);
			const status = packets(
				await boundedBody(
					sent.response,
					CANDIDATE_GIT_LIMITS.responseBytes,
					sent.end,
				),
			);
			check(status.length === 3 && status[2] === null, "candidate_git_status");
			check(
				typeof status[0] === "string" &&
					/^unpack [^\0\r\n]+\n$/.test(status[0]),
				"candidate_git_status",
			);
			const denied =
				typeof status[1] === "string" &&
				status[1].startsWith(`ng ${input.targetRef} `) &&
				/^ng [^\0\r\n]+\n$/.test(status[1]);
			if (status[0] !== "unpack ok\n") {
				check(denied, "candidate_git_status");
				return { kind: "rejected", reason: "candidate_git_unpack_rejected" };
			}
			if (status[1] === `ok ${input.targetRef}\n`)
				return {
					kind: "acknowledged",
					ref: input.targetRef,
					oldOid: input.expectedOldOid,
					newOid: input.commitOid,
				};
			check(denied, "candidate_git_status");
			return { kind: "rejected", reason: "candidate_git_ref_rejected" };
		} finally {
			clearTimeout(sent.timer);
			sent.controller.abort();
		}
	} catch {
		return { kind: "unknown", reason: "candidate_git_publication_unknown" };
	}
}
