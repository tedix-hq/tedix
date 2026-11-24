import type { OsGadgetExecutionRow } from "@tedix/db/schema/os-workspaces";
import {
	listOsGadgetExecutionBodiesToOffload,
	offloadOsGadgetExecutionBody,
} from "@tedix/db/queries/os-workspaces/executions";
import type { DbQueryClient } from "@tedix/db/query-client";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import type { OutputBodyBucket } from "./os-output-revision-body-store";

function bodyKey(organizationId: string, digest: string) {
	return `os-gadget-executions/v1/${encodeURIComponent(organizationId)}/${digest}.gz`;
}

type BodyRow = Pick<
	OsGadgetExecutionRow,
	"organizationId" | "input" | "output" | "bodyR2Key" | "bodyBytes"
>;

export async function storeGadgetExecutionBody(
	bucket: OutputBodyBucket,
	row: BodyRow,
) {
	const bytes = new TextEncoder().encode(
		JSON.stringify({ input: row.input, output: row.output }),
	);
	const key = bodyKey(row.organizationId, await sha256Hex(bytes));
	const compressed = await new Response(
		new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
	).arrayBuffer();
	await bucket.put(key, compressed);
	const pointer = { bodyR2Key: key, bodyBytes: bytes.byteLength };
	// Verify stored bytes before the conditional D1 update clears either field.
	const verified = await readGadgetExecutionBody(
		{ ...row, ...pointer },
		bucket,
	);
	if (verified.input !== row.input || verified.output !== row.output)
		throw new Error("Gadget body read-back mismatch");
	return pointer;
}

export async function readGadgetExecutionBody<T extends BodyRow>(
	row: T,
	bucket: OutputBodyBucket | undefined,
): Promise<T> {
	if (!row.bodyR2Key) return row;
	if (!bucket) throw new Error("Gadget body bucket is unavailable");
	const digest = row.bodyR2Key.split("/").at(-1)?.replace(/\.gz$/, "");
	if (
		!digest ||
		!/^[a-f0-9]{64}$/.test(digest) ||
		row.bodyR2Key !== bodyKey(row.organizationId, digest)
	)
		throw new Error("Gadget body organization or digest mismatch");
	const object = await bucket.get(row.bodyR2Key);
	if (!object) throw new Error("Gadget body object is missing");
	const bytes = new Uint8Array(
		await new Response(
			new Blob([await object.arrayBuffer()])
				.stream()
				.pipeThrough(new DecompressionStream("gzip")),
		).arrayBuffer(),
	);
	if (bytes.byteLength !== row.bodyBytes || (await sha256Hex(bytes)) !== digest)
		throw new Error("Gadget body integrity mismatch");
	const body = JSON.parse(
		new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
	);
	if (
		!body ||
		!(body.input === null || typeof body.input === "string") ||
		!(body.output === null || typeof body.output === "string")
	)
		throw new Error("Invalid gadget body");
	return { ...row, input: body.input, output: body.output };
}

/** Every retention tick offloads bodies settled more than seven days ago.
 * Receipts and R2 objects are retained; active executions are never eligible.
 */
export async function retainGadgetExecutionBodies(
	db: DbQueryClient,
	bucket: OutputBodyBucket,
	now: Date,
) {
	const cutoff = new Date(now.getTime() - 7 * 86400000)
		.toISOString()
		.slice(0, 10);
	const deadline = Date.now() + 30_000;
	let moved = 0;
	let bytes = 0;
	// A bounded oldest-first pass resumes naturally through the partial index.
	for (let page = 0; page < 25 && Date.now() < deadline; page++) {
		const rows = await listOsGadgetExecutionBodiesToOffload(db, cutoff);
		if (!rows.length) break;
		for (const row of rows) {
			if (Date.now() >= deadline) break;
			const pointer = await storeGadgetExecutionBody(bucket, row);
			if (
				await offloadOsGadgetExecutionBody(
					db,
					row,
					pointer.bodyR2Key,
					pointer.bodyBytes,
					cutoff,
				)
			) {
				moved++;
				bytes += pointer.bodyBytes;
			}
		}
	}
	return { gadgetBodiesOffloaded: moved, gadgetBodyBytesOffloaded: bytes };
}
