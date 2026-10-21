import { inflateSync, unzipSync } from "fflate";
import { describe, expect, it } from "vite-plus/test";
import { createZip } from "./zip";

// Bit-by-bit reference, independent of the writer's CRC lookup table.
function referenceCrc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1)
			crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

describe("createZip", () => {
	it.each(["café.csv", "報告.csv", "𠮷😀.csv", "plain.csv"])(
		"declares %s consistently and preserves stored and deflated payloads",
		async (name) => {
			const encoder = new TextEncoder();
			const entries = [
				{ name: `stored/${name}`, data: encoder.encode("123456789") },
				{
					name: `deflated/${name}`,
					data: encoder.encode("Unicode payload 漢字😀\n".repeat(100)),
				},
				{ name: `empty/${name}`, data: new Uint8Array() },
			];
			const bytes = await createZip(entries);
			expect(await createZip(entries)).toEqual(bytes);
			const extracted = unzipSync(bytes);
			expect(Object.keys(extracted)).toEqual(
				entries.map((entry) => entry.name),
			);
			for (const entry of entries)
				expect(extracted[entry.name]).toEqual(entry.data);

			const view = new DataView(
				bytes.buffer,
				bytes.byteOffset,
				bytes.byteLength,
			);
			const u16 = (offset: number) => view.getUint16(offset, true);
			const u32 = (offset: number) => view.getUint32(offset, true);
			const end = bytes.byteLength - 22;
			expect(u32(end)).toBe(0x06054b50);
			expect(u16(end + 4)).toBe(0);
			expect(u16(end + 6)).toBe(0);
			expect(u16(end + 8)).toBe(entries.length);
			expect(u16(end + 10)).toBe(entries.length);
			expect(u16(end + 20)).toBe(0);
			const centralStart = u32(end + 16);
			expect(centralStart + u32(end + 12)).toBe(end);

			let local = 0;
			let central = centralStart;
			for (const [index, entry] of entries.entries()) {
				const nameBytes = encoder.encode(entry.name);
				const flags = name === "plain.csv" ? 0 : 0x0800;
				const method = index === 1 ? 8 : 0;
				const crc = referenceCrc32(entry.data);
				if (index === 0) expect(crc).toBe(0xcbf43926);
				expect(u32(local)).toBe(0x04034b50);
				expect(u16(local + 6)).toBe(flags);
				expect(u16(local + 8)).toBe(method);
				expect(u16(local + 10)).toBe(0);
				expect(u16(local + 12)).toBe(0x21);
				expect(u32(local + 14)).toBe(crc);
				const compressedSize = u32(local + 18);
				expect(u32(local + 22)).toBe(entry.data.byteLength);
				expect(u16(local + 26)).toBe(nameBytes.byteLength);
				expect(u16(local + 28)).toBe(0);
				expect(
					bytes.slice(local + 30, local + 30 + nameBytes.byteLength),
				).toEqual(nameBytes);
				const payloadStart = local + 30 + nameBytes.byteLength;
				const payload = bytes.slice(
					payloadStart,
					payloadStart + compressedSize,
				);
				if (method === 8) {
					expect(compressedSize).toBeLessThan(entry.data.byteLength);
					expect(inflateSync(payload)).toEqual(entry.data);
				} else {
					expect(compressedSize).toBe(entry.data.byteLength);
					expect(payload).toEqual(entry.data);
				}

				expect(u32(central)).toBe(0x02014b50);
				expect(u16(central + 8)).toBe(flags);
				expect(u16(central + 10)).toBe(method);
				expect(u16(central + 12)).toBe(0);
				expect(u16(central + 14)).toBe(0x21);
				expect(u32(central + 16)).toBe(crc);
				expect(u32(central + 20)).toBe(compressedSize);
				expect(u32(central + 24)).toBe(entry.data.byteLength);
				expect(u16(central + 28)).toBe(nameBytes.byteLength);
				expect(u16(central + 30)).toBe(0);
				expect(u16(central + 32)).toBe(0);
				expect(u32(central + 42)).toBe(local);
				expect(
					bytes.slice(central + 46, central + 46 + nameBytes.byteLength),
				).toEqual(nameBytes);
				local = payloadStart + compressedSize;
				central += 46 + nameBytes.byteLength;
			}
			expect(local).toBe(centralStart);
			expect(central).toBe(end);
		},
	);
});
