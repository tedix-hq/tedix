/**
 * Private, compare-and-swap ledger for a single CMS restore generation. The
 * receipt is deliberately outside the purgeable recovery capture prefix.
 * D1's restore fence remains the authority for blocking site traffic.
 */
export interface CmsSiteRestoreIdentity {
	siteId: string;
	slug: string;
	captureId: string;
	generation: string;
}

export type CmsSiteRestorePhase =
	| "claimed"
	| "fenced"
	| "drained"
	| "undo-captured"
	| "target-schedule-intent"
	| "target-scheduled"
	| "target-sql-verified"
	| "target-media-verified"
	| "undo-schedule-intent"
	| "undo-scheduled"
	| "undo-sql-verified"
	| "undo-media-verified"
	| "release-intent"
	| "released"
	| "held";

export interface CmsSiteRestoreReceipt extends CmsSiteRestoreIdentity {
	version: 1;
	phase: CmsSiteRestorePhase;
	mode: "restore" | "roundtrip";
	createdAt: string;
	updatedAt: string;
	/** Exact bundle authority established before the fence closes. */
	bundle: { version: number; etag: string };
	/** Fresh capture made under the drained fence; never returned to owners. */
	undoCaptureId?: string;
	/** PITR schedule acknowledgement, private to the recovery operator. */
	undoBookmark?: string;
	redoBookmark?: string;
	/** Readback evidence uses byte and metadata digests, not R2 ETags. */
	databaseDigest?: string;
	mediaDigest?: string;
	/** A bounded operator-facing code, with no raw provider payload or media keys. */
	errorCode?: string;
}

export interface VersionedCmsSiteRestoreReceipt {
	receipt: CmsSiteRestoreReceipt;
	etag: string;
}

const PHASES: ReadonlySet<string> = new Set<CmsSiteRestorePhase>([
	"claimed",
	"fenced",
	"drained",
	"undo-captured",
	"target-schedule-intent",
	"target-scheduled",
	"target-sql-verified",
	"target-media-verified",
	"undo-schedule-intent",
	"undo-scheduled",
	"undo-sql-verified",
	"undo-media-verified",
	"release-intent",
	"released",
	"held",
]);

const NEXT_PHASES: Record<
	CmsSiteRestorePhase,
	ReadonlySet<CmsSiteRestorePhase>
> = {
	claimed: new Set(["fenced", "held"]),
	fenced: new Set(["drained", "held"]),
	drained: new Set(["undo-captured", "held"]),
	"undo-captured": new Set(["target-schedule-intent", "held"]),
	"target-schedule-intent": new Set(["target-scheduled", "held"]),
	"target-scheduled": new Set(["target-sql-verified", "held"]),
	"target-sql-verified": new Set(["target-media-verified", "held"]),
	"target-media-verified": new Set([
		"undo-schedule-intent",
		"release-intent",
		"held",
	]),
	"undo-schedule-intent": new Set(["undo-scheduled", "held"]),
	"undo-scheduled": new Set(["undo-sql-verified", "held"]),
	"undo-sql-verified": new Set(["undo-media-verified", "held"]),
	"undo-media-verified": new Set(["release-intent", "held"]),
	"release-intent": new Set(["released", "held"]),
	released: new Set(),
	held: new Set(),
};

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function cmsSiteRestoreReceiptKey(
	identity: CmsSiteRestoreIdentity,
): string {
	if (
		!UUID.test(identity.siteId) ||
		!UUID.test(identity.captureId) ||
		!UUID.test(identity.generation)
	)
		throw new Error("CMS restore receipt identity invalid");
	return `recovery/restores/${identity.siteId}/${identity.generation}/receipt.json`;
}

