import type { DbQueryClient } from "@tedix/db/query-client";
import {
	getOutputBodyBackfillSummary,
	listOutputBodyBackfillPage,
	setBackfilledOutputBody,
} from "@tedix/db/queries/os-workspaces/output-body-backfill";
import {
	outputRevisionBodyKey,
	storeOutputRevisionBody,
	verifyStoredOutputRevisionBody,
	type OutputBodyBucket,
} from "./os-output-revision-body-store";

/**
 * Operator job: authorize the organization and DB/bucket bindings in private ops.
 * Run sequential pages, starting at zero and retaining the returned through and
 * cursor. Publish each receipt on Work. A failed/interrupted page replays from
 * its input cursor; it rechecks pointers committed before the interruption.
 * A complete pass covers the fixed rowid boundary, not later inserts.
 */
export async function backfillOutputRevisionBodiesPage(
	db: DbQueryClient,
	bucket: OutputBodyBucket,
	params: {
		organizationId: string;
		after?: number;
		through?: number;
		limit?: number;
	},
) {
	const { organizationId } = params;
	outputRevisionBodyKey(organizationId, "0".repeat(64));
	const before = await getOutputBodyBackfillSummary(db, {
		organizationId: organizationId,
	});
	const after = params.after ?? 0;
	const through = params.through ?? before.through;
	if (after !== 0 && params.through === undefined)
		throw new Error("Resume requires the original through rowid");
	const rows = await listOutputBodyBackfillPage(db, {
		organizationId,
		after,
		through,
		limit: params.limit ?? 25,
	});
	const receiptKey = `os-output-revision-backfill/v1/${organizationId}/${crypto.randomUUID()}.json`;
	const receipt = {
		version: 1,
		organizationId,
		after,
		through,
		cursor: after,
		startedAt: new Date().toISOString(),
		status: "prepared",
		rows: 0,
		rowsWritten: 0,
		bytes: 0,
		hashMismatches: 0,
		failures: [] as { id: string; rowid: number; reason: string }[],
	};
	const saveReceipt = async () => {
		const body = await new Blob([JSON.stringify(receipt)]).arrayBuffer();
		const bytes = new Uint8Array(body);
		await bucket.put(receiptKey, body);
		const readback = await bucket.get(receiptKey);
		if (!readback) throw new Error("Backfill receipt is missing");
		const actual = new Uint8Array(await readback.arrayBuffer());
		if (
			actual.length !== bytes.length ||
			actual.some((byte, index) => byte !== bytes[index])
		)
			throw new Error("Backfill receipt verification mismatch");
	};
	// Durable intent precedes pointers; an interrupted prepared receipt cannot
	// authorize cursor advancement. Its input bounds are safe to replay.
	await saveReceipt();
	for (const row of rows) {
		let phase = "store";
		try {
			const metadata =
				row.bodyR2Key === null
					? await storeOutputRevisionBody(bucket, organizationId, row.content)
					: {
							bodyR2Key: row.bodyR2Key,
							contentSha256: row.contentSha256!,
							contentBytes: row.contentBytes!,
						};
			if (metadata.contentSha256 == null || metadata.contentBytes == null)
				throw new Error("Output revision body metadata is missing");
			phase = "verify";
			await verifyStoredOutputRevisionBody(
				bucket,
				organizationId,
				row.content,
				metadata,
			);
			if (row.bodyR2Key === null) {
				phase = "pointer";
				const changed = await setBackfilledOutputBody(db, {
					...metadata,
					organizationId,
					id: row.id,
					rowid: row.rowid,
					content: row.content,
				});
				if (changed.length !== 1)
					throw new Error(
						"Output revision changed during backfill; replay page",
					);
				receipt.rowsWritten++;
			}
			receipt.rows++;
			receipt.bytes += metadata.contentBytes;
			receipt.cursor = row.rowid;
		} catch (error) {
			const mismatch =
				error instanceof Error &&
				error.message === "Output revision body verification mismatch";
			if (mismatch) receipt.hashMismatches++;
			// Driver errors can contain bound body text. Receipts contain codes only.
			receipt.failures.push({
				id: row.id,
				rowid: row.rowid,
				reason: mismatch ? "body_mismatch" : `${phase}_failed`,
			});
			break;
		}
	}
	receipt.status = receipt.failures.length ? "failed" : "verified";
	if (!rows.length) receipt.cursor = through;
	await saveReceipt();
	const summary = await getOutputBodyBackfillSummary(db, {
		organizationId: organizationId,
	});
	return {
		receiptKey,
		...receipt,
		done: receipt.failures.length === 0 && receipt.cursor === through,
		summary: {
			...summary,
			distinctHashesPerRow: summary.rows
				? summary.distinctHashes / summary.rows
				: null,
		},
	};
}
