import { describe, expect, it } from "vite-plus/test";
import {
	decryptSecret,
	decryptTediSecret,
	encryptSecret,
	encryptTediSecret,
	generateMasterKey,
	splitMasterKeys,
} from "./secrets-encryption.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const TEDI = "22222222-2222-4222-8222-222222222222";

describe("master key list", () => {
	it("reads a single key as a one-element list", () => {
		const key = generateMasterKey();
		expect(splitMasterKeys(key)).toEqual([key]);
	});

	it("keeps rotation order and tolerates spacing", () => {
		const next = generateMasterKey();
		const previous = generateMasterKey();
		expect(splitMasterKeys(` ${next} , ${previous} `)).toEqual([
			next,
			previous,
		]);
	});

	it("rejects an empty value rather than deriving from nothing", () => {
		expect(() => splitMasterKeys("  ,  ")).toThrow(/empty/i);
	});
});

describe("rotation window", () => {
	it("still reads a secret written under the old key", async () => {
		const previous = generateMasterKey();
		const next = generateMasterKey();
		const stored = await encryptSecret(previous, ORG, "hunter2");

		// The window: new key first, old key still accepted.
		expect(await decryptSecret(`${next},${previous}`, ORG, stored)).toBe(
			"hunter2",
		);
		// And once the old key is dropped, that row must fail loudly.
		await expect(decryptSecret(next, ORG, stored)).rejects.toThrow(
			/Unable to decrypt/,
		);
	});

	it("writes with the primary key, so a migrated row survives the drop", async () => {
		const previous = generateMasterKey();
		const next = generateMasterKey();

		const stored = await encryptTediSecret(
			`${next},${previous}`,
			TEDI,
			"token-value",
		);

		// Written under `next`, so dropping `previous` changes nothing.
		expect(await decryptTediSecret(next, TEDI, stored)).toBe("token-value");
		// And it is genuinely the new key, not the old one still doing the work.
		await expect(decryptTediSecret(previous, TEDI, stored)).rejects.toThrow(
			/Unable to decrypt/,
		);
	});

	it("does not let a wrong key return plausible bytes", async () => {
		const real = generateMasterKey();
		const wrong = generateMasterKey();
		const stored = await encryptSecret(real, ORG, "hunter2");

		// AES-GCM authenticates, so a wrong key throws instead of returning junk.
		await expect(decryptSecret(wrong, ORG, stored)).rejects.toThrow(
			/Unable to decrypt/,
		);
	});

	it("keeps per-scope separation: an org key cannot read a tedi secret", async () => {
		const key = generateMasterKey();
		const stored = await encryptTediSecret(key, TEDI, "token-value");
		await expect(decryptSecret(key, TEDI, stored)).rejects.toThrow(
			/Unable to decrypt/,
		);
	});

	it("rejects a malformed key in the list instead of silently skipping it", async () => {
		const good = generateMasterKey();
		const stored = await encryptSecret(good, ORG, "hunter2");
		await expect(
			decryptSecret(`${good},not-a-32-byte-key`, ORG, stored),
		).rejects.toThrow(/base64|32 bytes/);
	});
});
