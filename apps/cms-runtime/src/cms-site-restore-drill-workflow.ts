import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { createHash } from "node:crypto";
import {
	cmsRecoveryPrefix,
	readRecoveryAuthority,
	readVerifiedCmsRecoveryCapture,
} from "./cms-recovery-workflow";
import {
	assertSourceMediaMatches,
	deleteSourceMediaObject,
	restoreSourceMediaObject,
	type VerifiedMediaObject,
} from "./tenant-media-backup";
import type { Env } from "./index";

export const CMS_SITE_DRILL_SITE_ID = "13d1b0d0-2664-4006-981b-d27af4e73794";
export const CMS_SITE_DRILL_SLUG = "emdash1rc-src-20260928";
export const CMS_SITE_DRILL_CAPTURE_ID = "8b7637c1-39b2-41ba-9bac-33fc7e19be7b";
export const CMS_SITE_DRILL_INSTANCE_ID = "cms-site-restore-drill-v2";
export const CMS_SITE_DRILL_BASELINE_DIGEST =
	"4efb15485184356662896098d726ee73e3ebb380469e0e191d1b30c07866ed95";
export const CMS_SITE_DRILL_PREFIX = `recovery/site-drills/${CMS_SITE_DRILL_SITE_ID}/${CMS_SITE_DRILL_CAPTURE_ID}/`;
export const CMS_SITE_DRILL_RECEIPT_KEY = `${CMS_SITE_DRILL_PREFIX}receipt.json`;
const SITE_ORIGIN = `https://${CMS_SITE_DRILL_SLUG}.cms.tedix.dev`;
const PROOF_POST_PATH = "/posts/native-taxonomy-archive-proof/";

export type CmsSiteDrillPhase =
	| "claimed"
	| "mutated"
	| "media-deleted"
	| "restore-scheduled"
	| "restored"
	| "undo-scheduled"
	| "undone"
	| "final-scheduled"
	| "verified";

export interface CmsSiteDrillReceipt {
	version: 1;
	phase: CmsSiteDrillPhase;
	siteId: typeof CMS_SITE_DRILL_SITE_ID;
	captureId: typeof CMS_SITE_DRILL_CAPTURE_ID;
	mediaKey: string;
	mediaSha256: string;
	postId: string;
	postStatus: string;
	postDigest: string;
	databaseDigest: string;
	schedulerHeartbeatValue: string | null;
	schedulerHeartbeatRevision: string | null;
	undoBookmark?: string;
	redoBookmark?: string;
	finalUndoBookmark?: string;
}

export interface CmsSiteDrillProof {
	bookmark: string;
	sentinel: "absent" | "after";
	post: { id: string; slug: string; status: string };
	postDigest: string;
	mediaKeys: string[];
	databaseDigest: string;
	schedulerHeartbeatValue: string | null;
	schedulerHeartbeatRevision: string | null;
}

export interface CmsSiteDrillStub {
	readSiteDrillProof(): Promise<CmsSiteDrillProof>;
	prepareSiteDrillMutation(): Promise<void>;
	scheduleSiteDrillRestore(): Promise<void>;
	restartSiteDrill(): Promise<void>;
	scheduleSiteDrillUndo(): Promise<void>;
	scheduleSiteDrillFinalRestore(): Promise<void>;
}

export function insertSiteDrillSentinel(storage: DurableObjectStorage): void {
	storage.transactionSync(() => {
		storage.sql.exec(
			"CREATE TABLE _tedix_cms_restore_drill (id INTEGER PRIMARY KEY, state TEXT NOT NULL)",
		);
		storage.sql.exec(
			"INSERT INTO _tedix_cms_restore_drill (id, state) VALUES (1, 'after')",
		);
	});
}

export function cmsSiteDrillStub(env: Pick<Env, "DB_DO">): CmsSiteDrillStub {
	return env.DB_DO.get(
		env.DB_DO.idFromName(CMS_SITE_DRILL_SLUG),
	) as unknown as CmsSiteDrillStub;
}

