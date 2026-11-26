import {
	completeDocsBuild,
	createDocsBuild,
	getDocsBuild,
	listDocsBuilds,
	updateDocsBuildProgress,
} from "@tedix/db/queries/docs-sites/builds";
import {
	createDocsChange,
	getDocsChange,
	listDocsChanges,
	markDocsChangeCommitted,
	setDocsChangePreview,
	syncDocsChangeValidation,
} from "@tedix/db/queries/docs-sites/changes";
import {
	activateDocsBuild,
	type ActivateDocsBuildParams,
	listDocsReleases,
} from "@tedix/db/queries/docs-sites/releases";
import {
	getDocsSiteById,
	listDocsSites,
	upsertDocsSite,
} from "@tedix/db/queries/docs-sites/sites";
import type { CoreStoreEnv } from "@tedix/db/core-store/client";
import { coreQueryDb } from "@tedix/db/core-store/scope";
import type {
	DocsBuild as DocsBuildRow,
	DocsChange as DocsChangeRow,
	DocsRelease as DocsReleaseRow,
	DocsSite as DocsSiteRow,
} from "@tedix/db/schema/docs-sites";
import type {
	DocsActor,
	DocsActorType,
	DocsBuild,
	DocsChange,
	DocsRelease,
	DocsSite,
	SourceAuthMode,
	SourceProvider,
} from "./types";

export interface UpsertDocsSiteInput {
	id?: string;
	orgSlug: string;
	slug: string;
	title: string;
	description: string;
	locale: string;
	canonicalUrl: string;
	sourceProvider: SourceProvider;
	sourceAuthMode: SourceAuthMode;
	repositoryUrl: string | null;
	artifactsRepository: string | null;
	branch: string;
	contentRoot: string;
	accessMode: DocsSite["accessMode"];
}

function mapActorType(value: string): DocsActorType {
	switch (value) {
		case "user":
		case "service":
		case "tedi":
		case "m2m":
		case "external_agent":
		case "kernel":
			return value;
		default:
			throw new Error(`Unsupported persisted Docs actor type: ${value}`);
	}
}

function mapActor(
	type: string,
	id: string,
	sessionId: string | null,
): DocsActor {
	return { type: mapActorType(type), id, sessionId };
}

