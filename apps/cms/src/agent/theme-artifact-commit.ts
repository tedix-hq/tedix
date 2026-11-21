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
export type ThemeArtifactFileChange =
	| { path: string; content: string }
	| { path: string; delete: true };

async function mainHead(repo: ArtifactsRepo) {
	const [commit] = await repo.log({ ref: branch, limit: 1 });
	if (!commit || !/^[a-f0-9]{40}$/.test(commit.hash))
		throw new Error("Artifacts main branch unavailable");
	return commit.hash;
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
	const conflict = (remoteHead: string) => ({
		committed: false,
		conflict: true,
		remoteHead,
	});
	if (head !== expectedHead) return conflict(head);

	// Rebuild only directories on edited paths, preserving all other entry IDs and modes.
	const { default: git } = await import("isomorphic-git");
	const fs = new GitMemoryFs(32 * 1024 * 1024, 16_384);
	await git.init({ fs, dir, defaultBranch: branch });
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

	const baseTree = await readThemeArtifactTree(repo, expectedHead);
	const { oid: tree } = await updateTree(baseTree, input.files);
	if (tree === baseTree) {
		const current = await mainHead(repo);
		return current === expectedHead
			? { committed: false, unchanged: true, commit: expectedHead }
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
			parent: [expectedHead],
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
		targetRef: `refs/heads/${branch}`,
		expectedOldOid: expectedHead,
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
		return { committed: true, commit, branch, deletedPaths };
	}
	if (sent.kind === "acknowledged") return confirmedCommit();

	const current = await mainHead(repo);
	if (current === commit) return confirmedCommit();
	if (sent.kind === "rejected") {
		if (current !== expectedHead) return conflict(current);
		throw new Error("Artifacts rejected the theme commit");
	}
	throw new Error(
		`Artifacts did not confirm theme commit ${commit}. Read main before retrying.`,
	);
}