export function isCmsSiteRestoreReceipt(
	value: unknown,
	identity: CmsSiteRestoreIdentity,
): value is CmsSiteRestoreReceipt {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<CmsSiteRestoreReceipt>;
	return (
		record.version === 1 &&
		record.siteId === identity.siteId &&
		record.slug === identity.slug &&
		record.captureId === identity.captureId &&
		record.generation === identity.generation &&
		PHASES.has(record.phase ?? "") &&
		(record.mode === "restore" || record.mode === "roundtrip") &&
		typeof record.createdAt === "string" &&
		Number.isFinite(Date.parse(record.createdAt)) &&
		typeof record.updatedAt === "string" &&
		Number.isFinite(Date.parse(record.updatedAt)) &&
		Date.parse(record.updatedAt) >= Date.parse(record.createdAt) &&
		!!record.bundle &&
		Number.isSafeInteger(record.bundle.version) &&
		record.bundle.version > 0 &&
		typeof record.bundle.etag === "string" &&
		record.bundle.etag.length > 0 &&
		(record.undoCaptureId === undefined || UUID.test(record.undoCaptureId)) &&
		(record.undoBookmark === undefined ||
			(typeof record.undoBookmark === "string" &&
				record.undoBookmark.length > 0)) &&
		(record.redoBookmark === undefined ||
			(typeof record.redoBookmark === "string" &&
				record.redoBookmark.length > 0)) &&
		(record.databaseDigest === undefined ||
			SHA256.test(record.databaseDigest)) &&
		(record.mediaDigest === undefined || SHA256.test(record.mediaDigest)) &&
		(record.errorCode === undefined ||
			(typeof record.errorCode === "string" &&
				/^[a-z0-9_]{1,64}$/.test(record.errorCode)))
	);
}

export async function readCmsSiteRestoreReceipt(
	storage: R2Bucket,
	identity: CmsSiteRestoreIdentity,
): Promise<VersionedCmsSiteRestoreReceipt | null> {
	const object = await storage.get(cmsSiteRestoreReceiptKey(identity));
	if (!object) return null;
	const value: unknown = await object.json();
	if (!isCmsSiteRestoreReceipt(value, identity))
		throw new Error("CMS restore receipt invalid or identity changed");
	return { receipt: value, etag: object.etag };
}

/** Only a new generation can claim its own receipt; never overwrite a replay. */
export async function claimCmsSiteRestoreReceipt(
	storage: R2Bucket,
	receipt: CmsSiteRestoreReceipt,
): Promise<VersionedCmsSiteRestoreReceipt> {
	if (receipt.phase !== "claimed" || !isCmsSiteRestoreReceipt(receipt, receipt))
		throw new Error("CMS restore receipt claim invalid");
	const result = await storage.put(
		cmsSiteRestoreReceiptKey(receipt),
		JSON.stringify(receipt),
		{
			httpMetadata: { contentType: "application/json" },
			onlyIf: { etagDoesNotMatch: "*" },
		},
	);
	if (!result) throw new Error("CMS restore receipt already claimed");
	return { receipt, etag: result.etag };
}

/** The caller must read back after an uncertain result; blind retries are unsafe. */
export async function advanceCmsSiteRestoreReceipt(
	storage: R2Bucket,
	current: VersionedCmsSiteRestoreReceipt,
	next: CmsSiteRestoreReceipt,
): Promise<VersionedCmsSiteRestoreReceipt> {
	if (
		!isCmsSiteRestoreReceipt(next, current.receipt) ||
		next.createdAt !== current.receipt.createdAt ||
		Date.parse(next.updatedAt) <= Date.parse(current.receipt.updatedAt) ||
		next.bundle.version !== current.receipt.bundle.version ||
		next.bundle.etag !== current.receipt.bundle.etag ||
		next.mode !== current.receipt.mode ||
		(current.receipt.undoCaptureId !== undefined &&
			next.undoCaptureId !== current.receipt.undoCaptureId) ||
		(current.receipt.undoBookmark !== undefined &&
			next.undoBookmark !== current.receipt.undoBookmark) ||
		(current.receipt.redoBookmark !== undefined &&
			next.redoBookmark !== current.receipt.redoBookmark) ||
		!NEXT_PHASES[current.receipt.phase].has(next.phase)
	)
		throw new Error("CMS restore receipt transition invalid");
	const result = await storage.put(
		cmsSiteRestoreReceiptKey(next),
		JSON.stringify(next),
		{
			httpMetadata: { contentType: "application/json" },
			onlyIf: { etagMatches: current.etag },
		},
	);
	if (!result) throw new Error("CMS restore receipt compare-and-swap failed");
	return { receipt: next, etag: result.etag };
}
