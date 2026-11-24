import type { TreeEntry } from "isomorphic-git";
import { sendArtifactsCommit } from "@tedix/worker-kit/artifacts-git-push";
import { GitMemoryFs } from "@tedix/worker-kit/git-memory-fs";
import themeArtifactAuthor from "./theme-artifact-author.json";
import {
	findThemeArtifactFile,
	readThemeArtifactTree,
	readThemeArtifactTreeEntries,
} from "./theme-artifacts";

const branch = "main";
const maxPackBytes = 24 * 1024 * 1024;
const dir = "/theme";
const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const ARTIFACTS_ZERO_OID = "0".repeat(40);
export type ThemeArtifactFileChange =
	| { path: string; content: string }
	| { path: string; delete: true };

export type RepoCommitResult =
	| { committed: true; commit: string; branch: string; deletedPaths: string[] }
	| { committed: false; unchanged: true; commit: string }
	| { committed: false; conflict: true; remoteHead: string | null };

async function refHead(repo: ArtifactsRepo, ref: string) {
	const [commit] = await repo.log({ ref, limit: 1 });
	return commit && /^[a-f0-9]{40}$/.test(commit.hash) ? commit.hash : null;
}

async function mainHead(repo: ArtifactsRepo) {
	const head = await refHead(repo, branch);
	if (!head) throw new Error("Artifacts main branch unavailable");
	return head;
}

/**
 * Commit file changes on top of an arbitrary base commit and CAS-push them to
 * an arbitrary ref. Pass `baseCommit: null` plus `expectedOldOid` set to
 * ARTIFACTS_ZERO_OID to create a new ref (orphan root commit).
 */
