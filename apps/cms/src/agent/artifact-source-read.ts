import type { ArtifactsBinding } from "../types";
import { isPathEditable } from "./constraints";
import { themeArtifactRepoName } from "./hot-theme";
import {
	readThemeArtifactTree,
	resolveThemeArtifactFile,
	readThemeArtifactBlob,
} from "./theme-artifacts";

/** Read the current branch through the native binding, without starting a container. */
export async function readThemeArtifactHead(input: {
	orgSlug: string;
	artifacts: ArtifactsBinding;
}): Promise<{ branch: "main"; sourceCommit: string }> {
	try {
		using repo = await input.artifacts.get(
			themeArtifactRepoName(input.orgSlug),
		);
		const commits = await repo.log({
			ref: "refs/heads/main",
			limit: 1,
			offset: 0,
		});
		const sourceCommit = commits[0]?.hash;
		if (
			commits.length !== 1 ||
			!sourceCommit ||
			!/^[a-f0-9]{40}$/.test(sourceCommit)
		)
			throw new Error("Artifacts main branch unavailable");
		await readThemeArtifactTree(repo, sourceCommit);
		return { branch: "main", sourceCommit };
	} catch {
		throw new Error("Unable to read the current Artifacts theme branch");
	}
}

export async function readThemeArtifactFile(input: {
	orgSlug: string;
	templateSlug: string;
	sourceCommit: string;
	path: string;
	artifacts: ArtifactsBinding;
}): Promise<{
	sourceCommit: string;
	path: string;
	content: string;
	sizeBytes: number;
}> {
	const { sourceCommit, path } = input;
	if (!/^[a-f0-9]{40}$/.test(sourceCommit))
		throw new Error("Invalid Artifacts source commit");
	if (
		!/^src\/[A-Za-z0-9_./\[\]-]+$/.test(path) ||
		path.split("/").some((part) => !part || part === "." || part === "..") ||
		!isPathEditable(path, input.templateSlug)
	)
		throw new Error("Theme source path is not editable");
	try {
		using repo = await input.artifacts.get(
			themeArtifactRepoName(input.orgSlug),
		);
		const root = await readThemeArtifactTree(repo, sourceCommit);
		const hash = await resolveThemeArtifactFile(repo, root, path);
		const file = await readThemeArtifactBlob(repo, hash, 256_000);
		return { sourceCommit, path, content: file.content, sizeBytes: file.size };
	} catch {
		throw new Error("Unable to read the requested Artifacts source file");
	}
}
