import { describe, expect, it } from "vite-plus/test";
import {
	extractMediaBase64,
	extractMediaBytes,
	signMediaUrl,
	verifyMediaToken,
} from "./skill-media-url";

// Known base64 vectors (no encoder dependency — these exercise the real atob path):
//   "SGVsbG8=" decodes to bytes [72,101,108,108,111] ("Hello")
//   "AP8="     decodes to bytes [0, 255]              (binary, high byte)
const HELLO_B64 = "SGVsbG8=";
const HELLO_BYTES = [72, 101, 108, 108, 111];
const BINARY_B64 = "AP8=";
const BINARY_BYTES = [0, 255];

/** The real skill-run artifact shape the shim persists: { value: <step return>, durationMs }. */
function artifact(stepReturn: unknown): string {
	return JSON.stringify({ value: stepReturn, durationMs: 12 });
}

describe("extractMediaBase64", () => {
	it("pulls imageBase64 + mime from the conventional artifact shape", () => {
		const content = artifact({ imageBase64: HELLO_B64, mimeType: "image/png" });
		expect(extractMediaBase64(content)).toEqual({
			base64: HELLO_B64,
			mimeType: "image/png",
		});
	});

	it("supports videoBase64 and bytesBase64Encoded field variants", () => {
		expect(
			extractMediaBase64(
				artifact({ videoBase64: BINARY_B64, mimeType: "video/mp4" }),
			),
		).toEqual({ base64: BINARY_B64, mimeType: "video/mp4" });
		expect(
			extractMediaBase64(
				artifact({
					bytesBase64Encoded: HELLO_B64,
					mimeType: "application/pdf",
				}),
			),
		).toEqual({ base64: HELLO_B64, mimeType: "application/pdf" });
	});

	it("unwraps a root-level shape (no `value` wrapper)", () => {
		const content = JSON.stringify({
			imageBase64: HELLO_B64,
			mimeType: "image/webp",
		});
		expect(extractMediaBase64(content)).toEqual({
			base64: HELLO_B64,
			mimeType: "image/webp",
		});
	});

	it("defaults mime to application/octet-stream when absent", () => {
		expect(extractMediaBase64(artifact({ imageBase64: HELLO_B64 }))).toEqual({
			base64: HELLO_B64,
			mimeType: "application/octet-stream",
		});
	});

	it("returns null for non-media JSON", () => {
		expect(extractMediaBase64(artifact({ ok: true, status: 200 }))).toBeNull();
		expect(extractMediaBase64(artifact({ imageBase64: "" }))).toBeNull();
	});

	it("returns null for invalid JSON", () => {
		expect(extractMediaBase64("not json")).toBeNull();
	});
});

describe("extractMediaBytes", () => {
	it("decodes base64 to the exact bytes (text vector)", () => {
		const out = extractMediaBytes(
			artifact({ imageBase64: HELLO_B64, mimeType: "image/png" }),
		);
		expect(out).not.toBeNull();
		expect(out?.mimeType).toBe("image/png");
		expect(Array.from(out?.bytes ?? [])).toEqual(HELLO_BYTES);
	});

	it("decodes high/zero bytes correctly (binary vector)", () => {
		const out = extractMediaBytes(
			artifact({ videoBase64: BINARY_B64, mimeType: "video/mp4" }),
		);
		expect(Array.from(out?.bytes ?? [])).toEqual(BINARY_BYTES);
		expect(out?.mimeType).toBe("video/mp4");
	});

	it("returns null when no media field is present (shares extractMediaBase64)", () => {
		expect(extractMediaBytes(artifact({ ok: true }))).toBeNull();
	});

	it("returns null for malformed base64 instead of throwing in the byte route", () => {
		expect(
			extractMediaBytes(
				artifact({ bytesBase64Encoded: "%%%", mimeType: "text/calendar" }),
			),
		).toBeNull();
	});
});

describe("media URL signing (HKDF-derived HMAC)", () => {
	const SECRET = "test-master-secret-do-not-use-in-prod";

	it("mints a URL whose token verifies", async () => {
		const { url } = await signMediaUrl({
			baseUrl: "https://api.tedix.dev",
			secret: SECRET,
			runId: "run-1",
			path: "outputs/generate-image.json",
			nowMs: 1_000_000,
		});
		const u = new URL(url);
		const exp = Number(u.searchParams.get("exp"));
		const sig = u.searchParams.get("sig") ?? "";
		expect(
			await verifyMediaToken({
				secret: SECRET,
				runId: "run-1",
				path: "outputs/generate-image.json",
				exp,
				sig,
				nowMs: 1_000_000,
			}),
		).toBe(true);
	});

	it("rejects a swapped path under the same token (path is signed)", async () => {
		const { url } = await signMediaUrl({
			baseUrl: "https://api.tedix.dev",
			secret: SECRET,
			runId: "run-1",
			path: "outputs/generate-image.json",
			nowMs: 1_000_000,
		});
		const u = new URL(url);
		const exp = Number(u.searchParams.get("exp"));
		const sig = u.searchParams.get("sig") ?? "";
		expect(
			await verifyMediaToken({
				secret: SECRET,
				runId: "run-1",
				path: "outputs/other-artifact.json", // attacker swaps the path
				exp,
				sig,
				nowMs: 1_000_000,
			}),
		).toBe(false);
	});

	it("rejects an expired token", async () => {
		const { url } = await signMediaUrl({
			baseUrl: "https://api.tedix.dev",
			secret: SECRET,
			runId: "run-1",
			path: "outputs/generate-image.json",
			nowMs: 1_000_000,
			ttlSeconds: 60,
		});
		const u = new URL(url);
		const exp = Number(u.searchParams.get("exp"));
		const sig = u.searchParams.get("sig") ?? "";
		expect(
			await verifyMediaToken({
				secret: SECRET,
				runId: "run-1",
				path: "outputs/generate-image.json",
				exp,
				sig,
				nowMs: 1_000_000 + 61_000, // 61s later — past the 60s ttl
			}),
		).toBe(false);
	});

	it("binds an attachment filename into the signed token", async () => {
		const { url } = await signMediaUrl({
			baseUrl: "https://artifacts.tedix.dev",
			secret: SECRET,
			runId: "run-1",
			path: "outputs/calendar.json",
			downloadName: "team-calendar.ics",
			nowMs: 1_000_000,
		});
		const u = new URL(url);
		const common = {
			secret: SECRET,
			runId: "run-1",
			path: "outputs/calendar.json",
			exp: Number(u.searchParams.get("exp")),
			sig: u.searchParams.get("sig") ?? "",
			nowMs: 1_000_000,
		};
		expect(u.searchParams.get("download")).toBe("team-calendar.ics");
		expect(
			await verifyMediaToken({
				...common,
				downloadName: "team-calendar.ics",
			}),
		).toBe(true);
		expect(
			await verifyMediaToken({
				...common,
				downloadName: "renamed.ics",
			}),
		).toBe(false);
	});

	it("rejects unsafe attachment filenames before signing", async () => {
		await expect(
			signMediaUrl({
				baseUrl: "https://artifacts.tedix.dev",
				secret: SECRET,
				runId: "run-1",
				path: "outputs/calendar.json",
				downloadName: 'calendar.ics"\r\nSet-Cookie: stolen=1',
				nowMs: 1_000_000,
			}),
		).rejects.toThrow("Invalid signed media download name");
	});
});
