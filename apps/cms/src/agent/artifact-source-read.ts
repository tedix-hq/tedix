import type { ArtifactsBinding } from "../types";
import { isPathEditable } from "./constraints";
import { themeArtifactRepoName } from "./hot-theme";
import {
	readThemeArtifactTree,
	resolveThemeArtifactFile,
	readThemeArtifactBlob,
} from "./theme-artifacts";

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
