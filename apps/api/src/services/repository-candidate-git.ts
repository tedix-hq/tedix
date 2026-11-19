import type { TreeEntry } from "isomorphic-git";
import { RepositoryCandidateSelectedPathsSchema } from "@tedix/api-contract/schemas/repository-candidate";
import { repositoryCandidateContentError } from "@tedix/api-contract/utils/repository-candidate";
import { GitMemoryFs as CandidateGitMemoryFs } from "@tedix/worker-kit/git-memory-fs";
import {
	ArtifactsGitError,
	sendArtifactsCommit,
} from "@tedix/worker-kit/artifacts-git-push";

export const CANDIDATE_GIT_LIMITS = {
	trees: 64,
	treeEntries: 1024,
	treeBytes: 64 * 1024,
	totalTreeBytes: 1024 * 1024,
	looseObjects: 137,
	rawObjectBytes: 1536 * 1024,
	storedBytes: 4 * 1024 * 1024,
	packBytes: 2 * 1024 * 1024,
	totalMs: 30_000,
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

export async function sendCandidateCommit(
	input: Omit<
		Parameters<typeof sendArtifactsCommit>[0],
		"maxPackBytes" | "beforePost"
	> & {
		beforePost: () => Promise<void>;
	},
) {
	try {
		const result = await sendArtifactsCommit({
			...input,
			maxPackBytes: CANDIDATE_GIT_LIMITS.packBytes,
		});
		return result.kind === "acknowledged"
			? result
			: { ...result, reason: `candidate_git_${result.reason}` };
	} catch (error) {
		if (error instanceof ArtifactsGitError)
			throw new CandidateGitError(`candidate_git_${error.reason}`);
		throw error;
	}
}
