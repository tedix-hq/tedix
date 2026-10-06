import { describe, expect, it } from "vite-plus/test";
import {
	deriveHkdfHmacKey,
	hmacSha256,
	sha256Hex,
	timingSafeEqual,
} from "./crypto";

const ABC_SHA256 =
	"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("sha256Hex", () => {
	it("hashes UTF-8 text and identical bytes to the same hex", async () => {
		expect(await sha256Hex("abc")).toBe(ABC_SHA256);
		expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(ABC_SHA256);
		expect(await sha256Hex(new TextEncoder().encode("abc").buffer)).toBe(
			ABC_SHA256,
		);
	});

	it("zero-pads low bytes", async () => {
		expect(await sha256Hex("")).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
	});
});

describe("timingSafeEqual", () => {
	it("compares equal and unequal strings", () => {
		expect(timingSafeEqual("abc", "abc")).toBe(true);
		expect(timingSafeEqual("abc", "abd")).toBe(false);
		expect(timingSafeEqual("abc", "ab")).toBe(false);
		expect(timingSafeEqual("", "")).toBe(true);
	});
});

describe("deriveHkdfHmacKey + hmacSha256", () => {
	it("is deterministic per (secret, info) and differs across labels", async () => {
		const a = await hmacSha256(await deriveHkdfHmacKey("s", "label:v1"), "m");
		const b = await hmacSha256(await deriveHkdfHmacKey("s", "label:v1"), "m");
		const c = await hmacSha256(await deriveHkdfHmacKey("s", "label:v2"), "m");
		expect(a).toHaveLength(32);
		expect(Array.from(a)).toEqual(Array.from(b));
		expect(Array.from(a)).not.toEqual(Array.from(c));
	});
});
