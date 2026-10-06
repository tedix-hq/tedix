import { createHash } from "node:crypto";

export interface MediaObject {
	key: string;
	size: number;
	etag: string;
}
export interface MediaPage {
	objects: MediaObject[];
	cursor?: string;
}
interface MediaHttpMetadata {
	contentType?: string;
	cacheControl?: string;
	contentDisposition?: string;
	contentEncoding?: string;
	contentLanguage?: string;
}

export interface VerifiedMediaObject extends MediaObject, MediaHttpMetadata {
	sha256: string;
}

const HTTP_METADATA_FIELDS = [
	"contentType",
	"cacheControl",
	"contentDisposition",
	"contentEncoding",
	"contentLanguage",
] as const;

function readHttpMetadata(headers: Headers): MediaHttpMetadata {
	return {
		contentType: headers.get("content-type") ?? undefined,
		cacheControl: headers.get("cache-control") ?? undefined,
		contentDisposition: headers.get("content-disposition") ?? undefined,
		contentEncoding: headers.get("content-encoding") ?? undefined,
		contentLanguage: headers.get("content-language") ?? undefined,
	};
}

function assertHttpMetadataMatches(
	actual: MediaHttpMetadata | undefined,
	expected: MediaHttpMetadata,
	message: string,
): void {
	if (
		HTTP_METADATA_FIELDS.some(
			(field) =>
				(actual?.[field] ?? undefined) !== (expected[field] ?? undefined),
		)
	)
		throw new Error(message);
}

/** A byte-level comparison is required after REST PUT, which can change ETags. */
export async function assertSourceMediaMatches(args: {
	accountId: string;
	token: string;
	slug: string;
	records: VerifiedMediaObject[];
	missingKey?: string;
}): Promise<void> {
	const expected = args.records
		.filter((record) => record.key !== args.missingKey)
		.toSorted((a, b) => a.key.localeCompare(b.key));
	const listed: MediaObject[] = [];
	let cursor: string | undefined;
	let pages = 0;
	const seenCursors = new Set<string>();
	do {
		if (++pages > 100)
			throw new Error("CMS restore drill media inventory exceeded page limit");
		const page = await listMediaPage({ ...args, cursor });
		listed.push(...page.objects);
		cursor = page.cursor;
		if (cursor) {
			if (seenCursors.has(cursor))
				throw new Error("CMS restore drill media inventory cursor repeated");
			seenCursors.add(cursor);
		}
	} while (cursor);
	listed.sort((a, b) => a.key.localeCompare(b.key));
	if (
		listed.length !== expected.length ||
		new Set(listed.map((object) => object.key)).size !== listed.length ||
		listed.some(
			(object, index) =>
				object.key !== expected[index]?.key ||
				object.size !== expected[index]?.size,
		)
	)
		throw new Error("CMS restore drill media inventory drifted");
	for (const record of expected) {
		const actual = await digestSourceMediaObject({ ...args, key: record.key });
		if (actual.bytes !== record.size || actual.sha256 !== record.sha256)
			throw new Error(`CMS restore drill media bytes drifted: ${record.key}`);
		assertHttpMetadataMatches(
			actual,
			record,
			`CMS restore drill media metadata drifted: ${record.key}`,
		);
	}
}

export async function deleteSourceMediaObject(args: {
	accountId: string;
	token: string;
	slug: string;
	key: string;
}): Promise<void> {
	const response = await fetch(sourceUrl(args.accountId, args.slug, args.key), {
		method: "DELETE",
		headers: { Authorization: `Bearer ${args.token}` },
	});
	if (!response.ok && response.status !== 404)
		throw new Error(
			`CMS restore drill media delete failed: ${response.status}`,
		);
}

