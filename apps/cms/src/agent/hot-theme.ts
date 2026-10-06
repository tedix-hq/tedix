import { sha256Hex } from "@tedix/worker-kit/crypto";
import { withCmsSiteRestorePermit } from "./cms-restore-permit";
export const HOT_THEME_PUBLIC_PATH = "/_tedix/theme.css";

export interface HotThemeManifest {
	orgSlug: string;
	cssKey: string;
	historyKey?: string;
	previousRevision?: string | null;
	revision: string;
	revisionKey?: string;
	size: number;
	sha256: string;
	updatedAt: string;
	summary?: string;
	sourceRepo?: {
		name: string;
		remote: string;
		defaultBranch?: string;
	};
}

export interface HotThemeRevision {
	activatedAt: string;
	createdAt: string;
	revision: string;
	revisionKey: string;
	sha256: string;
	size: number;
	sourceRepo?: HotThemeManifest["sourceRepo"];
	summary?: string;
}

export interface HotThemeHistory {
	currentRevision: string | null;
	orgSlug: string;
	revisions: HotThemeRevision[];
	updatedAt: string;
}

interface HotThemeWriteContext {
	bundlesBucket: R2Bucket;
	db: D1Database;
	orgSlug: string;
}

export function hotThemeCssKey(orgSlug: string): string {
	return `hot-themes/${orgSlug}/current.css`;
}

export function hotThemeManifestKey(orgSlug: string): string {
	return `hot-themes/${orgSlug}/manifest.json`;
}

export function hotThemeHistoryKey(orgSlug: string): string {
	return `hot-themes/${orgSlug}/history.json`;
}

export function hotThemeRevisionKey(orgSlug: string, revision: string): string {
	return `hot-themes/${orgSlug}/revisions/${revision}.css`;
}

export function themeArtifactRepoName(orgSlug: string): string {
	return `cms-theme-${orgSlug}`;
}

export const THEME_ARTIFACTS_NAMESPACE = "tedix-prod";

/**
 * HTTPS Git remote of a tenant's theme repository, built from the account and
 * namespace. Never read `remote` off a repo handle: over the remote Artifacts
 * binding that property access is dispatched as an RPC method the stub does
 * not implement, so every `theme_deploy({ sourceCommit })` failed in preflight
 * with `The RPC receiver does not implement the method "remote"`.
 */
export function themeArtifactRemote(
	accountId: string,
	orgSlug: string,
	namespace: string = THEME_ARTIFACTS_NAMESPACE,
): string {
	return `https://${accountId}.artifacts.cloudflare.net/git/${namespace}/${themeArtifactRepoName(orgSlug)}.git`;
}

function shortRevision(hash: string): string {
	return hash.slice(0, 12);
}

export async function readHotThemeManifest(
	bucket: R2Bucket,
	orgSlug: string,
): Promise<HotThemeManifest | null> {
	const object = await bucket.get(hotThemeManifestKey(orgSlug));
	if (!object) return null;
	return (await object.json()) as HotThemeManifest;
}

export async function readHotThemeCss(
	bucket: R2Bucket,
	orgSlug: string,
): Promise<string | null> {
	const object = await bucket.get(hotThemeCssKey(orgSlug));
	if (!object) return null;
	return object.text();
}

async function readHotThemeHistory(
	bucket: R2Bucket,
	orgSlug: string,
): Promise<HotThemeHistory | null> {
	const object = await bucket.get(hotThemeHistoryKey(orgSlug));
	if (!object) return null;
	return (await object.json()) as HotThemeHistory;
}

