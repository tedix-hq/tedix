import {
	claimCmsSiteRestoreReceipt,
	readCmsSiteRestoreReceipt,
	type CmsSiteRestoreReceipt,
} from "./cms-site-restore-receipt";
import { CmsRestoreFenceUnavailableError } from "./tenant-restore-fence";
import { createDbClient } from "@tedix/db/client";
import { createDbQueryClient } from "@tedix/db/query-client";
import { getCmsDeprovisionOperation } from "@tedix/db/queries/cms-deprovision-operations";
import {
	abortCmsCaptureCronPause,
	enterCmsRecoveryPurgePermit,
	leaveCmsRestorePermit,
} from "@tedix/db/queries/cms-restore-fences";
import { getCmsSiteBySlug } from "@tedix/db/queries/cms-sites";
import {
	CMS_RECOVERY_DIGEST_ALGORITHM,
	cmsRecoveryControlKey,
	cmsRecoveryPrefix,
	isCmsRecoveryControl,
	isCmsRecoveryManifest,
	putCmsRecoveryControl,
	purgeCmsRecoveryObjects,
	readRecoveryAuthority,
	readVerifiedCmsRecoveryCapture,
	type CmsRecoveryControl,
	type CmsRecoveryManifest,
} from "./cms-recovery-workflow";
import { type Env } from "./env";
import {
	CMS_RECOVERY_ADMIN_PATH,
	CMS_SITE_RESTORE_ADMIN_PATH,
	jsonResponse,
	isInternalCmsRequest,
} from "./internal-admin-http";