export async function readSiteDrillReceipt(
	storage: R2Bucket,
): Promise<CmsSiteDrillReceipt | null> {
	const object = await storage.get(CMS_SITE_DRILL_RECEIPT_KEY);
	if (!object) return null;
	const value = (await object.json()) as Partial<CmsSiteDrillReceipt>;
	if (
		value.version !== 1 ||
		value.siteId !== CMS_SITE_DRILL_SITE_ID ||
		value.captureId !== CMS_SITE_DRILL_CAPTURE_ID ||
		![
			"claimed",
			"mutated",
			"media-deleted",
			"restore-scheduled",
			"restored",
			"undo-scheduled",
			"undone",
			"final-scheduled",
			"verified",
		].includes(value.phase ?? "") ||
		!value.mediaKey ||
		!/^[0-9a-f]{64}$/.test(value.mediaSha256 ?? "") ||
		!value.postId ||
		!value.postStatus ||
		!/^[0-9a-f]{64}$/.test(value.postDigest ?? "") ||
		value.databaseDigest !== CMS_SITE_DRILL_BASELINE_DIGEST ||
		(value.schedulerHeartbeatValue !== null &&
			typeof value.schedulerHeartbeatValue !== "string") ||
		(value.schedulerHeartbeatRevision !== null &&
			typeof value.schedulerHeartbeatRevision !== "string") ||
		([
			"restore-scheduled",
			"restored",
			"undo-scheduled",
			"undone",
			"final-scheduled",
			"verified",
		].includes(value.phase ?? "") &&
			!value.undoBookmark) ||
		(["undo-scheduled", "undone", "final-scheduled", "verified"].includes(
			value.phase ?? "",
		) &&
			!value.redoBookmark) ||
		(["final-scheduled", "verified"].includes(value.phase ?? "") &&
			!value.finalUndoBookmark)
	)
		throw new Error("CMS site restore drill receipt invalid");
	return value as CmsSiteDrillReceipt;
}

export async function writeSiteDrillReceipt(
	storage: R2Bucket,
	receipt: CmsSiteDrillReceipt,
	claim = false,
): Promise<void> {
	const result = await storage.put(
		CMS_SITE_DRILL_RECEIPT_KEY,
		JSON.stringify(receipt),
		{
			httpMetadata: { contentType: "application/json" },
			...(claim ? { onlyIf: new Headers({ "If-None-Match": "*" }) } : {}),
		},
	);
	if (!result) throw new Error("CMS site restore drill receipt claim failed");
}

function mediaUrl(key: string, phase: string): string {
	const path = key.split("/").map(encodeURIComponent).join("/");
	return `${SITE_ORIGIN}/_emdash/api/media/file/${path}?tedix-site-drill=${phase}`;
}

async function assertPublicPost(): Promise<void> {
	const response = await fetch(`${SITE_ORIGIN}${PROOF_POST_PATH}`, {
		headers: { "Cache-Control": "no-cache" },
	});
	if (
		!response.ok ||
		!(await response.text()).includes("Native taxonomy archive proof")
	)
		throw new Error("CMS site restore drill native public post failed");
}

async function assertPublicMedia(
	record: VerifiedMediaObject,
	phase: string,
	present: boolean,
): Promise<void> {
	const response = await fetch(mediaUrl(record.key, phase), {
		headers: { "Cache-Control": "no-cache" },
	});
	if (!present) {
		if (response.status !== 404)
			throw new Error(
				"CMS site restore drill missing media route still serves",
			);
		return;
	}
	if (!response.ok)
		throw new Error(
			`CMS site restore drill media route failed: ${response.status}`,
		);
	if (!response.body)
		throw new Error("CMS site restore drill public media body missing");
	const hash = createHash("sha256");
	let bytes = 0;
	for await (const chunk of response.body) {
		hash.update(chunk);
		bytes += chunk.byteLength;
	}
	if (bytes !== record.size || hash.digest("hex") !== record.sha256)
		throw new Error("CMS site restore drill public media bytes mismatch");
}

function mediaSource(env: Env) {
	return {
		accountId: env.CF_ACCOUNT_ID,
		token: env.CLOUDFLARE_R2_API_TOKEN,
		slug: CMS_SITE_DRILL_SLUG,
	};
}

async function capture(env: Env) {
	return readSiteDrillCapture(env.RECOVERY_STORAGE);
}