function historyFromManifest(
	orgSlug: string,
	manifest: HotThemeManifest | null,
): HotThemeHistory {
	if (!manifest) {
		return {
			currentRevision: null,
			orgSlug,
			revisions: [],
			updatedAt: new Date(0).toISOString(),
		};
	}

	const revisionKey =
		manifest.revisionKey ?? hotThemeRevisionKey(orgSlug, manifest.revision);
	return {
		currentRevision: manifest.revision,
		orgSlug,
		revisions: [
			{
				activatedAt: manifest.updatedAt,
				createdAt: manifest.updatedAt,
				revision: manifest.revision,
				revisionKey,
				sha256: manifest.sha256,
				size: manifest.size,
				sourceRepo: manifest.sourceRepo,
				summary: manifest.summary,
			},
		],
		updatedAt: manifest.updatedAt,
	};
}

async function readOrCreateHotThemeHistory(
	bucket: R2Bucket,
	orgSlug: string,
): Promise<HotThemeHistory> {
	const history = await readHotThemeHistory(bucket, orgSlug);
	if (history) return history;
	const manifest = await readHotThemeManifest(bucket, orgSlug);
	return historyFromManifest(orgSlug, manifest);
}

function upsertHotThemeRevision(
	history: HotThemeHistory,
	revision: HotThemeRevision,
): HotThemeHistory {
	const existing = history.revisions.find(
		(entry) => entry.revision === revision.revision,
	);
	const merged = existing
		? {
				...existing,
				...revision,
				createdAt: existing.createdAt,
			}
		: revision;
	return {
		currentRevision: revision.revision,
		orgSlug: history.orgSlug,
		revisions: [
			merged,
			...history.revisions.filter(
				(entry) => entry.revision !== revision.revision,
			),
		].slice(0, 25),
		updatedAt: revision.activatedAt,
	};
}

async function writeHotThemeManifestAndHistory(
	ctx: HotThemeWriteContext,
	manifest: HotThemeManifest,
	history: HotThemeHistory,
	css: string,
): Promise<void> {
	const revisionKey =
		manifest.revisionKey ?? hotThemeRevisionKey(ctx.orgSlug, manifest.revision);
	const writes = await Promise.allSettled([
		ctx.bundlesBucket.put(manifest.cssKey, css, {
			httpMetadata: {
				contentType: "text/css; charset=utf-8",
				cacheControl: "no-store",
			},
			customMetadata: {
				orgSlug: ctx.orgSlug,
				revision: manifest.revision,
				sha256: manifest.sha256,
			},
		}),
		ctx.bundlesBucket.put(revisionKey, css, {
			httpMetadata: {
				contentType: "text/css; charset=utf-8",
				cacheControl: "public, max-age=31536000, immutable",
			},
			customMetadata: {
				orgSlug: ctx.orgSlug,
				revision: manifest.revision,
				sha256: manifest.sha256,
			},
		}),
		ctx.bundlesBucket.put(
			hotThemeManifestKey(ctx.orgSlug),
			JSON.stringify(manifest),
			{
				httpMetadata: {
					contentType: "application/json; charset=utf-8",
					cacheControl: "no-store",
				},
			},
		),
		ctx.bundlesBucket.put(
			hotThemeHistoryKey(ctx.orgSlug),
			JSON.stringify(history),
			{
				httpMetadata: {
					contentType: "application/json; charset=utf-8",
					cacheControl: "no-store",
				},
			},
		),
	]);
	const failure = writes.find(
		(result): result is PromiseRejectedResult => result.status === "rejected",
	);
	if (failure) throw failure.reason;
}

async function updateHotThemeMetadata(
	ctx: HotThemeWriteContext,
	manifest: HotThemeManifest,
): Promise<void> {
	await updateCmsHotThemeMetadata(ctx.db, ctx.orgSlug, {
		enabled: true,
		cssKey: manifest.cssKey,
		historyKey: manifest.historyKey,
		manifestKey: hotThemeManifestKey(ctx.orgSlug),
		previousRevision: manifest.previousRevision ?? null,
		revision: manifest.revision,
		revisionKey: manifest.revisionKey,
		sha256: manifest.sha256,
		updatedAt: manifest.updatedAt,
		summary: manifest.summary ?? null,
		publicPath: HOT_THEME_PUBLIC_PATH,
	});
}