/** Internal only. Owner responses omit raw bookmarks and private object keys. */
export async function cmsRecoveryAdminResponse(args: {
	env: Env;
	request: Request;
	slug: string;
	url: URL;
}): Promise<Response | null> {
	const { env, request, slug, url } = args;
	if (url.pathname !== CMS_RECOVERY_ADMIN_PATH) return null;
	if (!isInternalCmsRequest(request, env))
		return jsonResponse({ ok: false, error: "unauthorized" }, { status: 401 });
	if (!["GET", "POST", "DELETE"].includes(request.method))
		return jsonResponse(
			{ ok: false, error: "method not allowed" },
			{
				status: 405,
				headers: { Allow: "GET, POST, DELETE" },
			},
		);
	const siteId = url.searchParams.get("siteId");
	if (!siteId || !/^[0-9a-f-]{36}$/.test(siteId))
		return jsonResponse(
			{ ok: false, error: "site ID required" },
			{ status: 400 },
		);
	if (request.method === "POST") {
		const authority = await readRecoveryAuthority(env, slug);
		if (!authority || authority.siteId !== siteId)
			return jsonResponse(
				{ ok: false, error: "active exact CMS site required" },
				{ status: 404 },
			);
		const captureId = crypto.randomUUID();
		const control: CmsRecoveryControl = {
			version: 1,
			siteId,
			slug,
			captureId,
			createdAt: new Date().toISOString(),
			state: "queued",
		};
		await putCmsRecoveryControl(env.RECOVERY_STORAGE, control);
		let status: "queued" | "unknown" = "queued";
		try {
			await env.CMS_RECOVERY_WORKFLOW.create({
				id: `${siteId}-${captureId}`,
				params: { siteId, slug, captureId },
			});
		} catch {
			// The create call can fail after admission. Keep the durable receipt so
			// status/purge remain available while the true run state is reconciled.
			status = "unknown";
		}
		return jsonResponse(
			{ ok: true, siteId, captureId, status },
			{
				status: 202,
				headers: { "Cache-Control": "no-store" },
			},
		);
	}
	const captureId = url.searchParams.get("captureId");
	if (request.method === "GET" && !captureId) {
		let cursor: string | undefined;
		let latest: CmsRecoveryManifest | null = null;
		const seen = new Set<string>();
		let scanned = 0;
		do {
			const page = await env.RECOVERY_STORAGE.list({
				prefix: `recovery/${siteId}/`,
				delimiter: "/",
				cursor,
				limit: 100,
			});
			for (const capturePrefix of page.delimitedPrefixes) {
				if (++scanned > 1000)
					throw new Error("CMS recovery capture inventory exceeded limit");
				const candidateCaptureId = capturePrefix.split("/")[2];
				if (!candidateCaptureId || !/^[0-9a-f-]{36}$/.test(candidateCaptureId))
					continue;
				const identity = { siteId, slug, captureId: candidateCaptureId };
				const storedControl = await env.RECOVERY_STORAGE.get(
					cmsRecoveryControlKey(siteId, candidateCaptureId),
				);
				if (!storedControl) continue;
				let control: unknown;
				try {
					control = await storedControl.json();
				} catch {
					continue;
				}
				if (
					!isCmsRecoveryControl(control, identity) ||
					control.state !== "verified"
				)
					continue;
				const stored = await env.RECOVERY_STORAGE.get(
					`${capturePrefix}manifest.json`,
				);
				if (!stored) continue;
				let candidate: unknown;
				try {
					candidate = await stored.json();
				} catch {
					continue;
				}
				if (
					!isCmsRecoveryManifest(candidate, identity) ||
					Date.now() >= Date.parse(candidate.retainUntil)
				)
					continue;
				if (!latest || candidate.capturedAt > latest.capturedAt)
					latest = candidate;
			}
			cursor = page.truncated ? page.cursor : undefined;
			if (cursor) {
				if (seen.has(cursor))
					throw new Error("CMS recovery list cursor repeated");
				seen.add(cursor);
			}
		} while (cursor);
		return jsonResponse(
			{
				ok: true,
				siteId,
				status: latest ? "verified" : "missing",
				...(latest
					? {
							captureId: latest.captureId,
							capturedAt: latest.capturedAt,
							retainUntil: latest.retainUntil,
							bundle: latest.bundle,
							media: { count: latest.media.count, bytes: latest.media.bytes },
						}
					: {}),
			},
			{ headers: { "Cache-Control": "no-store" } },
		);
	}
	if (!captureId || !/^[0-9a-f-]{36}$/.test(captureId))
		return jsonResponse(
			{ ok: false, error: "capture ID required" },
			{ status: 400 },
		);
	let purgePermit: {
		db: ReturnType<typeof createDbQueryClient>;
		permitId: string;
		restoreEpoch: number;
	} | null = null;
	if (request.method === "DELETE") {
		try {
			const db = createDbQueryClient(env.PLATFORM_DB);
			const site = await getCmsSiteBySlug(db, slug);
			if (site?.id === siteId) {
				const permitId = crypto.randomUUID();
				if (
					!(await enterCmsRecoveryPurgePermit(db, {
						siteId,
						slug,
						permitId,
						restoreEpoch: site.restoreEpoch,
						kind: "nested",
					}))
				)
					return jsonResponse(
						{ ok: false, error: "CMS recovery purge is fenced" },
						{ status: 409 },
					);
				purgePermit = { db, permitId, restoreEpoch: site.restoreEpoch };
			} else {
				// A completed deprovision receipt retains purge authority after the
				// canonical site row is gone, even if another site reuses its slug.
				const receipt = await getCmsDeprovisionOperation(db, siteId);
				if (!receipt || receipt.slug !== slug || receipt.status !== "succeeded")
					return jsonResponse(
						{ ok: false, error: "CMS recovery purge authority missing" },
						{ status: 409 },
					);
			}
		} catch {
			return jsonResponse(
				{ ok: false, error: "CMS recovery purge authority unavailable" },
				{ status: 503 },
			);
		}
	}
	const respond = async (): Promise<Response> => {
		const prefix = cmsRecoveryPrefix(siteId, captureId);
		const identity = { siteId, slug, captureId };
		const storedControl = await env.RECOVERY_STORAGE.get(
			cmsRecoveryControlKey(siteId, captureId),
		);
		if (!storedControl)
			return jsonResponse(
				{ ok: false, error: "capture not found" },
				{ status: 404 },
			);
		let controlValue: unknown;
		try {
			controlValue = await storedControl.json();
		} catch {
			return jsonResponse(
				{ ok: false, error: "capture control invalid" },
				{ status: 409 },
			);
		}
		if (!isCmsRecoveryControl(controlValue, identity))
			return jsonResponse(
				{ ok: false, error: "capture ownership mismatch" },
				{ status: 409 },
			);
		const control = controlValue;
		const manifestKey = `${prefix}manifest.json`;
		const manifestObject = await env.RECOVERY_STORAGE.get(manifestKey);
		let manifestValue: unknown;
		try {
			manifestValue = manifestObject ? await manifestObject.json() : null;
		} catch {
			manifestValue = null;
		}
		const manifest = isCmsRecoveryManifest(manifestValue, identity)
			? manifestValue
			: null;
		const invalidManifest = !!manifestObject && !manifest;
		let workflow: Awaited<ReturnType<WorkflowInstance["status"]>> | null = null;
		try {
			const instance = await env.CMS_RECOVERY_WORKFLOW.get(
				`${siteId}-${captureId}`,
			);
			workflow = await instance.status();
		} catch {
			// Workflow history can expire while the private control and backup remain.
		}
		if (request.method === "GET") {
			const expired = manifest
				? Date.now() >= Date.parse(manifest.retainUntil)
				: false;
			const failed =
				invalidManifest ||
				(control.state === "verified" && !manifest) ||
				workflow?.status === "errored" ||
				workflow?.status === "terminated";
			const staleUnknown =
				!workflow &&
				(control.state === "queued" || control.state === "running") &&
				Date.now() - Date.parse(control.createdAt) >= 24 * 60 * 60 * 1000;
			const status =
				control.state === "purged" ||
				control.state === "purging" ||
				control.state === "failed"
					? control.state
					: failed
						? "failed"
						: manifest && control.state === "verified"
							? expired
								? "expired"
								: "verified"
							: staleUnknown
								? "unknown"
								: workflow?.status === "queued" ||
									  workflow?.status === "running"
									? workflow.status
									: control.state;
			return jsonResponse(
				{
					ok: true,
					siteId,
					captureId,
					status,
					...(manifest && (status === "verified" || status === "expired")
						? {
								capturedAt: manifest.capturedAt,
								retainUntil: manifest.retainUntil,
								bundle: manifest.bundle,
								media: {
									count: manifest.media.count,
									bytes: manifest.media.bytes,
								},
							}
						: {}),
				},
				{ headers: { "Cache-Control": "no-store" } },
			);
		}
		if (control.state === "purged") {
			await abortCmsCaptureCronPause(
				createDbQueryClient(env.PLATFORM_DB),
				identity,
			);
			return jsonResponse(
				{ ok: true, siteId, captureId, status: "purged" },
				{ headers: { "Cache-Control": "no-store" } },
			);
		}
		if (control.state !== "purging") {
			if (
				workflow &&
				!["complete", "errored", "terminated"].includes(workflow.status)
			)
				return jsonResponse(
					{ ok: false, error: "capture still running" },
					{ status: 409 },
				);
			if (
				!workflow &&
				control.state !== "verified" &&
				control.state !== "failed"
			)
				return jsonResponse(
					{ ok: false, error: "capture terminal state unavailable" },
					{ status: 409 },
				);
		}
		await abortCmsCaptureCronPause(
			createDbQueryClient(env.PLATFORM_DB),
			identity,
		);
		await purgeCmsRecoveryObjects(env.RECOVERY_STORAGE, control);
		return jsonResponse(
			{ ok: true, siteId, captureId, status: "purged" },
			{ headers: { "Cache-Control": "no-store" } },
		);
	};
	let outcome: { ok: true; response: Response } | { ok: false; error: unknown };
	try {
		outcome = { ok: true, response: await respond() };
	} catch (error) {
		outcome = { ok: false, error };
	}
	if (purgePermit) {
		const { db, permitId, restoreEpoch } = purgePermit;
		try {
			if (
				!(await leaveCmsRestorePermit(db, {
					siteId,
					slug,
					permitId,
					restoreEpoch,
					kind: "nested",
				}))
			)
				throw new CmsRestoreFenceUnavailableError();
		} catch {
			throw new CmsRestoreFenceUnavailableError();
		}
	}
	if (!outcome.ok) throw outcome.error;
	return outcome.response;
}

