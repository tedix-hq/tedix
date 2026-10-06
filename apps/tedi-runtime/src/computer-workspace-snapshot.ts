import type {
	CommitPrefixSnapshotArgs,
	commitPrefixSnapshot,
} from "./artifacts-git";
import type { ScopedComputerWorkspace } from "./computer-workspace-scope";
import { collectWorkspaceSnapshotFiles } from "./workspace-fs";

/** Publication replaces only the originating scope, including a genuinely empty tree. */
export async function publishComputerWorkspaceSnapshot(input: {
	computer: Pick<
		ScopedComputerWorkspace,
		"scope" | "snapshotPrefix" | "workspace"
	>;
	message?: string;
	commit: (
		snapshot: Pick<CommitPrefixSnapshotArgs, "prefix" | "files" | "message">,
	) => ReturnType<typeof commitPrefixSnapshot>;
}): Promise<unknown> {
	const { computer } = input;
	const collection = await collectWorkspaceSnapshotFiles(computer.workspace);
	if (collection.truncated || collection.skipped.length) {
		return {
			ok: false,
			error: "workspace_snapshot_incomplete",
			skipped: collection.skipped,
			truncated: collection.truncated,
			scope: computer.scope,
		};
	}
	try {
		const result = await input.commit({
			prefix: computer.snapshotPrefix,
			files: collection.files.map((file) => ({
				path: `${computer.snapshotPrefix}${file.path}`,
				content: file.content,
			})),
			message:
				input.message?.trim().slice(0, 200) ||
				`workspace_snapshot: ${collection.files.length} files`,
		});
		return {
			ok: true,
			commitOid: result.commitOid,
			scope: computer.scope,
			prefix: computer.snapshotPrefix,
			fileCount: result.writtenCount,
			removedCount: result.removedCount,
			skipped: collection.skipped,
			truncated: false,
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
			scope: computer.scope,
		};
	}
}