export async function commitRepoFiles(input: {
	repo: ArtifactsRepo;
	remote: string;
	ref: string;
	targetRef?: string;
	baseCommit: string | null;
	expectedOldOid: string;
	files: ThemeArtifactFileChange[];
	message: string;
}): Promise<RepoCommitResult> {
	const { repo } = input;
	const resolveHead = () => refHead(repo, input.ref);
	const conflict = (remoteHead: string | null): RepoCommitResult => ({
		committed: false,
		conflict: true,
		remoteHead,
	});

	// Rebuild only directories on edited paths, preserving all other entry IDs and modes.
	const { default: git } = await import("isomorphic-git");
	const fs = new GitMemoryFs(32 * 1024 * 1024, 16_384);
	await git.init({ fs, dir, defaultBranch: input.ref });
	const objects = new Set<string>();
	async function updateTree(
		oldOid: string | undefined,
		files: ThemeArtifactFileChange[],
	) {
		const entries: TreeEntry[] = oldOid
			? (await readThemeArtifactTreeEntries(repo, oldOid)).map((entry) => {
					const mode = entry.mode === "040000" ? "40000" : entry.mode;
					return {
						path: entry.name,
						oid: entry.hash,
						mode,
						type:
							mode === "40000" ? "tree" : mode === "160000" ? "commit" : "blob",
					};
				})
			: [];
		if (oldOid && (await git.writeTree({ fs, dir, tree: entries })) !== oldOid)
			throw new Error("Artifacts tree cannot be reconstructed");

		const children = new Map<string, ThemeArtifactFileChange[]>();
		for (const change of files) {
			const { path } = change;
			const slash = path.indexOf("/");
			const name = slash === -1 ? path : path.slice(0, slash);
			const group = children.get(name) ?? [];
			group.push({
				...change,
				path: slash === -1 ? "" : path.slice(slash + 1),
			});
			children.set(name, group);
		}
		const updated = new Map(entries.map((entry) => [entry.path, entry]));
		for (const [name, group] of children) {
			const entry = updated.get(name);
			const file = group.find((change) => change.path === "");
			if (file) {
				if (
					group.length !== 1 ||
					(entry && !["100644", "100755"].includes(entry.mode))
				)
					throw new Error("Theme artifact destination is not a regular file");
				if ("delete" in file) {
					updated.delete(name);
					continue;
				}
				const oid = await git.writeBlob({
					fs,
					dir,
					blob: new TextEncoder().encode(file.content),
				});
				if (oid !== entry?.oid) objects.add(oid);
				updated.set(name, {
					path: name,
					mode: entry?.mode ?? "100644",
					type: "blob",
					oid,
				});
			} else {
				if (entry && entry.type !== "tree")
					throw new Error("Theme artifact parent is not a directory");
				const child = await updateTree(entry?.oid, group);
				if (child.empty && child.oid !== entry?.oid) updated.delete(name);
				else
					updated.set(name, {
						path: name,
						mode: "40000",
						type: "tree",
						oid: child.oid,
					});
			}
		}
		const oid = await git.writeTree({ fs, dir, tree: [...updated.values()] });
		if (oid !== oldOid) objects.add(oid);
		return { oid, empty: updated.size === 0 };
	}

	const baseTree = input.baseCommit
		? await readThemeArtifactTree(repo, input.baseCommit)
		: EMPTY_TREE_OID;
	const { oid: tree } = await updateTree(
		input.baseCommit ? baseTree : undefined,
		input.files,
	);
	if (tree === baseTree) {
		const current = await resolveHead();
		const expected =
			input.expectedOldOid === ARTIFACTS_ZERO_OID ? null : input.expectedOldOid;
		return current === expected
			? {
					committed: false,
					unchanged: true,
					commit: input.baseCommit ?? ARTIFACTS_ZERO_OID,
				}
			: conflict(current);
	}

	const author = {
		...themeArtifactAuthor,
		timestamp: Math.floor(Date.now() / 1000),
		timezoneOffset: 0,
	};
	const commit = await git.writeCommit({
		fs,
		dir,
		commit: {
			tree,
			parent: input.baseCommit ? [input.baseCommit] : [],
			message: input.message,
			author,
			committer: author,
		},
	});
	objects.add(commit);
	// Artifacts has rejected delta-packed reversals. packObjects sends full objects.
	const { packfile } = await git.packObjects({
		fs,
		dir,
		oids: [...objects],
		write: false,
	});
	if (!packfile) throw new Error("Unable to pack theme artifact changes");

	const token = await repo.createToken("write", 600);
	const sent = await sendArtifactsCommit({
		remote: input.remote,
		targetRef: input.targetRef ?? `refs/heads/${input.ref}`,
		expectedOldOid: input.expectedOldOid,
		commitOid: commit,
		pack: packfile,
		maxPackBytes,
		authorization: `Bearer ${await token.plaintext}`,
		deadlineAt: Date.now() + 20_000,
	});
	async function confirmedCommit() {
		const deletedPaths = input.files
			.filter((file) => "delete" in file)
			.map((file) => file.path);
		if (deletedPaths.length) {
			const root = await readThemeArtifactTree(repo, commit);
			if (root !== tree)
				throw new Error(`Artifacts tree was not confirmed at commit ${commit}`);
			for (const path of deletedPaths) {
				if (await findThemeArtifactFile(repo, root, path))
					throw new Error(
						`Artifacts deletion was not confirmed at commit ${commit}`,
					);
			}
		}
		return {
			committed: true as const,
			commit,
			branch: input.ref,
			deletedPaths,
		};
	}
	if (sent.kind === "acknowledged") return confirmedCommit();

	const current = await resolveHead();
	if (current === commit) return confirmedCommit();
	if (sent.kind === "rejected") {
		const expected =
			input.expectedOldOid === ARTIFACTS_ZERO_OID ? null : input.expectedOldOid;
		if (current !== expected) return conflict(current);
		throw new Error("Artifacts rejected the theme commit");
	}
	throw new Error(
		`Artifacts did not confirm theme commit ${commit}. Read ${input.ref} before retrying.`,
	);
}

export async function commitThemeArtifactFiles(input: {
	repo: ArtifactsRepo;
	remote: string;
	expectedHead: string;
	files: ThemeArtifactFileChange[];
	message: string;
}) {
	const { repo, expectedHead } = input;
	const head = await mainHead(repo);
	if (head !== expectedHead)
		return { committed: false, conflict: true, remoteHead: head };
	return commitRepoFiles({
		repo,
		remote: input.remote,
		ref: branch,
		baseCommit: expectedHead,
		expectedOldOid: expectedHead,
		files: input.files,
		message: input.message,
	});
}
