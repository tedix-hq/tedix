import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { createHash } from "node:crypto";
import { createDbClient } from "@tedix/db/client";
import {
	closeCmsRestoreFence,
	countCmsRestorePermitsForSite,
	getCmsRestoreFenceState,
	reconcileCmsRestoreOuterPermits,
	releaseCmsRestoreFence,
} from "@tedix/db/queries/cms-restore-fences";
import {
	captureCmsRecovery,
	cmsRecoveryPrefix,
	readRecoveryAuthority,
	readVerifiedCmsRecoveryCapture,
	type CmsRecoveryManifestV2,
} from "./cms-recovery-workflow";
import {
	advanceCmsSiteRestoreReceipt,
	readCmsSiteRestoreReceipt,
	type CmsSiteRestoreIdentity,
	type CmsSiteRestorePhase,
	type CmsSiteRestoreReceipt,
	type VersionedCmsSiteRestoreReceipt,
} from "./cms-site-restore-receipt";
import {
	assertSourceMediaMatches,
	deleteSourceMediaObject,
	digestSourceMediaObject,
	listMediaPage,
	restoreSourceMediaObject,
	type VerifiedMediaObject,
} from "./tenant-media-backup";
import type { Env } from "./index";

export interface CmsSiteRestoreParams extends CmsSiteRestoreIdentity {
	/** A disposable proof may exercise the symmetric undo before reopening. */
	mode: "restore" | "roundtrip";
}

export interface CmsSiteRestoreStub {
	captureRecoverySnapshot(): Promise<{
		bookmark: string;
		databaseDigest: string;
	} | null>;
	scheduleCmsSiteRestore(
		input: CmsSiteRestoreIdentity & {
			bookmark: string;
			expectedDatabaseDigest: string;
			direction: "target" | "undo";
		},
	): Promise<{ undoBookmark: string }>;
	restartCmsSiteRestore(
		input: CmsSiteRestoreIdentity & {
			direction: "target" | "undo";
		},
	): Promise<void>;
}

function restoreStub(env: Env, slug: string): CmsSiteRestoreStub {
	return env.DB_DO.get(
		env.DB_DO.idFromName(slug),
	) as unknown as CmsSiteRestoreStub;
}

function requireV2(
	value: Awaited<ReturnType<typeof readVerifiedCmsRecoveryCapture>>["manifest"],
): asserts value is CmsRecoveryManifestV2 {
	if (value.version !== 2)
		throw new Error("CMS restore requires a verified v2 capture");
}

function sameBundle(
	a: { version: number; etag: string },
	b: { version: number; etag: string },
): boolean {
	return a.version === b.version && a.etag === b.etag;
}

async function assertBundle(
	env: Env,
	receipt: CmsSiteRestoreReceipt,
): Promise<void> {
	const current = await readRecoveryAuthority(env, receipt.slug);
	if (
		current?.siteId !== receipt.siteId ||
		!sameBundle(current.bundle, receipt.bundle)
	)
		throw new Error("CMS restore active site or bundle changed");
}

async function assertExactFence(
	env: Env,
	identity: CmsSiteRestoreIdentity,
): Promise<void> {
	const state = await getCmsRestoreFenceState(
		createDbClient(env.PLATFORM_DB),
		identity,
	);
	if (
		state.fence?.generation !== identity.generation ||
		state.fence.captureId !== identity.captureId
	)
		throw new Error("CMS restore exact fence unavailable");
}

async function advance(
	env: Env,
	identity: CmsSiteRestoreIdentity,
	from: CmsSiteRestorePhase,
	phase: CmsSiteRestorePhase,
	patch: Partial<CmsSiteRestoreReceipt> = {},
): Promise<VersionedCmsSiteRestoreReceipt> {
	const current = await readCmsSiteRestoreReceipt(
		env.RECOVERY_STORAGE,
		identity,
	);
	if (!current || current.receipt.phase !== from)
		throw new Error(`CMS restore receipt expected ${from}`);
	return advanceCmsSiteRestoreReceipt(env.RECOVERY_STORAGE, current, {
		...current.receipt,
		...patch,
		phase,
		updatedAt: new Date(
			Math.max(Date.now(), Date.parse(current.receipt.updatedAt) + 1),
		).toISOString(),
	});
}