export async function listHotThemeRevisions(
	bucket: R2Bucket,
	orgSlug: string,
): Promise<HotThemeHistory> {
	return readOrCreateHotThemeHistory(bucket, orgSlug);
}

export async function writeHotThemeCss(
	ctx: HotThemeWriteContext,
	input: {
		css: string;
		summary?: string;
		sourceRepo?: HotThemeManifest["sourceRepo"];
	},
): Promise<HotThemeManifest> {
	return withCmsSiteRestorePermit(ctx.db, ctx.orgSlug, async () => {
		const sha256 = await sha256Hex(input.css);
		const previous = await readHotThemeManifest(ctx.bundlesBucket, ctx.orgSlug);
		const updatedAt = new Date().toISOString();
		const revision = shortRevision(sha256);
		const revisionKey = hotThemeRevisionKey(ctx.orgSlug, revision);
		const manifest: HotThemeManifest = {
			orgSlug: ctx.orgSlug,
			cssKey: hotThemeCssKey(ctx.orgSlug),
			historyKey: hotThemeHistoryKey(ctx.orgSlug),
			previousRevision: previous?.revision ?? null,
			revision,
			revisionKey,
			size: new TextEncoder().encode(input.css).byteLength,
			sha256,
			updatedAt,
			summary: input.summary,
			sourceRepo: input.sourceRepo,
		};
		const existingHistory = await readOrCreateHotThemeHistory(
			ctx.bundlesBucket,
			ctx.orgSlug,
		);
		const history = upsertHotThemeRevision(existingHistory, {
			activatedAt: updatedAt,
			createdAt: updatedAt,
			revision: manifest.revision,
			revisionKey,
			sha256,
			size: manifest.size,
			sourceRepo: input.sourceRepo,
			summary: input.summary,
		});

		await writeHotThemeManifestAndHistory(ctx, manifest, history, input.css);
		await updateHotThemeMetadata(ctx, manifest);

		return manifest;
	});
}

export async function rollbackHotThemeCss(
	ctx: HotThemeWriteContext,
	input: {
		revision: string;
		summary?: string;
	},
): Promise<HotThemeManifest> {
	return withCmsSiteRestorePermit(ctx.db, ctx.orgSlug, async () => {
		const history = await readOrCreateHotThemeHistory(
			ctx.bundlesBucket,
			ctx.orgSlug,
		);
		const target = history.revisions.find(
			(entry) => entry.revision === input.revision,
		);
		if (!target) {
			throw new Error(
				`Hot theme revision "${input.revision}" was not found for ${ctx.orgSlug}`,
			);
		}

		const object = await ctx.bundlesBucket.get(target.revisionKey);
		if (!object) {
			throw new Error(
				`Hot theme revision object "${target.revisionKey}" is missing for ${ctx.orgSlug}`,
			);
		}

		const css = await object.text();
		const current = await readHotThemeManifest(ctx.bundlesBucket, ctx.orgSlug);
		const updatedAt = new Date().toISOString();
		const manifest: HotThemeManifest = {
			orgSlug: ctx.orgSlug,
			cssKey: hotThemeCssKey(ctx.orgSlug),
			historyKey: hotThemeHistoryKey(ctx.orgSlug),
			previousRevision: current?.revision ?? null,
			revision: target.revision,
			revisionKey: target.revisionKey,
			size: target.size,
			sha256: target.sha256,
			updatedAt,
			summary:
				input.summary ?? `Rollback hot theme to revision ${target.revision}`,
			sourceRepo: target.sourceRepo,
		};
		const nextHistory = upsertHotThemeRevision(history, {
			...target,
			activatedAt: updatedAt,
			summary: manifest.summary,
		});

		await writeHotThemeManifestAndHistory(ctx, manifest, nextHistory, css);
		await updateHotThemeMetadata(ctx, manifest);

		return manifest;
	});
}

import { updateCmsHotThemeMetadata } from "./storage";