/** Make a private, verified copy outside the capture purge prefix. */
export async function readSiteDrillCapture(storage: R2Bucket) {
	const identity = {
		siteId: CMS_SITE_DRILL_SITE_ID,
		slug: CMS_SITE_DRILL_SLUG,
		captureId: CMS_SITE_DRILL_CAPTURE_ID,
	};
	if (await storage.get(`${CMS_SITE_DRILL_PREFIX}manifest.json`))
		return readVerifiedCmsRecoveryCapture(
			storage,
			identity,
			CMS_SITE_DRILL_PREFIX,
		);
	const original = await readVerifiedCmsRecoveryCapture(storage, identity);
	if (original.manifest.media.pageCount !== 1)
		throw new Error("CMS site restore drill expected one captured media page");
	const originalPrefix = cmsRecoveryPrefix(
		CMS_SITE_DRILL_SITE_ID,
		CMS_SITE_DRILL_CAPTURE_ID,
	);
	for (const record of original.records) {
		const source = await storage.get(
			`${originalPrefix}media/${encodeURIComponent(record.key)}`,
		);
		if (!source?.body || source.size !== record.size)
			throw new Error("CMS site restore drill source backup disappeared");
		const sourceHash = createHash("sha256");
		let sourceBytes = 0;
		const stream = source.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					sourceHash.update(chunk);
					sourceBytes += chunk.byteLength;
					controller.enqueue(chunk);
				},
			}),
		);
		const fixedLength = new FixedLengthStream(record.size);
		const abort = new AbortController();
		const piping = stream.pipeTo(fixedLength.writable, {
			signal: abort.signal,
		});
		const destinationKey = `${CMS_SITE_DRILL_PREFIX}media/${encodeURIComponent(record.key)}`;
		const storing = Promise.resolve().then(() =>
			storage.put(destinationKey, fixedLength.readable, {
				httpMetadata: {
					contentType: record.contentType,
					cacheControl: record.cacheControl,
					contentDisposition: record.contentDisposition,
					contentEncoding: record.contentEncoding,
					contentLanguage: record.contentLanguage,
				},
			}),
		);
		let written: R2Object | null;
		try {
			[written] = await Promise.all([storing, piping]);
		} catch (error) {
			abort.abort();
			await Promise.allSettled([storing, piping]);
			throw error;
		}
		if (
			!written ||
			sourceBytes !== record.size ||
			written.size !== sourceBytes ||
			sourceHash.digest("hex") !== record.sha256
		)
			throw new Error("CMS site restore drill source copy digest mismatch");
		const reread = await storage.get(destinationKey);
		if (!reread?.body || reread.size !== record.size)
			throw new Error("CMS site restore drill copied backup missing");
		const targetHash = createHash("sha256");
		let targetBytes = 0;
		for await (const chunk of reread.body) {
			targetHash.update(chunk);
			targetBytes += chunk.byteLength;
		}
		if (
			targetBytes !== record.size ||
			targetHash.digest("hex") !== record.sha256
		)
			throw new Error("CMS site restore drill copied backup digest mismatch");
	}
	await storage.put(
		`${CMS_SITE_DRILL_PREFIX}pages/00000000.json`,
		JSON.stringify(original.records),
		{ httpMetadata: { contentType: "application/json" } },
	);
	await storage.put(
		`${CMS_SITE_DRILL_PREFIX}control.json`,
		JSON.stringify({
			version: 1,
			siteId: CMS_SITE_DRILL_SITE_ID,
			slug: CMS_SITE_DRILL_SLUG,
			captureId: CMS_SITE_DRILL_CAPTURE_ID,
			createdAt: original.manifest.capturedAt,
			state: "verified",
		}),
		{ httpMetadata: { contentType: "application/json" } },
	);
	await storage.put(
		`${CMS_SITE_DRILL_PREFIX}manifest.json`,
		JSON.stringify(original.manifest),
		{ httpMetadata: { contentType: "application/json" } },
	);
	return readVerifiedCmsRecoveryCapture(
		storage,
		identity,
		CMS_SITE_DRILL_PREFIX,
	);
}

async function assertBundle(
	env: Env,
	bundle: { version: number; etag: string },
) {
	const current = await readRecoveryAuthority(env, CMS_SITE_DRILL_SLUG);
	if (
		current?.siteId !== CMS_SITE_DRILL_SITE_ID ||
		current.bundle.version !== bundle.version ||
		current.bundle.etag !== bundle.etag
	)
		throw new Error("CMS site restore drill authority or bundle drifted");
}

async function deleteOnlyExpectedMedia(
	env: Env,
	records: VerifiedMediaObject[],
	record: VerifiedMediaObject,
): Promise<void> {
	const source = mediaSource(env);
	try {
		await assertSourceMediaMatches({
			...source,
			records,
			missingKey: record.key,
		});
		return;
	} catch {
		await assertSourceMediaMatches({ ...source, records });
	}
	await deleteSourceMediaObject({ ...source, key: record.key });
	await assertSourceMediaMatches({
		...source,
		records,
		missingKey: record.key,
	});
}