/** Stable undo ID lets a Workflow replay find its own capture without a new claim. */
export function cmsSiteRestoreUndoCaptureId(
	identity: CmsSiteRestoreIdentity,
): string {
	const hex = createHash("sha256")
		.update(JSON.stringify([identity.siteId, identity.generation, "undo-v1"]))
		.digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function mediaSource(env: Env, slug: string) {
	return {
		accountId: env.CF_ACCOUNT_ID,
		token: env.CLOUDFLARE_R2_API_TOKEN,
		slug,
	};
}

const MEDIA_FIELDS = [
	"contentType",
	"cacheControl",
	"contentDisposition",
	"contentEncoding",
	"contentLanguage",
] as const;

function matchesRecord(
	actual: Awaited<ReturnType<typeof digestSourceMediaObject>>,
	record: VerifiedMediaObject,
): boolean {
	return (
		actual.bytes === record.size &&
		actual.sha256 === record.sha256 &&
		MEDIA_FIELDS.every((field) => actual[field] === record[field])
	);
}

async function listAllMedia(source: ReturnType<typeof mediaSource>) {
	const objects: Awaited<ReturnType<typeof listMediaPage>>["objects"] = [];
	const cursors = new Set<string>();
	let cursor: string | undefined;
	for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
		const page = await listMediaPage({ ...source, cursor });
		objects.push(...page.objects);
		if (!page.cursor) {
			if (new Set(objects.map((item) => item.key)).size !== objects.length)
				throw new Error("CMS restore media inventory has duplicate keys");
			return objects;
		}
		if (cursors.has(page.cursor))
			throw new Error("CMS restore media inventory cursor repeated");
		cursors.add(page.cursor);
		cursor = page.cursor;
	}
	throw new Error("CMS restore media inventory exceeded page limit");
}

/** Reconcile the whole bucket and prove bytes and HTTP metadata after each write. */
export async function reconcileCmsSiteMedia(
	env: Pick<
		Env,
		"CF_ACCOUNT_ID" | "CLOUDFLARE_R2_API_TOKEN" | "RECOVERY_STORAGE"
	>,
	identity: CmsSiteRestoreIdentity,
	records: VerifiedMediaObject[],
	captureId = identity.captureId,
): Promise<string> {
	const source = mediaSource(env as Env, identity.slug);
	const expected = new Map(records.map((record) => [record.key, record]));
	if (expected.size !== records.length)
		throw new Error("CMS restore capture has duplicate media keys");
	const listed = await listAllMedia(source);
	for (const object of listed) {
		if (!expected.has(object.key))
			await deleteSourceMediaObject({ ...source, key: object.key });
	}
	const listedKeys = new Set(listed.map((object) => object.key));
	for (const record of records) {
		let valid = false;
		if (listedKeys.has(record.key)) {
			try {
				valid = matchesRecord(
					await digestSourceMediaObject({ ...source, key: record.key }),
					record,
				);
			} catch {
				// A missing or unreadable object must be restored from the verified copy.
			}
		}
		if (!valid)
			await restoreSourceMediaObject({
				...source,
				record,
				backup: env.RECOVERY_STORAGE,
				backupKey: `${cmsRecoveryPrefix(identity.siteId, captureId)}media/${encodeURIComponent(record.key)}`,
			});
	}
	await assertSourceMediaMatches({ ...source, records });
	const hash = createHash("sha256");
	for (const record of records.toSorted((a, b) => a.key.localeCompare(b.key)))
		hash.update(
			JSON.stringify([
				record.key,
				record.size,
				record.sha256,
				...MEDIA_FIELDS.map((field) => record[field] ?? null),
			]),
		);
	return hash.digest("hex");
}

async function assertSql(
	env: Env,
	identity: CmsSiteRestoreIdentity,
	digest: string,
): Promise<void> {
	const snapshot = await restoreStub(
		env,
		identity.slug,
	).captureRecoverySnapshot();
	if (snapshot?.databaseDigest !== digest)
		throw new Error("CMS restore full SQLite digest mismatch");
}

async function restartAndAssertSql(
	env: Env,
	identity: CmsSiteRestoreIdentity,
	direction: "target" | "undo",
	digest: string,
): Promise<void> {
	try {
		await restoreStub(env, identity.slug).restartCmsSiteRestore({
			...identity,
			direction,
		});
	} catch {
		// ctx.abort disconnects the RPC; only a fresh full digest proves success.
	}
	await assertSql(env, identity, digest);
}

async function scheduleOnce(
	env: Env,
	identity: CmsSiteRestoreIdentity,
	direction: "target" | "undo",
	bookmark: string,
	expectedCurrentDigest: string,
): Promise<void> {
	const intent =
		direction === "target" ? "target-schedule-intent" : "undo-schedule-intent";
	const scheduled =
		direction === "target" ? "target-scheduled" : "undo-scheduled";
	const prior =
		direction === "target" ? "undo-captured" : "target-media-verified";
	await advance(env, identity, prior, intent);
	// A replay with an unacknowledged intent must stop. The provider may have
	// accepted the schedule before the RPC or receipt write failed.
	const result = await restoreStub(env, identity.slug).scheduleCmsSiteRestore({
		...identity,
		bookmark,
		expectedDatabaseDigest: expectedCurrentDigest,
		direction,
	});
	if (!result.undoBookmark)
		throw new Error("CMS restore PITR schedule acknowledgement invalid");
	await advance(env, identity, intent, scheduled, {
		[direction === "target" ? "undoBookmark" : "redoBookmark"]:
			result.undoBookmark,
	});
}

