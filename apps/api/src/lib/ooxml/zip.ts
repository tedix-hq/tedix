/**
 * A minimal, dependency-free ZIP (OPC container) writer.
 *
 * Every Office file is a zip of XML parts, so the only primitive the three
 * generators need is "write these named byte blobs as a zip". Deflate comes
 * from the platform's own `CompressionStream("deflate-raw")`, which workerd
 * implements natively — no Node `zlib`, no `Buffer`, no stream shim, and no
 * runtime dependency to audit. The alternative was a JS deflate package, and
 * the small ones resolve a `node` export condition first or reach for
 * `worker_threads`.
 */

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index += 1) {
		let value = index;
		for (let bit = 0; bit < 8; bit += 1) {
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[index] = value >>> 0;
	}
	return table;
})();

export function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
	const source = new Response(bytes).body;
	if (!source) throw new Error("Deflate source stream was not readable");
	const deflated = source.pipeThrough(new CompressionStream("deflate-raw"));
	return new Uint8Array(await new Response(deflated).arrayBuffer());
}

export interface ZipEntry {
	/** Part name, always a forward-slash OPC path such as `xl/workbook.xml`. */
	name: string;
	data: Uint8Array;
}

/**
 * A fixed DOS timestamp (1980-01-01 00:00) so identical content always
 * produces identical bytes. Export reproducibility is worth more here than a
 * modified time no Office reader surfaces.
 */
const DOS_TIME = 0;
const DOS_DATE = 0x21;

class ByteWriter {
	private parts: Uint8Array[] = [];
	private length = 0;

	get offset(): number {
		return this.length;
	}

	push(bytes: Uint8Array): void {
		this.parts.push(bytes);
		this.length += bytes.byteLength;
	}

	u16(value: number): void {
		this.push(new Uint8Array([value & 0xff, (value >>> 8) & 0xff]));
	}

	u32(value: number): void {
		this.push(
			new Uint8Array([
				value & 0xff,
				(value >>> 8) & 0xff,
				(value >>> 16) & 0xff,
				(value >>> 24) & 0xff,
			]),
		);
	}

	concat(): Uint8Array {
		const out = new Uint8Array(this.length);
		let cursor = 0;
		for (const part of this.parts) {
			out.set(part, cursor);
			cursor += part.byteLength;
		}
		return out;
	}
}

/** Zip the given parts into a single OPC container. */
export async function createZip(entries: ZipEntry[]): Promise<Uint8Array> {
	const encoder = new TextEncoder();
	const body = new ByteWriter();
	const central = new ByteWriter();
	for (const entry of entries) {
		const name = encoder.encode(entry.name);
		const crc = crc32(entry.data);
		const compressed = await deflateRaw(entry.data);
		// Deflate can grow a tiny or high-entropy payload; store those verbatim
		// rather than ship a part larger than its own content.
		const stored = compressed.byteLength >= entry.data.byteLength;
		const payload = stored ? entry.data : compressed;
		const method = stored ? 0 : 8;
		const offset = body.offset;

		body.u32(0x04034b50);
		body.u16(20);
		body.u16(0);
		body.u16(method);
		body.u16(DOS_TIME);
		body.u16(DOS_DATE);
		body.u32(crc);
		body.u32(payload.byteLength);
		body.u32(entry.data.byteLength);
		body.u16(name.byteLength);
		body.u16(0);
		body.push(name);
		body.push(payload);

		central.u32(0x02014b50);
		central.u16(20);
		central.u16(20);
		central.u16(0);
		central.u16(method);
		central.u16(DOS_TIME);
		central.u16(DOS_DATE);
		central.u32(crc);
		central.u32(payload.byteLength);
		central.u32(entry.data.byteLength);
		central.u16(name.byteLength);
		central.u16(0);
		central.u16(0);
		central.u16(0);
		central.u16(0);
		central.u32(0);
		central.u32(offset);
		central.push(name);
	}
	const bodyBytes = body.concat();
	const centralBytes = central.concat();
	const end = new ByteWriter();
	end.u32(0x06054b50);
	end.u16(0);
	end.u16(0);
	end.u16(entries.length);
	end.u16(entries.length);
	end.u32(centralBytes.byteLength);
	end.u32(bodyBytes.byteLength);
	end.u16(0);
	const endBytes = end.concat();

	const out = new Uint8Array(
		bodyBytes.byteLength + centralBytes.byteLength + endBytes.byteLength,
	);
	out.set(bodyBytes, 0);
	out.set(centralBytes, bodyBytes.byteLength);
	out.set(endBytes, bodyBytes.byteLength + centralBytes.byteLength);
	return out;
}

// XML 1.0 forbids most C0 controls outright; strip them rather than emit a
// part every Office reader rejects as corrupt.
const FORBIDDEN_CONTROLS = new RegExp(
	`[${"\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f"}]`,
	"g",
);

/** Escape a string for XML text or an attribute value. */
export function xmlEscape(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;")
		.replace(FORBIDDEN_CONTROLS, "");
}

export const XML_DECLARATION =
	'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** Encode one XML part, declaration included. */
export function xmlPart(name: string, body: string): ZipEntry {
	return {
		name,
		data: new TextEncoder().encode(XML_DECLARATION + body),
	};
}

/** The OPC package-level relationship part every Office file starts from. */
export function relationships(
	items: Array<{ id: string; type: string; target: string; mode?: string }>,
): string {
	const rels = items
		.map(
			(item) =>
				`<Relationship Id="${item.id}" Type="${item.type}" Target="${xmlEscape(item.target)}"${
					item.mode ? ` TargetMode="${item.mode}"` : ""
				}/>`,
		)
		.join("");
	return `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
}