async function restoreOnlyExpectedMedia(
	env: Env,
	records: VerifiedMediaObject[],
	record: VerifiedMediaObject,
): Promise<void> {
	const source = mediaSource(env);
	try {
		await assertSourceMediaMatches({ ...source, records });
		return;
	} catch {
		await assertSourceMediaMatches({
			...source,
			records,
			missingKey: record.key,
		});
	}
	await restoreSourceMediaObject({
		...source,
		record,
		backup: env.RECOVERY_STORAGE,
		backupKey: `${CMS_SITE_DRILL_PREFIX}media/${encodeURIComponent(record.key)}`,
	});
	await assertSourceMediaMatches({ ...source, records });
}

async function assertDbProof(
	env: Env,
	receipt: CmsSiteDrillReceipt,
	sentinel: CmsSiteDrillProof["sentinel"],
): Promise<CmsSiteDrillProof> {
	const proof = await cmsSiteDrillStub(env).readSiteDrillProof();
	if (
		proof.sentinel !== sentinel ||
		proof.post.id !== receipt.postId ||
		proof.post.slug !== "native-taxonomy-archive-proof" ||
		proof.post.status !== receipt.postStatus ||
		proof.postDigest !== receipt.postDigest ||
		!proof.mediaKeys.includes(receipt.mediaKey) ||
		proof.databaseDigest !== receipt.databaseDigest ||
		proof.schedulerHeartbeatValue !== receipt.schedulerHeartbeatValue ||
		proof.schedulerHeartbeatRevision !== receipt.schedulerHeartbeatRevision
	)
		throw new Error("CMS site restore drill database proof mismatch");
	await assertPublicPost();
	return proof;
}

async function advance(
	env: Env,
	receipt: CmsSiteDrillReceipt,
	phase: CmsSiteDrillPhase,
): Promise<void> {
	const current = await readSiteDrillReceipt(env.RECOVERY_STORAGE);
	if (!current || current.mediaKey !== receipt.mediaKey)
		throw new Error("CMS site restore drill receipt changed");
	await writeSiteDrillReceipt(env.RECOVERY_STORAGE, { ...current, phase });
}

