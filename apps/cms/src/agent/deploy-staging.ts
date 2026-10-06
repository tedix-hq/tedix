/**
 * Staging directory for a workflow instance. The multi-file bundle is stored
 * as a manifest plus one immutable R2 object per source/static file.
 */
export function stagingPrefix(orgSlug: string, jobId: string): string {
	return `themes/${orgSlug}/staging/${jobId}`;
}

export function stagingManifestKey(orgSlug: string, jobId: string): string {
	return `${stagingPrefix(orgSlug, jobId)}/manifest.json`;
}

export function stagingFileKey(
	orgSlug: string,
	jobId: string,
	path: string,
): string {
	return `${stagingPrefix(orgSlug, jobId)}/files/${path}`;
}

export function stagingStaticKey(
	orgSlug: string,
	jobId: string,
	filename: string,
): string {
	return `${stagingPrefix(orgSlug, jobId)}/static/${filename}`;
}

/**
 * Delete staging inputs only after every publish attempt and the health check
 * have settled. Calling this inside `publish-bundle` would let an attempt that
 * completed its external writes but failed before durable step commit destroy
 * the immutable inputs needed by the next retry.
 */
export async function cleanupStagedBundle(
	storage: R2Bucket,
	orgSlug: string,
	jobId: string,
): Promise<number> {
	const manifestKey = stagingManifestKey(orgSlug, jobId);
	const staticManifestKey = `${stagingPrefix(orgSlug, jobId)}/static-manifest.json`;
	const [manifestObj, staticManifestObj] = await Promise.all([
		storage.get(manifestKey),
		storage.get(staticManifestKey),
	]);
	const manifest = manifestObj
		? ((await manifestObj.json()) as { files?: string[] })
		: null;
	const staticManifest = staticManifestObj
		? ((await staticManifestObj.json()) as { filenames?: string[] })
		: null;
	const keys = [
		manifestKey,
		staticManifestKey,
		...(manifest?.files ?? []).map((path) =>
			stagingFileKey(orgSlug, jobId, path),
		),
		...(staticManifest?.filenames ?? []).map((filename) =>
			stagingStaticKey(orgSlug, jobId, filename),
		),
	];
	await storage.delete(keys);
	return keys.length;
}