/** Read only the schema facts needed to diagnose a failed Emdash field create. */
function publicCmsSiteRestoreStatus(receipt: CmsSiteRestoreReceipt) {
	return {
		ok: true,
		siteId: receipt.siteId,
		captureId: receipt.captureId,
		generation: receipt.generation,
		phase: receipt.phase,
		createdAt: receipt.createdAt,
		updatedAt: receipt.updatedAt,
		...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
	};
}

/** Service-only exact-site admission and sanitized status for general restore. */
export async function cmsSiteRestoreAdminResponse(args: {
	env: Env;
	request: Request;
	slug: string;
	url: URL;
}): Promise<Response | null> {
	const { env, request, slug, url } = args;
	if (url.pathname !== CMS_SITE_RESTORE_ADMIN_PATH) return null;
	if (!isInternalCmsRequest(request, env))
		return jsonResponse({ ok: false, error: "unauthorized" }, { status: 401 });
	if (request.method !== "GET" && request.method !== "POST")
		return jsonResponse(
			{ ok: false, error: "method not allowed" },
			{ status: 405, headers: { Allow: "GET, POST" } },
		);
	const siteId = url.searchParams.get("siteId");
	if (!siteId || !/^[0-9a-f-]{36}$/.test(siteId))
		return jsonResponse(
			{ ok: false, error: "site ID required" },
			{ status: 400 },
		);
	const db = createDbClient(env.PLATFORM_DB);
	const site = await getCmsSiteBySlug(db, slug);
	if (site?.id !== siteId)
		return jsonResponse(
			{ ok: false, error: "exact CMS site required" },
			{ status: 404 },
		);
	if (request.method === "GET") {
		if (url.searchParams.get("list") === "1") {
			const receipts: ReturnType<typeof publicCmsSiteRestoreStatus>[] = [];
			let cursor: string | undefined;
			do {
				const page = await env.RECOVERY_STORAGE.list({
					prefix: `recovery/restores/${siteId}/`,
					...(cursor ? { cursor } : {}),
				});
				for (const object of page.objects) {
					const match = object.key.match(
						new RegExp(
							`^recovery/restores/${siteId}/([0-9a-f-]{36})/receipt\\.json$`,
						),
					);
					if (!match) continue;
					const raw = await env.RECOVERY_STORAGE.get(object.key);
					if (!raw) throw new Error("CMS restore receipt disappeared");
					const candidate =
						(await raw.json()) as Partial<CmsSiteRestoreReceipt>;
					if (typeof candidate.captureId !== "string")
						throw new Error("CMS restore receipt invalid");
					const state = await readCmsSiteRestoreReceipt(env.RECOVERY_STORAGE, {
						siteId,
						slug,
						captureId: candidate.captureId,
						generation: match[1]!,
					});
					if (!state) throw new Error("CMS restore receipt disappeared");
					receipts.push(publicCmsSiteRestoreStatus(state.receipt));
				}
				cursor = page.truncated ? page.cursor : undefined;
			} while (cursor);
			return jsonResponse(
				{ ok: true, receipts },
				{
					headers: { "Cache-Control": "no-store" },
				},
			);
		}
		const preflightCaptureId = url.searchParams.get("preflightCaptureId");
		if (preflightCaptureId) {
			if (!/^[0-9a-f-]{36}$/.test(preflightCaptureId))
				return jsonResponse(
					{ ok: false, error: "capture ID invalid" },
					{ status: 400 },
				);
			const authority = await readRecoveryAuthority(env, slug);
			if (authority?.siteId !== siteId)
				return jsonResponse(
					{ ok: false, error: "active CMS authority unavailable" },
					{ status: 409 },
				);
			try {
				const target = await readVerifiedCmsRecoveryCapture(
					env.RECOVERY_STORAGE,
					{
						siteId,
						slug,
						captureId: preflightCaptureId,
					},
				);
				return jsonResponse(
					{
						ok: true,
						restorable:
							target.manifest.version === 2 &&
							target.manifest.digestAlgorithm ===
								CMS_RECOVERY_DIGEST_ALGORITHM &&
							target.manifest.bundle.version === authority.bundle.version &&
							target.manifest.bundle.etag === authority.bundle.etag,
					},
					{ headers: { "Cache-Control": "no-store" } },
				);
			} catch (error) {
				console.error("CMS restore preflight failed", error);
				return jsonResponse(
					{ ok: false, error: "capture verification failed" },
					{ status: 409 },
				);
			}
		}
		const generation = url.searchParams.get("generation");
		if (!generation || !/^[0-9a-f-]{36}$/.test(generation))
			return jsonResponse(
				{ ok: false, error: "generation required" },
				{ status: 400 },
			);
		const raw = await env.RECOVERY_STORAGE.get(
			`recovery/restores/${siteId}/${generation}/receipt.json`,
		);
		if (!raw)
			return jsonResponse(
				{ ok: false, error: "restore not found" },
				{ status: 404 },
			);
		const candidate = (await raw.json()) as Partial<CmsSiteRestoreReceipt>;
		if (typeof candidate.captureId !== "string")
			throw new Error("CMS restore receipt invalid");
		const state = await readCmsSiteRestoreReceipt(env.RECOVERY_STORAGE, {
			siteId,
			slug,
			captureId: candidate.captureId,
			generation,
		});
		if (!state) throw new Error("CMS restore receipt disappeared");
		return jsonResponse(publicCmsSiteRestoreStatus(state.receipt), {
			headers: { "Cache-Control": "no-store" },
		});
	}
	if (site.status !== "active")
		return jsonResponse(
			{ ok: false, error: "active CMS site required" },
			{ status: 409 },
		);
	let body: { siteId?: unknown; captureId?: unknown; mode?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return jsonResponse(
			{ ok: false, error: "invalid request" },
			{ status: 400 },
		);
	}
	if (
		body.siteId !== siteId ||
		typeof body.captureId !== "string" ||
		!/^[0-9a-f-]{36}$/.test(body.captureId) ||
		(body.mode !== "restore" && body.mode !== "roundtrip")
	)
		return jsonResponse(
			{ ok: false, error: "invalid request" },
			{ status: 400 },
		);
	const authority = await readRecoveryAuthority(env, slug);
	if (authority?.siteId !== siteId)
		return jsonResponse(
			{ ok: false, error: "active CMS authority unavailable" },
			{ status: 409 },
		);
	const identity = { siteId, slug, captureId: body.captureId };
	const target = await readVerifiedCmsRecoveryCapture(
		env.RECOVERY_STORAGE,
		identity,
	);
	if (
		target.manifest.version !== 2 ||
		target.manifest.digestAlgorithm !== CMS_RECOVERY_DIGEST_ALGORITHM ||
		target.manifest.bundle.version !== authority.bundle.version ||
		target.manifest.bundle.etag !== authority.bundle.etag
	)
		return jsonResponse(
			{ ok: false, error: "restorable v2 capture required" },
			{ status: 409 },
		);
	const generation = crypto.randomUUID();
	const now = new Date().toISOString();
	const receipt: CmsSiteRestoreReceipt = {
		version: 1,
		...identity,
		generation,
		phase: "claimed",
		mode: body.mode,
		createdAt: now,
		updatedAt: now,
		bundle: authority.bundle,
	};
	await claimCmsSiteRestoreReceipt(env.RECOVERY_STORAGE, receipt);
	try {
		await env.CMS_SITE_RESTORE_WORKFLOW.create({
			id: `${siteId}-${generation}`,
			params: { ...identity, generation, mode: body.mode },
		});
	} catch {
		// The Workflow create result can be lost after admission. The immutable
		// receipt and deterministic instance ID preserve operator reconciliation.
	}
	return jsonResponse(publicCmsSiteRestoreStatus(receipt), {
		status: 202,
		headers: { "Cache-Control": "no-store" },
	});
}