export async function restoreSourceMediaObject(args: {
	accountId: string;
	token: string;
	slug: string;
	record: VerifiedMediaObject;
	backup: R2Bucket;
	backupKey: string;
}): Promise<void> {
	const saved = await args.backup.get(args.backupKey);
	if (!saved?.body || saved.size !== args.record.size || !saved.etag)
		throw new Error("CMS restore drill backup object missing or changed");
	assertHttpMetadataMatches(
		saved.httpMetadata,
		args.record,
		"CMS restore drill backup metadata mismatch",
	);
	const hash = createHash("sha256");
	let bytes = 0;
	for await (const chunk of saved.body) {
		hash.update(chunk);
		bytes += chunk.byteLength;
	}
	if (bytes !== args.record.size || hash.digest("hex") !== args.record.sha256)
		throw new Error("CMS restore drill backup object digest mismatch");
	const upload = await args.backup.get(args.backupKey);
	if (
		!upload?.body ||
		upload.size !== args.record.size ||
		upload.etag !== saved.etag
	)
		throw new Error("CMS restore drill backup changed before restore");
	assertHttpMetadataMatches(
		upload.httpMetadata,
		args.record,
		"CMS restore drill backup metadata changed before restore",
	);
	const headers: Record<string, string> = {
		Authorization: `Bearer ${args.token}`,
	};
	for (const [name, value] of [
		["Content-Type", args.record.contentType],
		["Cache-Control", args.record.cacheControl],
		["Content-Disposition", args.record.contentDisposition],
		["Content-Encoding", args.record.contentEncoding],
		["Content-Language", args.record.contentLanguage],
	] as const)
		if (value) headers[name] = value;
	const sentHash = createHash("sha256");
	let sentBytes = 0;
	const checked = upload.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				sentHash.update(chunk);
				sentBytes += chunk.byteLength;
				controller.enqueue(chunk);
			},
		}),
	);
	const fixedLength = new FixedLengthStream(args.record.size);
	const abort = new AbortController();
	const piping = checked.pipeTo(fixedLength.writable, {
		signal: abort.signal,
	});
	const writing = fetch(sourceUrl(args.accountId, args.slug, args.record.key), {
		method: "PUT",
		headers,
		body: fixedLength.readable,
		signal: abort.signal,
	}).then((response) => {
		if (!response.ok)
			throw new Error(
				`CMS restore drill media restore failed: ${response.status}`,
			);
		return response;
	});
	try {
		await Promise.all([writing, piping]);
	} catch (error) {
		abort.abort();
		await Promise.allSettled([writing, piping]);
		throw error;
	}
	if (
		sentBytes !== args.record.size ||
		sentHash.digest("hex") !== args.record.sha256
	)
		throw new Error("CMS restore drill backup changed during restore");
	const actual = await digestSourceMediaObject({
		...args,
		key: args.record.key,
	});
	if (actual.bytes !== args.record.size || actual.sha256 !== args.record.sha256)
		throw new Error("CMS restore drill restored media bytes mismatch");
	assertHttpMetadataMatches(
		actual,
		args.record,
		"CMS restore drill restored media metadata mismatch",
	);
}

const PAGE_SIZE = 100;

function sourceUrl(accountId: string, slug: string, key?: string): string {
	const root = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/tedix-cms-media-${slug}/objects`;
	return key === undefined ? root : `${root}/${encodeURIComponent(key)}`;
}

export async function listMediaPage(args: {
	accountId: string;
	token: string;
	slug: string;
	cursor?: string;
	pageSize?: number;
}): Promise<MediaPage> {
	const pageSize = args.pageSize ?? PAGE_SIZE;
	if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE)
		throw new Error("CMS media page size invalid");
	const url = new URL(sourceUrl(args.accountId, args.slug));
	url.searchParams.set("per_page", String(pageSize));
	if (args.cursor) url.searchParams.set("cursor", args.cursor);
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${args.token}` },
	});
	if (!response.ok)
		throw new Error(`CMS media inventory failed: ${response.status}`);
	const data = (await response.json()) as {
		success?: boolean;
		result?: MediaObject[];
		result_info?: { cursor?: string; is_truncated?: boolean };
	};
	if (data.success === false || !Array.isArray(data.result))
		throw new Error("CMS media inventory response invalid");
	const objects = data.result;
	if (objects.length > pageSize)
		throw new Error("CMS media inventory page exceeded requested size");
	for (const object of objects) {
		if (
			!object ||
			typeof object.key !== "string" ||
			!Number.isSafeInteger(object.size) ||
			object.size < 0 ||
			typeof object.etag !== "string"
		)
			throw new Error("CMS media inventory object invalid");
	}
	const cursor = data.result_info?.is_truncated
		? data.result_info.cursor
		: undefined;
	if (data.result_info?.is_truncated && objects.length === 0)
		throw new Error("CMS media inventory truncated empty page");
	if (data.result_info?.is_truncated && (!cursor || cursor === args.cursor))
		throw new Error("CMS media inventory cursor did not advance");
	return { objects, cursor };
}

