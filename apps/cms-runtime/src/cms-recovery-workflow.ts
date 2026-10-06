import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { createHash } from "node:crypto";
import { createDbClient } from "@tedix/db/client";
import { createDbQueryClient } from "@tedix/db/query-client";
import { getCmsSiteBySlug } from "@tedix/db/queries/cms-sites";
import {
	abortCmsCaptureCronPause,
	assertCmsCaptureCronPause,
	claimCmsCaptureCronPause,
	drainCmsCaptureCronPause,
	releaseCmsCaptureCronPause,
} from "@tedix/db/queries/cms-restore-fences";
import { listTenantBundleVersions } from "@tedix/provisioning/cms";
import {
	copyAndVerifyMediaObject,
	digestSourceMediaObject,
	inventoryMedia,
	listMediaPage,
	type VerifiedMediaObject,
} from "./tenant-media-backup";
import type { Env } from "./index";

const CAPTURE_MEDIA_PAGE_SIZE = 10;
const MAX_CAPTURE_MEDIA_PAGES = 1000;
const MAX_CAPTURE_MEDIA_OBJECTS =
	CAPTURE_MEDIA_PAGE_SIZE * MAX_CAPTURE_MEDIA_PAGES;

export interface CmsRecoveryParams {
	siteId: string;
	slug: string;
	captureId: string;
}

export const CMS_RECOVERY_DIGEST_ALGORITHM = "cms-site-sqlite-v2" as const;

interface CmsRecoveryManifestBase {
	siteId: string;
	slug: string;
	captureId: string;
	capturedAt: string;
	retainUntil: string;
	bookmark: string;
	bundle: { version: number; etag: string };
	media: {
		count: number;
		bytes: number;
		sourceInventorySha256: string;
		pageCount: number;
	};
}

export interface CmsRecoveryManifestV1 extends CmsRecoveryManifestBase {
	version: 1;
}

export interface CmsRecoveryManifestV2 extends CmsRecoveryManifestBase {
	version: 2;
	digestAlgorithm: typeof CMS_RECOVERY_DIGEST_ALGORITHM;
	databaseDigest: string;
}

export type CmsRecoveryManifest = CmsRecoveryManifestV1 | CmsRecoveryManifestV2;

export type CmsRecoveryControlState =
	| "queued"
	| "running"
	| "verified"
	| "failed"
	| "purging"
	| "purged";

export interface CmsRecoveryControl {
	version: 1;
	siteId: string;
	slug: string;
	captureId: string;
	createdAt: string;
	state: CmsRecoveryControlState;
}

export function cmsRecoveryControlKey(
	siteId: string,
	captureId: string,
): string {
	return `${cmsRecoveryPrefix(siteId, captureId)}control.json`;
}

export async function putCmsRecoveryControl(
	storage: R2Bucket,
	control: CmsRecoveryControl,
): Promise<void> {
	await storage.put(
		cmsRecoveryControlKey(control.siteId, control.captureId),
		JSON.stringify(control),
		{
			httpMetadata: { contentType: "application/json" },
		},
	);
}

