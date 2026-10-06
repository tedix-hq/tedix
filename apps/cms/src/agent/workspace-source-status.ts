import type { CmsSandbox } from "../sandbox";
import type { ArtifactsBinding } from "../types";
import type { TenantBundleSourceRevision } from "@tedix/provisioning/cms";
import { isPathEditable } from "./constraints";
import { themeArtifactRepoName } from "./hot-theme";
import {
	readThemeArtifactTree,
	themeArtifactSourceView,
} from "./theme-artifacts";
import {
	digestEditableThemeSource,
	type EditableThemeSource,
} from "./source-provenance";

type SourceSandbox = Pick<CmsSandbox, "listFiles" | "readFile">;

interface SourceReadView {
	listFiles(
		path: string,
		options: { recursive: true },
	): Promise<Array<{ type: string; relativePath: string }>>;
	readFile(path: string): Promise<{ content: string; size: number }>;
}

/** Warm bounded Sandbox reads while retaining the canonical digest algorithm. */
function prefetchEditableReads(
	view: SourceReadView,
	templateSlug: string,
): SourceReadView {
	const reads = new Map<string, Promise<{ content: string; size: number }>>();
	return {
		async listFiles(path, options) {
			const listing = await view.listFiles(path, options);
			const paths = [
				...new Set(
					listing
						.filter((file) => file.type === "file")
						.map((file) =>
							file.relativePath.startsWith("src/")
								? file.relativePath
								: `src/${file.relativePath}`,
						)
						.filter((file) => isPathEditable(file, templateSlug))
						.map((file) => `/workspace/${file}`),
				),
			];
			let next = 0;
			const results = await Promise.allSettled(
				Array.from({ length: Math.min(8, paths.length) }, async () => {
					while (next < paths.length) {
						const file = paths[next++];
						if (!file) continue;
						const read = view.readFile(file);
						reads.set(file, read);
						await read;
					}
				}),
			);
			const failed = results.find((result) => result.status === "rejected");
			if (failed?.status === "rejected") throw failed.reason;
			return listing;
		},
		readFile: (path) => reads.get(path) ?? view.readFile(path),
	};
}

export interface WorkspaceSourceStatus {
	status:
		| "matches_active_source"
		| "differs_from_active_source"
		| "no_artifacts_source"
		| "unavailable";
	activeVersion: number | null;
	activeSourceCommit: string | null;
	activeSourceDigest?: string;
	workspaceSource?: EditableThemeSource;
	activeSource?: EditableThemeSource;
	message: string;
}

function unavailable(
	activeVersion: number | null,
	activeSourceCommit: string | null,
	activeSourceDigest?: string,
): WorkspaceSourceStatus {
	return {
		status: "unavailable",
		activeVersion,
		activeSourceCommit,
		...(activeSourceDigest ? { activeSourceDigest } : {}),
		message:
			"Could not verify the builder workspace against the active theme source. Do not seed Artifacts or replace the workspace until the source is recovered.",
	};
}

/** Compare only editable files, without changing the builder's /workspace. */
export async function inspectWorkspaceSourceStatus(input: {
	orgSlug: string;
	templateSlug: string;
	sandbox: SourceSandbox;
	activeVersion: number | null;
	activeSourceRevision: TenantBundleSourceRevision | null;
	artifacts?: ArtifactsBinding;
}): Promise<WorkspaceSourceStatus> {
	const { activeVersion, activeSourceRevision } = input;
	if (activeSourceRevision?.kind === "editable_source_digest") {
		const activeSourceDigest = activeSourceRevision.value;
		if (!/^[a-f0-9]{64}$/.test(activeSourceDigest)) {
			return unavailable(activeVersion, null);
		}
		let workspaceSource: EditableThemeSource;
		try {
			workspaceSource = await digestEditableThemeSource(
				prefetchEditableReads(input.sandbox, input.templateSlug),
				input.templateSlug,
			);
		} catch {
			return unavailable(activeVersion, null, activeSourceDigest);
		}
		const matches = workspaceSource.digest === activeSourceDigest;
		return {
			status: matches ? "matches_active_source" : "differs_from_active_source",
			activeVersion,
			activeSourceCommit: null,
			activeSourceDigest,
			workspaceSource,
			message: matches
				? "The builder workspace's editable files match the active bundle's source digest. It can be preserved in Artifacts before an upgrade."
				: "The builder workspace differs from the active bundle's source digest. Do not seed Artifacts from this workspace or replace it; recover the deployed source first.",
		};
	}
	if (activeSourceRevision?.kind !== "artifacts_commit") {
		return {
			status: "no_artifacts_source",
			activeVersion,
			activeSourceCommit: null,
			message:
				"The active bundle has no Artifacts commit to compare with the builder workspace.",
		};
	}
	const commit = activeSourceRevision.value;
	if (!/^[a-f0-9]{40}$/.test(commit) || !input.artifacts) {
		return unavailable(activeVersion, commit);
	}

	let workspaceSource: EditableThemeSource;
	try {
		workspaceSource = await digestEditableThemeSource(
			prefetchEditableReads(input.sandbox, input.templateSlug),
			input.templateSlug,
		);
	} catch {
		return unavailable(activeVersion, commit);
	}

	try {
		using repo = await input.artifacts.get(
			themeArtifactRepoName(input.orgSlug),
		);
		const root = await readThemeArtifactTree(repo, commit);
		const checkoutView = await themeArtifactSourceView(
			repo,
			root,
			input.templateSlug,
		);
		const activeSource = await digestEditableThemeSource(
			prefetchEditableReads(checkoutView, input.templateSlug),
			input.templateSlug,
		);
		const matches = activeSource.digest === workspaceSource.digest;
		return {
			status: matches ? "matches_active_source" : "differs_from_active_source",
			activeVersion,
			activeSourceCommit: commit,
			workspaceSource,
			activeSource,
			message: matches
				? "The builder workspace's editable files match the active Artifacts commit."
				: "The builder workspace differs from the active Artifacts commit. It may contain intentional draft edits or stale/reset files. Review and preserve any draft changes before replacing the workspace with the active commit.",
		};
	} catch {
		// Provider errors can include sensitive details; return only recovery guidance.
		return unavailable(activeVersion, commit);
	}
}
