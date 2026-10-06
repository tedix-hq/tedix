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
	listDocsReleases,
} from "@tedix/db/queries/docs-sites/releases";
import {
	getDocsSiteById,
	listDocsSites,
	upsertDocsSite,
} from "@tedix/db/queries/docs-sites/sites";
import { createDbQueryClient } from "@tedix/db/query-client";
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
	d1: D1Database,
	id: string,
): Promise<DocsSite | null> {
	const row = await getDocsSiteById(createDbQueryClient(d1), id);
	return row ? mapSite(row) : null;
}

export async function listSites(
	d1: D1Database,
	orgSlug: string,
): Promise<DocsSite[]> {
	return (await listDocsSites(createDbQueryClient(d1), orgSlug)).map(mapSite);
}

export async function upsertSite(
	d1: D1Database,
	input: UpsertDocsSiteInput,
): Promise<DocsSite> {
	return mapSite(await upsertDocsSite(createDbQueryClient(d1), input));
}

export async function createBuild(
	d1: D1Database,
	input: {
		siteId: string;
		sourceBranch: string;
		proposalId?: string | null;
		requestedBy: DocsActor;
	},
): Promise<DocsBuild> {
	return mapBuild(await createDocsBuild(createDbQueryClient(d1), input));
}

export async function activateBuild(
	d1: D1Database,
	input: {
		buildId: string;
		orgSlug: string;
		siteId: string;
		action: DocsRelease["action"];
		actor: DocsActor;
	},
): Promise<{ site: DocsSite; release: DocsRelease }> {
	const result = await activateDocsBuild(createDbQueryClient(d1), input);
	return { site: mapSite(result.site), release: mapRelease(result.release) };
}

export async function createChange(
	d1: D1Database,
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
	return mapChange(await createDocsChange(createDbQueryClient(d1), input));
}

export async function getChange(
	d1: D1Database,
	id: string,
): Promise<DocsChange | null> {
	const row = await getDocsChange(createDbQueryClient(d1), id);
	return row ? mapChange(row) : null;
}

export async function listChanges(
	d1: D1Database,
	siteId: string,
): Promise<DocsChange[]> {
	return (await listDocsChanges(createDbQueryClient(d1), siteId)).map(
		mapChange,
	);
}

export async function setChangePreview(
	d1: D1Database,
	input: { changeId: string; buildId: string },
): Promise<DocsChange> {
	return mapChange(await setDocsChangePreview(createDbQueryClient(d1), input));
}

export async function markChangeCommitted(
	d1: D1Database,
	input: {
		changeId: string;
		revision: string;
		actor: DocsActor;
	},
): Promise<DocsChange> {
	return mapChange(
		await markDocsChangeCommitted(createDbQueryClient(d1), input),
	);
}

export async function syncChangeValidation(
	d1: D1Database,
	change: DocsChange,
): Promise<DocsChange> {
	const row = await syncDocsChangeValidation(createDbQueryClient(d1), {
		id: change.id,
		status: change.status,
		previewBuildId: change.previewBuildId,
	});
	return mapChange(row);
}

export async function listReleases(
	d1: D1Database,
	siteId: string,
): Promise<DocsRelease[]> {
	return (await listDocsReleases(createDbQueryClient(d1), siteId)).map(
		mapRelease,
	);
}

export async function getBuild(
	d1: D1Database,
	id: string,
): Promise<DocsBuild | null> {
	const row = await getDocsBuild(createDbQueryClient(d1), id);
	return row ? mapBuild(row) : null;
}

export async function updateBuildProgress(
	d1: D1Database,
	buildId: string,
	input: {
		status: "running" | "failed";
		phase: string;
		error?: string | null;
		sourceRevision?: string | null;
	},
): Promise<void> {
	await updateDocsBuildProgress(createDbQueryClient(d1), { buildId, ...input });
}

export async function completeBuild(
	d1: D1Database,
	input: {
		buildId: string;
		siteId: string;
		sourceRevision: string;
		manifestKey: string;
	},
): Promise<void> {
	await completeDocsBuild(createDbQueryClient(d1), input);
}

export async function listBuilds(
	d1: D1Database,
	siteId: string,
): Promise<DocsBuild[]> {
	return (await listDocsBuilds(createDbQueryClient(d1), siteId)).map(mapBuild);
}