export function mapSite(row: DocsSiteRow): DocsSite {
	return {
		id: row.id,
		orgSlug: row.orgSlug,
		slug: row.slug,
		title: row.title,
		description: row.description,
		locale: row.locale,
		canonicalUrl: row.canonicalUrl,
		sourceProvider: row.sourceProvider,
		sourceAuthMode: row.sourceAuthMode,
		repositoryUrl: row.repositoryUrl,
		artifactsRepository: row.artifactsRepository,
		branch: row.branch,
		contentRoot: row.contentRoot,
		accessMode: row.accessMode,
		status: row.status,
		activeBuildId: row.activeBuildId,
		latestBuildId: row.latestBuildId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export function mapBuild(row: DocsBuildRow): DocsBuild {
	return {
		id: row.id,
		siteId: row.siteId,
		status: row.status,
		phase: row.phase,
		sourceBranch: row.sourceBranch,
		sourceRevision: row.sourceRevision,
		proposalId: row.proposalId,
		manifestKey: row.manifestKey,
		error: row.error,
		requestedBy:
			row.requestedByType && row.requestedById
				? mapActor(
						row.requestedByType,
						row.requestedById,
						row.requestedBySessionId,
					)
				: null,
		createdAt: row.createdAt,
		startedAt: row.startedAt,
		finishedAt: row.finishedAt,
	};
}

export function mapChange(row: DocsChangeRow): DocsChange {
	return {
		id: row.id,
		siteId: row.siteId,
		status: row.status,
		path: row.path,
		message: row.message,
		baseRevision: row.baseRevision,
		proposalBranch: row.proposalBranch,
		proposalRevision: row.proposalRevision,
		contentSha256: row.contentSha256,
		previewBuildId: row.previewBuildId,
		committedRevision: row.committedRevision,
		proposedBy: mapActor(
			row.proposedByType,
			row.proposedById,
			row.proposedBySessionId,
		),
		committedBy:
			row.committedByType && row.committedById
				? mapActor(
						row.committedByType,
						row.committedById,
						row.committedBySessionId,
					)
				: null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		committedAt: row.committedAt,
	};
}

function mapRelease(row: DocsReleaseRow): DocsRelease {
	return {
		id: row.id,
		siteId: row.siteId,
		buildId: row.buildId,
		previousBuildId: row.previousBuildId,
		action: row.action,
		actor: mapActor(row.actorType, row.actorId, row.actorSessionId),
		createdAt: row.createdAt,
	};
}

export async function getSiteById(
	env: CoreStoreEnv,
	id: string,
): Promise<DocsSite | null> {
	const row = await getDocsSiteById(coreQueryDb(env), id);
	return row ? mapSite(row) : null;
}

export async function listSites(
	env: CoreStoreEnv,
	orgSlug: string,
): Promise<DocsSite[]> {
	return (await listDocsSites(coreQueryDb(env), orgSlug)).map(mapSite);
}

export async function upsertSite(
	env: CoreStoreEnv,
	input: UpsertDocsSiteInput,
): Promise<DocsSite> {
	return mapSite(await upsertDocsSite(coreQueryDb(env), input));
}

export async function createBuild(
	env: CoreStoreEnv,
	input: {
		id?: string;
		siteId: string;
		sourceBranch: string;
		proposalId?: string | null;
		requestedBy: DocsActor;
	},
): Promise<DocsBuild> {
	return mapBuild(await createDocsBuild(coreQueryDb(env), input));
}

export async function activateBuild(
	env: CoreStoreEnv,
	input: ActivateDocsBuildParams,
): Promise<{ site: DocsSite; release: DocsRelease }> {
	const result = await activateDocsBuild(coreQueryDb(env), input);
	return { site: mapSite(result.site), release: mapRelease(result.release) };
}

export async function createChange(
	env: CoreStoreEnv,
	input: {
		id: string;
		siteId: string;
		path: string;
		message: string;
		baseRevision: string;
		proposalBranch: string;
		proposalRevision: string;
		contentSha256: string;
		proposedBy: DocsActor;
	},
): Promise<DocsChange> {
	return mapChange(await createDocsChange(coreQueryDb(env), input));
}

export async function getChange(
	env: CoreStoreEnv,
	id: string,
): Promise<DocsChange | null> {
	const row = await getDocsChange(coreQueryDb(env), id);
	return row ? mapChange(row) : null;
}

export async function listChanges(
	env: CoreStoreEnv,
	siteId: string,
): Promise<DocsChange[]> {
	return (await listDocsChanges(coreQueryDb(env), siteId)).map(mapChange);
}

export async function setChangePreview(
	env: CoreStoreEnv,
	input: { changeId: string; buildId: string },
): Promise<DocsChange> {
	return mapChange(await setDocsChangePreview(coreQueryDb(env), input));
}

export async function markChangeCommitted(
	env: CoreStoreEnv,
	input: {
		changeId: string;
		revision: string;
		actor: DocsActor;
	},
): Promise<DocsChange> {
	return mapChange(await markDocsChangeCommitted(coreQueryDb(env), input));
}

export async function syncChangeValidation(
	env: CoreStoreEnv,
	change: DocsChange,
): Promise<DocsChange> {
	const row = await syncDocsChangeValidation(coreQueryDb(env), {
		id: change.id,
		status: change.status,
		previewBuildId: change.previewBuildId,
	});
	return mapChange(row);
}

export async function listReleases(
	env: CoreStoreEnv,
	siteId: string,
): Promise<DocsRelease[]> {
	return (await listDocsReleases(coreQueryDb(env), siteId)).map(mapRelease);
}

export async function getBuild(
	env: CoreStoreEnv,
	id: string,
): Promise<DocsBuild | null> {
	const row = await getDocsBuild(coreQueryDb(env), id);
	return row ? mapBuild(row) : null;
}

export async function updateBuildProgress(
	env: CoreStoreEnv,
	buildId: string,
	input: {
		status: "running" | "failed";
		phase: string;
		error?: string | null;
		sourceRevision?: string | null;
	},
): Promise<void> {
	await updateDocsBuildProgress(coreQueryDb(env), { buildId, ...input });
}

export async function completeBuild(
	env: CoreStoreEnv,
	input: {
		buildId: string;
		siteId: string;
		sourceRevision: string;
		manifestKey: string;
	},
): Promise<void> {
	await completeDocsBuild(coreQueryDb(env), input);
}

export async function listBuilds(
	env: CoreStoreEnv,
	siteId: string,
): Promise<DocsBuild[]> {
	return (await listDocsBuilds(coreQueryDb(env), siteId)).map(mapBuild);
}