/** Input-free provider Workflow; the fixed instance ID is its single-run claim. */
export async function runCmsSiteRestoreDrill(
	env: Env,
	step: WorkflowStep,
	instanceId: string,
	payload: unknown,
): Promise<{ status: "verified"; evidence: "fresh" | "prior" }> {
	if (instanceId !== CMS_SITE_DRILL_INSTANCE_ID)
		throw new Error(
			"CMS site restore drill requires fixed Workflow instance ID",
		);
	if (
		!payload ||
		typeof payload !== "object" ||
		Array.isArray(payload) ||
		Object.keys(payload).length !== 0
	)
		throw new Error("CMS site restore drill accepts only empty parameters");
	const prior = await readSiteDrillReceipt(env.RECOVERY_STORAGE);
	if (prior?.phase === "verified")
		return { status: "verified", evidence: "prior" };
	const { manifest, records } = await capture(env);
	const receipt = await step.do("preflight-and-claim-fixed-site", async () => {
		const existing = await readSiteDrillReceipt(env.RECOVERY_STORAGE);
		if (existing) return existing;
		await assertBundle(env, manifest.bundle);
		await assertSourceMediaMatches({ ...mediaSource(env), records });
		const proof = await cmsSiteDrillStub(env).readSiteDrillProof();
		if (
			proof.sentinel !== "absent" ||
			proof.databaseDigest !== CMS_SITE_DRILL_BASELINE_DIGEST
		)
			throw new Error("CMS site restore drill database drifted from capture");
		await assertPublicPost();
		let selected: VerifiedMediaObject | undefined;
		for (const candidate of records) {
			if (!proof.mediaKeys.includes(candidate.key)) continue;
			try {
				await assertPublicMedia(candidate, "preflight", true);
				selected = candidate;
				break;
			} catch {
				// Try the next captured native media row; no mutation has happened.
			}
		}
		if (!selected)
			throw new Error(
				"CMS site restore drill has no publicly served captured media",
			);
		const claimed: CmsSiteDrillReceipt = {
			version: 1,
			phase: "claimed",
			siteId: CMS_SITE_DRILL_SITE_ID,
			captureId: CMS_SITE_DRILL_CAPTURE_ID,
			mediaKey: selected.key,
			mediaSha256: selected.sha256,
			postId: proof.post.id,
			postStatus: proof.post.status,
			postDigest: proof.postDigest,
			databaseDigest: proof.databaseDigest,
			schedulerHeartbeatValue: proof.schedulerHeartbeatValue,
			schedulerHeartbeatRevision: proof.schedulerHeartbeatRevision,
		};
		await writeSiteDrillReceipt(env.RECOVERY_STORAGE, claimed, true);
		return claimed;
	});
	const record = records.find(
		(item) =>
			item.key === receipt.mediaKey && item.sha256 === receipt.mediaSha256,
	);
	if (!record) throw new Error("CMS site restore drill selected media changed");
	await step.do("mutate-fixed-site-sentinel", async () => {
		await assertBundle(env, manifest.bundle);
		await cmsSiteDrillStub(env).prepareSiteDrillMutation();
	});
	try {
		await step.do("delete-one-captured-media-object", async () => {
			await assertDbProof(env, receipt, "after");
			await deleteOnlyExpectedMedia(env, records, record);
			await assertPublicMedia(record, "deleted-first", false);
			await advance(env, receipt, "media-deleted");
		});
		await step.do("schedule-fixed-site-restore", async () => {
			// A failed prior attempt may have compensated the deletion after the
			// delete step committed. Re-apply only this one recorded mutation.
			await deleteOnlyExpectedMedia(env, records, record);
			await assertPublicMedia(record, "deleted-before-schedule", false);
			const current = await readSiteDrillReceipt(env.RECOVERY_STORAGE);
			if (current?.phase === "mutated")
				await advance(env, receipt, "media-deleted");
			await assertSourceMediaMatches({
				...mediaSource(env),
				records,
				missingKey: record.key,
			});
			await cmsSiteDrillStub(env).scheduleSiteDrillRestore();
		});
		await step.do("restart-and-verify-fixed-site-restore", async () => {
			try {
				await cmsSiteDrillStub(env).restartSiteDrill();
			} catch {
				// ctx.abort disconnects RPC; the fresh read is the only success proof.
			}
			await assertDbProof(env, receipt, "absent");
		});
		await step.do("restore-and-verify-captured-media", async () => {
			await restoreOnlyExpectedMedia(env, records, record);
			await assertPublicMedia(record, "restored-first", true);
			await advance(env, receipt, "restored");
		});
		await step.do("schedule-fixed-site-undo", () =>
			cmsSiteDrillStub(env).scheduleSiteDrillUndo(),
		);
		await step.do("restart-and-verify-fixed-site-undo", async () => {
			try {
				await cmsSiteDrillStub(env).restartSiteDrill();
			} catch {
				// Fresh state proves the provider's undo applied.
			}
			await assertDbProof(env, receipt, "after");
		});
		await step.do("undo-one-media-deletion", async () => {
			await deleteOnlyExpectedMedia(env, records, record);
			await assertPublicMedia(record, "deleted-undo", false);
			await advance(env, receipt, "undone");
		});
		await step.do("schedule-final-baseline-restore", async () => {
			// A failed prior attempt may have restored this byte as compensation
			// after the undo-media step committed. Re-establish the undo state.
			await deleteOnlyExpectedMedia(env, records, record);
			await assertPublicMedia(record, "deleted-before-final", false);
			const current = await readSiteDrillReceipt(env.RECOVERY_STORAGE);
			if (current?.phase === "undo-scheduled")
				await advance(env, receipt, "undone");
			await cmsSiteDrillStub(env).scheduleSiteDrillFinalRestore();
		});
		await step.do("restart-and-verify-final-baseline", async () => {
			try {
				await cmsSiteDrillStub(env).restartSiteDrill();
			} catch {
				// Fresh state proves the final baseline restore applied.
			}
			await assertDbProof(env, receipt, "absent");
		});
		await step.do("restore-media-and-record-final-proof", async () => {
			await restoreOnlyExpectedMedia(env, records, record);
			await assertPublicMedia(record, "restored-final", true);
			await assertBundle(env, manifest.bundle);
			await advance(env, receipt, "verified");
		});
	} catch (error) {
		// R2 is outside the DO's PITR boundary. Leave the selected object
		// available even when a provider step or public-route proof fails.
		try {
			await restoreOnlyExpectedMedia(env, records, record);
			const current = await readSiteDrillReceipt(env.RECOVERY_STORAGE);
			if (current?.phase === "media-deleted")
				await advance(env, receipt, "mutated");
			if (current?.phase === "undone")
				await advance(env, receipt, "undo-scheduled");
		} catch (compensationError) {
			throw new AggregateError(
				[error, compensationError],
				"CMS site restore drill failed and media compensation failed",
			);
		}
		throw error;
	}
	return { status: "verified", evidence: "fresh" };
}

export class CmsSiteRestoreDrillWorkflow extends WorkflowEntrypoint<
	Env,
	object
> {
	async run(event: WorkflowEvent<object>, step: WorkflowStep) {
		return runCmsSiteRestoreDrill(
			this.env,
			step,
			event.instanceId,
			event.payload,
		);
	}
}
