import { describe, expect, it } from "vite-plus/test";
import { findSecretValuePattern } from "./secret-egress-scan";

// Fakes are assembled at runtime so the repository secret scan stays quiet.
const GITHUB_TOKEN = ["ghp", "0123456789abcdefghij0123"].join("_");
const STRIPE_KEY = ["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_");
const JWT = [
	"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
	"eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkZha2UifQ",
	"SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
].join(".");
const OPAQUE_KEY = "a8f3k29dj4h5l6m7n8b9v0c1x2z3q4w5e6r7t8y9";

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/** A ~32 KB PDF-shaped payload with high-entropy (compressed-looking) bytes. */
function syntheticPdf(size = 32 * 1024): Uint8Array {
	const header = new TextEncoder().encode("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n");
	const bytes = new Uint8Array(size);
	bytes.set(header);
	let seed = 0x2545f491;
	for (let i = header.length; i < size; i++) {
		seed ^= seed << 13;
		seed ^= seed >>> 17;
		seed ^= seed << 5;
		bytes[i] = seed & 0xff;
	}
	return bytes;
}

function randomBinary(size: number): Uint8Array {
	const bytes = syntheticPdf(size + 16).subarray(16);
	bytes[0] = 0x00; // no recognised file signature
	return bytes;
}

const uploadSchema = {
	type: "object",
	properties: {
		file: {
			type: "object",
			properties: {
				base64: { type: "string", contentEncoding: "base64" },
				filename: { type: "string" },
				mimeType: { type: "string" },
			},
		},
	},
};

const cursorSchema = {
	type: "object",
	properties: {
		profileId: { type: "number" },
		nextCursor: { type: "string" },
	},
};