/** The receipt and D1 fence make a failed run inspectable without exposing data. */
export async function runCmsSiteRestore(
	env: Env,
	step: WorkflowStep,
	params: CmsSiteRestoreParams,
): Promise<{
	status: "released";
	generation: string;
	mode: CmsSiteRestoreParams["mode"];
}> {
	const identity: CmsSiteRestoreIdentity = params;
	if (params.mode !== "restore" && params.mode !== "roundtrip")
		throw new Error("CMS restore mode invalid");
	const existing = await readCmsSiteRestoreReceipt(
		env.RECOVERY_STORAGE,
		identity,
	);
	if (!existing) throw new Error("CMS restore requires a claimed receipt");
	if (existing.receipt.mode !== params.mode)
		throw new Error("CMS restore receipt mode changed");
	if (existing.receipt.phase === "held")
		throw new Error("CMS restore held for operator reconciliation");
	if (existing.receipt.phase === "released")
		return {
			status: "released",
			generation: identity.generation,
			mode: params.mode,
		};
	const target = await step.do("verify-target-capture", async () => {
		const capture = await readVerifiedCmsRecoveryCapture(
			env.RECOVERY_STORAGE,
			identity,
		);
		requireV2(capture.manifest);
		if (!sameBundle(capture.manifest.bundle, existing.receipt.bundle))
			throw new Error("CMS restore capture bundle changed");
		await assertBundle(env, existing.receipt);
		return capture.manifest;
	});
	await step.do("close-exact-site-fence", async () => {
		const closed = await closeCmsRestoreFence(
			createDbClient(env.PLATFORM_DB),
			identity,
		);
		if (!closed) await assertExactFence(env, identity);
		await advance(env, identity, "claimed", "fenced");
	});
	await step.do("drain-site-permits", async () => {
		await assertExactFence(env, identity);
		for (let attempt = 0; attempt < 60; attempt++) {
			await reconcileCmsRestoreOuterPermits(
				createDbClient(env.PLATFORM_DB),
				identity,
			);
			if (
				(await countCmsRestorePermitsForSite(
					createDbClient(env.PLATFORM_DB),
					identity.siteId,
				)) === 0
			) {
				await advance(env, identity, "fenced", "drained");
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		throw new Error("CMS restore permits did not drain");
	});
	await assertExactFence(env, identity);
	if (
		(await countCmsRestorePermitsForSite(
			createDbClient(env.PLATFORM_DB),
			identity.siteId,
		)) !== 0
	)
		throw new Error("CMS restore permits remained after drain");
	await assertBundle(env, existing.receipt);
	const targetAgain = await readVerifiedCmsRecoveryCapture(
		env.RECOVERY_STORAGE,
		identity,
	);
	requireV2(targetAgain.manifest);
	if (
		targetAgain.manifest.databaseDigest !== target.databaseDigest ||
		targetAgain.manifest.bookmark !== target.bookmark ||
		!sameBundle(targetAgain.manifest.bundle, target.bundle)
	)
		throw new Error("CMS restore capture changed after drain");
	const undoCaptureId = cmsSiteRestoreUndoCaptureId(identity);
	const undoIdentity = { ...identity, captureId: undoCaptureId };
	await step.do("claim-undo-capture", async () => {
		const key = `${cmsRecoveryPrefix(identity.siteId, undoCaptureId)}control.json`;
		const control = {
			version: 1 as const,
			siteId: identity.siteId,
			slug: identity.slug,
			captureId: undoCaptureId,
			createdAt: new Date().toISOString(),
			state: "running" as const,
		};
		const result = await env.RECOVERY_STORAGE.put(
			key,
			JSON.stringify(control),
			{
				httpMetadata: { contentType: "application/json" },
				onlyIf: { etagDoesNotMatch: "*" },
			},
		);
		if (!result) throw new Error("CMS restore undo capture already claimed");
	});
	const undoManifest = await captureCmsRecovery(env, step, undoIdentity);
	requireV2(undoManifest);
	await step.do("verify-undo-capture", async () => {
		const key = `${cmsRecoveryPrefix(identity.siteId, undoCaptureId)}control.json`;
		const controlObject = await env.RECOVERY_STORAGE.get(key);
		const control = controlObject ? await controlObject.json() : null;
		if (
			!control ||
			typeof control !== "object" ||
			(control as { state?: string }).state !== "running"
		)
			throw new Error("CMS restore undo control changed");
		await env.RECOVERY_STORAGE.put(
			key,
			JSON.stringify({ ...control, state: "verified" }),
			{
				httpMetadata: { contentType: "application/json" },
				onlyIf: { etagMatches: controlObject!.etag },
			},
		);
		const verified = await readVerifiedCmsRecoveryCapture(
			env.RECOVERY_STORAGE,
			undoIdentity,
		);
		requireV2(verified.manifest);
		if (
			verified.manifest.databaseDigest !== undoManifest.databaseDigest ||
			!sameBundle(verified.manifest.bundle, existing.receipt.bundle)
		)
			throw new Error("CMS restore undo capture verification failed");
		await advance(env, identity, "drained", "undo-captured", { undoCaptureId });
	});
	await step.do(
		"schedule-target-pitr",
		{ retries: { limit: 0, delay: "1 second" } },
		() =>
			scheduleOnce(
				env,
				identity,
				"target",
				target.bookmark,
				undoManifest.databaseDigest,
			),
	);
	await step.do("restart-and-verify-target-sql", async () => {
		await restartAndAssertSql(env, identity, "target", target.databaseDigest);
		await advance(env, identity, "target-scheduled", "target-sql-verified", {
			databaseDigest: target.databaseDigest,
		});
	});
	await step.do("reconcile-target-media", async () => {
		const mediaDigest = await reconcileCmsSiteMedia(
			env,
			identity,
			targetAgain.records,
		);
		await assertSql(env, identity, target.databaseDigest);
		await assertBundle(env, existing.receipt);
		await advance(
			env,
			identity,
			"target-sql-verified",
			"target-media-verified",
			{
				mediaDigest,
			},
		);
	});
	let finalCapture = targetAgain;
	if (params.mode === "roundtrip") {
		const undo = await readVerifiedCmsRecoveryCapture(
			env.RECOVERY_STORAGE,
			undoIdentity,
		);
		requireV2(undo.manifest);
		const undoDigest = undo.manifest.databaseDigest;
		const receipt = await readCmsSiteRestoreReceipt(
			env.RECOVERY_STORAGE,
			identity,
		);
		if (!receipt?.receipt.undoBookmark)
			throw new Error("CMS restore undo bookmark missing");
		await step.do(
			"schedule-undo-pitr",
			{ retries: { limit: 0, delay: "1 second" } },
			() =>
				scheduleOnce(
					env,
					identity,
					"undo",
					receipt.receipt.undoBookmark!,
					target.databaseDigest,
				),
		);
		await step.do("restart-and-verify-undo-sql", async () => {
			await restartAndAssertSql(env, identity, "undo", undoDigest);
			await advance(env, identity, "undo-scheduled", "undo-sql-verified", {
				databaseDigest: undoDigest,
			});
		});
		await step.do("reconcile-undo-media", async () => {
			const mediaDigest = await reconcileCmsSiteMedia(
				env,
				identity,
				undo.records,
				undoCaptureId,
			);
			await assertSql(env, identity, undoDigest);
			await assertBundle(env, existing.receipt);
			await advance(env, identity, "undo-sql-verified", "undo-media-verified", {
				mediaDigest,
			});
		});
		finalCapture = undo;
	}
	await step.do("verify-release-parity", async () => {
		await assertExactFence(env, identity);
		await assertSql(
			env,
			identity,
			(finalCapture.manifest as CmsRecoveryManifestV2).databaseDigest,
		);
		await assertSourceMediaMatches({
			...mediaSource(env, identity.slug),
			records: finalCapture.records,
		});
		await assertBundle(env, existing.receipt);
		await advance(
			env,
			identity,
			params.mode === "restore"
				? "target-media-verified"
				: "undo-media-verified",
			"release-intent",
		);
	});
	await step.do("release-exact-fence", async () => {
		const released = await releaseCmsRestoreFence(
			createDbClient(env.PLATFORM_DB),
			identity,
		);
		if (!released) {
			const state = await getCmsRestoreFenceState(
				createDbClient(env.PLATFORM_DB),
				identity,
			);
			if (
				state.fence?.generation === identity.generation &&
				state.fence.captureId === identity.captureId
			)
				throw new Error("CMS restore exact fence release failed");
			// A release-intent plus absent fence is the only safe signal after
			// an unknown release response. Public writes may already have resumed.
		}
		await advance(env, identity, "release-intent", "released");
	});
	return {
		status: "released",
		generation: identity.generation,
		mode: params.mode,
	};
}

export class CmsSiteRestoreWorkflow extends WorkflowEntrypoint<
	Env,
	CmsSiteRestoreParams
> {
	async run(event: WorkflowEvent<CmsSiteRestoreParams>, step: WorkflowStep) {
		return runCmsSiteRestore(this.env, step, event.payload);
	}
}