export function validRecoveryTime(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function isCmsRecoveryManifest(
	value: unknown,
	identity: { siteId: string; slug: string; captureId: string },
): value is CmsRecoveryManifest {
	if (!value || typeof value !== "object") return false;
	const m = value as Partial<CmsRecoveryManifestBase> & {
		version?: unknown;
		digestAlgorithm?: unknown;
		databaseDigest?: unknown;
	};
	return (
		(m.version === 1 ||
			(m.version === 2 &&
				m.digestAlgorithm === CMS_RECOVERY_DIGEST_ALGORITHM &&
				typeof m.databaseDigest === "string" &&
				/^[0-9a-f]{64}$/.test(m.databaseDigest))) &&
		m.siteId === identity.siteId &&
		m.slug === identity.slug &&
		m.captureId === identity.captureId &&
		validRecoveryTime(m.capturedAt) &&
		validRecoveryTime(m.retainUntil) &&
		Date.parse(m.retainUntil) > Date.parse(m.capturedAt) &&
		Date.parse(m.retainUntil) - Date.parse(m.capturedAt) <=
			29 * 24 * 60 * 60 * 1000 &&
		Date.parse(m.capturedAt) <= Date.now() + 5 * 60 * 1000 &&
		typeof m.bookmark === "string" &&
		m.bookmark.length > 0 &&
		!!m.bundle &&
		Number.isSafeInteger(m.bundle.version) &&
		typeof m.bundle.etag === "string" &&
		m.bundle.etag.length > 0 &&
		!!m.media &&
		Number.isSafeInteger(m.media.count) &&
		m.media.count >= 0 &&
		Number.isSafeInteger(m.media.bytes) &&
		m.media.bytes >= 0 &&
		Number.isSafeInteger(m.media.pageCount) &&
		m.media.pageCount >= 1 &&
		m.media.pageCount <= MAX_CAPTURE_MEDIA_PAGES &&
		m.media.count <= MAX_CAPTURE_MEDIA_OBJECTS &&
		typeof m.media.sourceInventorySha256 === "string" &&
		/^[0-9a-f]{64}$/.test(m.media.sourceInventorySha256)
	);
}

export function isCmsRecoveryControl(
	value: unknown,
	identity: { siteId: string; slug: string; captureId: string },
): value is CmsRecoveryControl {
	if (!value || typeof value !== "object") return false;
	const c = value as Partial<CmsRecoveryControl>;
	return (
		c.version === 1 &&
		c.siteId === identity.siteId &&
		c.slug === identity.slug &&
		c.captureId === identity.captureId &&
		validRecoveryTime(c.createdAt) &&
		Date.parse(c.createdAt) <= Date.now() + 5 * 60 * 1000 &&
		["queued", "running", "verified", "failed", "purging", "purged"].includes(
			c.state ?? "",
		)
	);
}

export function cmsRecoveryPrefix(siteId: string, captureId: string): string {
	return `recovery/${siteId}/${captureId}/`;
}

/** Read the private capture, including every backed-up byte, before a restore drill. */
export async function readVerifiedCmsRecoveryCapture(
	storage: R2Bucket,
	identity: { siteId: string; slug: string; captureId: string },
	prefix = cmsRecoveryPrefix(identity.siteId, identity.captureId),
): Promise<{ manifest: CmsRecoveryManifest; records: VerifiedMediaObject[] }> {
	const [controlObject, manifestObject] = await Promise.all([
		storage.get(`${prefix}control.json`),
		storage.get(`${prefix}manifest.json`),
	]);
	const control = controlObject ? await controlObject.json() : null;
	const manifestValue = manifestObject ? await manifestObject.json() : null;
	if (!isCmsRecoveryControl(control, identity) || control.state !== "verified")
		throw new Error("CMS restore drill capture is not verified");
	if (!isCmsRecoveryManifest(manifestValue, identity))
		throw new Error("CMS restore drill manifest invalid");
	if (Date.now() >= Date.parse(manifestValue.retainUntil))
		throw new Error("CMS restore drill capture expired");
	const records: VerifiedMediaObject[] = [];
	const inventoryHash = createHash("sha256");
	for (let page = 0; page < manifestValue.media.pageCount; page++) {
		const key = `${prefix}pages/${String(page).padStart(8, "0")}.json`;
		const object = await storage.get(key);
		if (!object) throw new Error("CMS restore drill media page missing");
		const value = await object.json();
		if (!Array.isArray(value))
			throw new Error("CMS restore drill media page invalid");
		for (const candidate of value) {
			const record = candidate as Partial<VerifiedMediaObject>;
			if (
				!record ||
				typeof record.key !== "string" ||
				!record.key ||
				!Number.isSafeInteger(record.size) ||
				(record.size ?? -1) < 0 ||
				typeof record.etag !== "string" ||
				!record.etag ||
				typeof record.sha256 !== "string" ||
				!/^[0-9a-f]{64}$/.test(record.sha256) ||
				[
					record.contentType,
					record.cacheControl,
					record.contentDisposition,
					record.contentEncoding,
					record.contentLanguage,
				].some(
					(metadata) => metadata !== undefined && typeof metadata !== "string",
				)
			)
				throw new Error("CMS restore drill media record invalid");
			records.push(record as VerifiedMediaObject);
			inventoryHash.update(
				JSON.stringify([record.key, record.size, record.etag]),
			);
		}
	}
	if (
		records.length !== manifestValue.media.count ||
		records.reduce((sum, record) => sum + record.size, 0) !==
			manifestValue.media.bytes ||
		new Set(records.map((record) => record.key)).size !== records.length ||
		inventoryHash.digest("hex") !== manifestValue.media.sourceInventorySha256
	)
		throw new Error("CMS restore drill media manifest mismatch");
	for (const record of records) {
		const object = await storage.get(
			`${prefix}media/${encodeURIComponent(record.key)}`,
		);
		if (!object?.body || object.size !== record.size)
			throw new Error("CMS restore drill media backup missing");
		const hash = createHash("sha256");
		let bytes = 0;
		for await (const chunk of object.body) {
			hash.update(chunk);
			bytes += chunk.byteLength;
		}
		if (bytes !== record.size || hash.digest("hex") !== record.sha256)
			throw new Error("CMS restore drill media backup bytes changed");
	}
	return { manifest: manifestValue, records };
}

/** Fresh storage authority; recovery does not require a human Descope tenant. */
export async function readRecoveryAuthority(
	env: Pick<Env, "PLATFORM_DB" | "TENANT_BUNDLES">,
	slug: string,
): Promise<{
	siteId: string;
	bundle: { version: number; etag: string };
} | null> {
	const [site, versions] = await Promise.all([
		getCmsSiteBySlug(createDbClient(env.PLATFORM_DB), slug),
		listTenantBundleVersions(
			{ platformDb: env.PLATFORM_DB, bundlesBucket: env.TENANT_BUNDLES },
			slug,
		),
	]);
	const active = versions.filter((version) => version.isActive);
	return site?.status === "active" && active.length === 1
		? {
				siteId: site.id,
				bundle: { version: active[0]!.version, etag: active[0]!.etag },
			}
		: null;
}

/** Keep the ownership tombstone so interrupted purges can resume safely. */
export async function purgeCmsRecoveryObjects(
	storage: R2Bucket,
	control: CmsRecoveryControl,
): Promise<void> {
	if (control.state === "purged") return;
	const prefix = cmsRecoveryPrefix(control.siteId, control.captureId);
	const controlKey = cmsRecoveryControlKey(control.siteId, control.captureId);
	await putCmsRecoveryControl(storage, { ...control, state: "purging" });
	// The public status path checks control first. Removing the manifest before
	// media also makes a partial purge unusable by any future restore operator.
	await storage.delete(`${prefix}manifest.json`);
	for (let pageNumber = 0; pageNumber < 1000; pageNumber++) {
		const page = await storage.list({ prefix, limit: 1000 });
		const removable = page.objects
			.map((object) => object.key)
			.filter((key) => key !== controlKey);
		if (removable.length) await storage.delete(removable);
		if (!removable.length) {
			await putCmsRecoveryControl(storage, { ...control, state: "purged" });
			return;
		}
	}
	throw new Error("CMS recovery purge exceeded page limit");
}

export async function captureCmsRecovery(
	env: Env,
	step: WorkflowStep,
	params: CmsRecoveryParams,
	/** Restore undo captures already hold the stronger site restore fence. */
	assertCapturePause?: () => Promise<boolean>,
): Promise<CmsRecoveryManifest> {
	const prefix = cmsRecoveryPrefix(params.siteId, params.captureId);
	const controlKey = cmsRecoveryControlKey(params.siteId, params.captureId);
	const storedControl = await env.RECOVERY_STORAGE.get(controlKey);
	const control = storedControl ? await storedControl.json() : null;
	if (!isCmsRecoveryControl(control, params))
		throw new Error("CMS recovery control unavailable");
	if (control.state === "verified") {
		const storedManifest = await env.RECOVERY_STORAGE.get(
			`${prefix}manifest.json`,
		);
		const value = storedManifest ? await storedManifest.json() : null;
		if (!isCmsRecoveryManifest(value, params))
			throw new Error("CMS recovery completed manifest unavailable");
		return value;
	}
	if (control.state !== "queued" && control.state !== "running")
		throw new Error("CMS recovery control is terminal");
	await putCmsRecoveryControl(env.RECOVERY_STORAGE, {
		...control,
		state: "running",
	});
	const authority = await step.do("capture-authority", async () => {
		const current = await readRecoveryAuthority(env, params.slug);
		if (!current || current.siteId !== params.siteId)
			throw new Error("CMS recovery site authority changed");
		const stub = env.DB_DO.get(
			env.DB_DO.idFromName(params.slug),
		) as unknown as {
			captureRecoverySnapshot(): Promise<{
				bookmark: string;
				databaseDigest: string;
			} | null>;
		};
		const snapshot = await stub.captureRecoverySnapshot();
		if (!snapshot?.bookmark || !/^[0-9a-f]{64}$/.test(snapshot.databaseDigest))
			throw new Error("CMS recovery database snapshot unavailable");
		return { current, ...snapshot, capturedAt: new Date().toISOString() };
	});
	const source = {
		accountId: env.CF_ACCOUNT_ID,
		token: env.CLOUDFLARE_R2_API_TOKEN,
		slug: params.slug,
	};
	const initialInventory = await step.do("initial-media-inventory", () =>
		inventoryMedia(source),
	);
	let cursor: string | undefined;
	let pageCount = 0;
	let count = 0;
	let bytes = 0;
	let destinationInventoryHash = createHash("sha256");
	do {
		if (pageCount >= MAX_CAPTURE_MEDIA_PAGES)
			throw new Error("CMS media backup exceeded page limit");
		const pageNumber = pageCount;
		const page = await step.do(`copy-media-page-${pageNumber}`, async () => {
			const listed = await listMediaPage({
				...source,
				cursor,
				pageSize: CAPTURE_MEDIA_PAGE_SIZE,
			});
			const records = [];
			for (const object of listed.objects) {
				const destinationKey = `${prefix}media/${encodeURIComponent(object.key)}`;
				records.push(
					await copyAndVerifyMediaObject({
						...source,
						object,
						destination: env.RECOVERY_STORAGE,
						destinationKey,
					}),
				);
			}
			const manifestKey = `${prefix}pages/${String(pageNumber).padStart(8, "0")}.json`;
			await env.RECOVERY_STORAGE.put(manifestKey, JSON.stringify(records), {
				httpMetadata: { contentType: "application/json" },
			});
			return {
				cursor: listed.cursor,
				count: records.length,
				bytes: records.reduce((sum, record) => sum + record.size, 0),
				inventory: records.map(
					({ key, size, etag }) => [key, size, etag] as const,
				),
			};
		});
		for (const record of page.inventory)
			destinationInventoryHash.update(JSON.stringify(record));
		count += page.count;
		bytes += page.bytes;
		cursor = page.cursor;
		pageCount++;
		if (count > MAX_CAPTURE_MEDIA_OBJECTS)
			throw new Error("CMS media backup exceeded page limit");
	} while (cursor);
	const copiedInventoryHash = destinationInventoryHash.digest("hex");
	for (let pageNumber = 0; pageNumber < pageCount; pageNumber++) {
		await step.do(`verify-source-media-page-${pageNumber}`, async () => {
			const manifestKey = `${prefix}pages/${String(pageNumber).padStart(8, "0")}.json`;
			const object = await env.RECOVERY_STORAGE.get(manifestKey);
			if (!object) throw new Error("CMS media backup page missing");
			const records = (await object.json()) as Array<{
				key: string;
				size: number;
				sha256: string;
			}>;
			for (const record of records) {
				const current = await digestSourceMediaObject({
					...source,
					key: record.key,
				});
				if (current.bytes !== record.size || current.sha256 !== record.sha256)
					throw new Error("CMS media source bytes changed during capture");
			}
		});
	}
	const verified = await step.do("verify-source-stability", async () => {
		const [current, finalInventory] = await Promise.all([
			readRecoveryAuthority(env, params.slug),
			inventoryMedia(source),
		]);
		if (
			!current ||
			current.siteId !== params.siteId ||
			current.bundle.version !== authority.current.bundle.version ||
			current.bundle.etag !== authority.current.bundle.etag
		)
			throw new Error("CMS recovery bundle changed during capture");
		const stub = env.DB_DO.get(
			env.DB_DO.idFromName(params.slug),
		) as unknown as {
			captureRecoverySnapshot(): Promise<{
				bookmark: string;
				databaseDigest: string;
			} | null>;
		};
		const finalSnapshot = await stub.captureRecoverySnapshot();
		if (
			!finalSnapshot?.bookmark ||
			finalSnapshot.databaseDigest !== authority.databaseDigest
		)
			throw new Error("CMS database changed during recovery capture");
		if (
			finalInventory.count !== initialInventory.count ||
			finalInventory.bytes !== initialInventory.bytes ||
			finalInventory.sha256 !== initialInventory.sha256 ||
			copiedInventoryHash !== initialInventory.sha256 ||
			count !== initialInventory.count ||
			bytes !== initialInventory.bytes
		)
			throw new Error("CMS media inventory changed during recovery capture");
		return true;
	});
	if (!verified) throw new Error("CMS recovery verification failed");
	const capturedAt = authority.capturedAt;
	const retainUntil = new Date(
		Date.parse(capturedAt) + 29 * 24 * 60 * 60 * 1000,
	).toISOString();
	if (Date.now() >= Date.parse(retainUntil))
		throw new Error("CMS recovery bookmark expired before publication");
	const manifest: CmsRecoveryManifestV2 = {
		version: 2,
		siteId: params.siteId,
		slug: params.slug,
		captureId: params.captureId,
		capturedAt,
		retainUntil,
		bookmark: authority.bookmark,
		digestAlgorithm: CMS_RECOVERY_DIGEST_ALGORITHM,
		databaseDigest: authority.databaseDigest,
		bundle: authority.current.bundle,
		media: {
			count,
			bytes,
			pageCount,
			sourceInventorySha256: initialInventory.sha256,
		},
	};
	await step.do("publish-private-manifest", async () => {
		if (assertCapturePause && !(await assertCapturePause()))
			throw new Error(
				"CMS recovery scheduled-write pause expired before publication",
			);
		await env.RECOVERY_STORAGE.put(
			`${prefix}manifest.json`,
			JSON.stringify(manifest),
			{
				httpMetadata: { contentType: "application/json" },
			},
		);
	});
	return manifest;
}

export class CmsRecoveryWorkflow extends WorkflowEntrypoint<
	Env,
	CmsRecoveryParams
> {
	async run(event: WorkflowEvent<CmsRecoveryParams>, step: WorkflowStep) {
		const db = createDbQueryClient(this.env.PLATFORM_DB);
		try {
			const pauseClaimed = await step.do("claim-capture-cron-pause", () =>
				claimCmsCaptureCronPause(db, event.payload),
			);
			if (!pauseClaimed)
				throw new Error("CMS recovery scheduled-write pause unavailable");
			let drained = false;
			for (let attempt = 0; attempt < 60; attempt++) {
				if (
					await step.do(`drain-scheduled-writes-${attempt}`, () =>
						drainCmsCaptureCronPause(db, event.payload),
					)
				) {
					drained = true;
					break;
				}
				await step.sleep(`wait-scheduled-write-drain-${attempt}`, "1 second");
			}
			if (!drained)
				throw new Error("CMS recovery scheduled writes did not drain");
			await captureCmsRecovery(this.env, step, event.payload, () =>
				assertCmsCaptureCronPause(db, event.payload),
			);
			await step.do("assert-capture-pause-before-release", async () => {
				if (!(await assertCmsCaptureCronPause(db, event.payload)))
					throw new Error(
						"CMS recovery scheduled-write pause expired after publication",
					);
			});
			await step.do("release-capture-cron-pause", async () => {
				if (!(await releaseCmsCaptureCronPause(db, event.payload)))
					throw new Error("CMS recovery scheduled-write pause release failed");
			});
			await step.do("mark-capture-verified", async () => {
				const key = cmsRecoveryControlKey(
					event.payload.siteId,
					event.payload.captureId,
				);
				const stored = await this.env.RECOVERY_STORAGE.get(key);
				const control = stored ? await stored.json() : null;
				if (
					!isCmsRecoveryControl(control, event.payload) ||
					(control.state !== "running" && control.state !== "verified")
				)
					throw new Error("CMS recovery control changed before completion");
				if (control.state === "running")
					await putCmsRecoveryControl(this.env.RECOVERY_STORAGE, {
						...control,
						state: "verified",
					});
			});
			return { captureId: event.payload.captureId, status: "verified" };
		} catch (error) {
			try {
				await step.do("abort-failed-capture-cron-pause", () =>
					abortCmsCaptureCronPause(db, event.payload),
				);
			} catch (cleanupError) {
				console.error(
					"[cms-runtime] failed capture pause cleanup failed",
					cleanupError,
				);
			}
			throw error;
		}
	}
}