export async function inventoryMedia(args: {
	accountId: string;
	token: string;
	slug: string;
}): Promise<{ count: number; bytes: number; sha256: string }> {
	const hash = createHash("sha256");
	let count = 0;
	let bytes = 0;
	let pages = 0;
	let cursor: string | undefined;
	const seenCursors = new Set<string>();
	const seenKeys = new Set<string>();
	do {
		if (++pages > 100)
			throw new Error("CMS media inventory exceeded page limit");
		const page = await listMediaPage({ ...args, cursor });
		for (const object of page.objects) {
			if (seenKeys.has(object.key))
				throw new Error("CMS media inventory has duplicate keys");
			seenKeys.add(object.key);
			hash.update(JSON.stringify([object.key, object.size, object.etag]));
			count++;
			if (count > PAGE_SIZE * 100)
				throw new Error("CMS media inventory exceeded object limit");
			bytes += object.size;
		}
		cursor = page.cursor;
		if (cursor) {
			if (seenCursors.has(cursor))
				throw new Error("CMS media inventory cursor repeated");
			seenCursors.add(cursor);
		}
	} while (cursor);
	return { count, bytes, sha256: hash.digest("hex") };
}

export async function copyAndVerifyMediaObject(args: {
	accountId: string;
	token: string;
	slug: string;
	object: MediaObject;
	destination: R2Bucket;
	destinationKey: string;
}): Promise<VerifiedMediaObject> {
	const response = await fetch(
		sourceUrl(args.accountId, args.slug, args.object.key),
		{
			headers: { Authorization: `Bearer ${args.token}` },
		},
	);
	if (!response.ok || !response.body)
		throw new Error(`CMS media source read failed: ${response.status}`);
	const metadata = readHttpMetadata(response.headers);
	const sourceHash = createHash("sha256");
	let sourceBytes = 0;
	const stream = response.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				sourceHash.update(chunk);
				sourceBytes += chunk.byteLength;
				controller.enqueue(chunk);
			},
		}),
	);
	const fixedLength = new FixedLengthStream(args.object.size);
	const piping = stream.pipeTo(fixedLength.writable);
	const storing = args.destination.put(
		args.destinationKey,
		fixedLength.readable,
		{
			httpMetadata: metadata,
		},
	);
	const [written] = await Promise.all([storing, piping]);
	if (
		!written ||
		sourceBytes !== args.object.size ||
		written.size !== sourceBytes
	)
		throw new Error("CMS media source size changed during copy");
	const reread = await args.destination.get(args.destinationKey);
	if (!reread?.body || reread.size !== sourceBytes)
		throw new Error("CMS media backup reread size mismatch");
	const targetHash = createHash("sha256");
	let targetBytes = 0;
	for await (const chunk of reread.body) {
		targetHash.update(chunk);
		targetBytes += chunk.byteLength;
	}
	const sha256 = sourceHash.digest("hex");
	if (targetBytes !== sourceBytes || targetHash.digest("hex") !== sha256)
		throw new Error("CMS media backup reread digest mismatch");
	return {
		...args.object,
		sha256,
		...metadata,
	};
}

/** A second source read catches same-size media replacement with unchanged list metadata. */
export async function digestSourceMediaObject(args: {
	accountId: string;
	token: string;
	slug: string;
	key: string;
}): Promise<{ sha256: string; bytes: number } & MediaHttpMetadata> {
	const response = await fetch(sourceUrl(args.accountId, args.slug, args.key), {
		headers: { Authorization: `Bearer ${args.token}` },
	});
	if (!response.ok || !response.body)
		throw new Error(`CMS media source reread failed: ${response.status}`);
	const hash = createHash("sha256");
	let bytes = 0;
	for await (const chunk of response.body) {
		hash.update(chunk);
		bytes += chunk.byteLength;
	}
	return {
		sha256: hash.digest("hex"),
		bytes,
		...readHttpMetadata(response.headers),
	};
}