describe("findSecretValuePattern", () => {
	it("finds a token in a nested string without treating a UUID as a secret", () => {
		expect(
			findSecretValuePattern({
				payload: { body: `ticket text ${GITHUB_TOKEN}` },
			}),
		).toBe("GitHub token");
		expect(
			findSecretValuePattern({ id: "5eed0020-0000-4000-8000-000000000020" }),
		).toBeNull();
	});

	it("allows only schema-constrained full commit IDs and still scans adjacent secrets", () => {
		const sha = "abcdef0123".repeat(4);
		const schema = {
			type: "object",
			properties: {
				sourceCommit: { type: "string", pattern: "^[a-f0-9]{40}$" },
				expectedHead: { type: "string", pattern: "^[a-f0-9]{40}$" },
			},
		};
		expect(
			findSecretValuePattern({ sourceCommit: sha, expectedHead: sha }, schema),
		).toBeNull();
		expect(findSecretValuePattern({ sourceCommit: sha })).toBe(
			"long opaque token",
		);
		expect(findSecretValuePattern({ other: sha }, schema)).toBe(
			"long opaque token",
		);
		for (const value of [
			sha + "a",
			sha.toUpperCase(),
			`commit ${sha}`,
			OPAQUE_KEY,
			GITHUB_TOKEN,
			JWT,
		]) {
			expect(
				findSecretValuePattern({ sourceCommit: value }, schema),
			).not.toBeNull();
		}
		expect(
			findSecretValuePattern({ sourceCommit: sha, secret: OPAQUE_KEY }, schema),
		).toBe("long opaque token");
		expect(
			findSecretValuePattern(
				{ sourceCommit: sha },
				{ type: "object", properties: { sourceCommit: { type: "string" } } },
			),
		).toBe("long opaque token");
	});

	describe("file uploads", () => {
		const pdf = toBase64(syntheticPdf());

		it("lets a ~32 KB base64 PDF through a file object, with or without a schema", () => {
			expect(pdf.length).toBeGreaterThan(40_000);
			const args = {
				file: {
					base64: pdf,
					filename: "Invoice.pdf",
					mimeType: "application/pdf",
				},
			};
			expect(findSecretValuePattern(args)).toBeNull();
			expect(findSecretValuePattern(args, uploadSchema)).toBeNull();
		});

		it("lets MIME line-wrapped base64 and data URLs through", () => {
			const wrapped = pdf.match(/.{1,76}/g)?.join("\r\n") ?? "";
			expect(
				findSecretValuePattern({
					file: { content: wrapped, filename: "Invoice.pdf" },
				}),
			).toBeNull();
			expect(
				findSecretValuePattern({
					attachment: `data:application/pdf;base64,${pdf}`,
				}),
			).toBeNull();
		});

		it("recognises a PDF by its decoded signature even under a plain key", () => {
			expect(findSecretValuePattern({ payload: pdf })).toBeNull();
		});

		it("lets large unsigned binary through only where a file is declared", () => {
			const blob = toBase64(randomBinary(4096));
			expect(
				findSecretValuePattern({
					file: {
						base64: blob,
						filename: "x.bin",
						mimeType: "application/octet-stream",
					},
				}),
			).toBeNull();
			expect(findSecretValuePattern({ payload: blob })).toBe(
				"long opaque token",
			);
		});

		it("still blocks secrets in a filename, beside the file, or in decoded text", () => {
			for (const secret of [JWT, STRIPE_KEY, GITHUB_TOKEN, OPAQUE_KEY]) {
				expect(
					findSecretValuePattern(
						{
							file: {
								base64: pdf,
								filename: `${secret}.pdf`,
								mimeType: "application/pdf",
							},
						},
						uploadSchema,
					),
				).not.toBeNull();
			}
			const textFile = toBase64(
				new TextEncoder().encode(`STRIPE_KEY=${STRIPE_KEY}\n`),
			);
			expect(
				findSecretValuePattern(
					{ file: { base64: textFile, filename: "env.txt" } },
					uploadSchema,
				),
			).toBe("prefixed API key");
		});

		it("blocks a short opaque key passed as file content", () => {
			expect(
				findSecretValuePattern(
					{ file: { base64: OPAQUE_KEY, filename: "key.bin" } },
					uploadSchema,
				),
			).toBe("long opaque token");
		});
	});

	describe("pagination cursors", () => {
		const wiseCursor = btoa(
			JSON.stringify({
				lastId: 1834567890,
				createdAt: "2026-10-31T09:12:44.123456Z",
				direction: "older",
			}),
		);

		it("lets a declared base64 cursor through", () => {
			expect(wiseCursor.length).toBeGreaterThan(40);
			expect(
				findSecretValuePattern({ profileId: 1, nextCursor: wiseCursor }),
			).toBe("long opaque token");
			expect(
				findSecretValuePattern(
					{ profileId: 1, nextCursor: wiseCursor },
					cursorSchema,
				),
			).toBeNull();
		});

		it("still blocks a credential in a cursor field or inside its decoded value", () => {
			expect(findSecretValuePattern({ nextCursor: JWT }, cursorSchema)).toBe(
				"JWT",
			);
			expect(
				findSecretValuePattern(
					{ nextCursor: btoa(JSON.stringify({ auth: STRIPE_KEY })) },
					cursorSchema,
				),
			).toBe("prefixed API key");
		});
	});

	it("blocks API keys and JWTs in ordinary string arguments and keys", () => {
		expect(findSecretValuePattern({ query: `use ${STRIPE_KEY}` })).toBe(
			"prefixed API key",
		);
		expect(findSecretValuePattern({ note: JWT })).toBe("JWT");
		expect(findSecretValuePattern({ header: `Bearer ${OPAQUE_KEY}` })).toBe(
			"Bearer token",
		);
		expect(findSecretValuePattern({ value: OPAQUE_KEY })).toBe(
			"long opaque token",
		);
		expect(findSecretValuePattern({ [OPAQUE_KEY]: "x" })).toBe(
			"long opaque token",
		);
	});
});
