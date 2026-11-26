import { describe, expect, it } from "vite-plus/test";
import {
	collectReturnedOpaqueValues,
	EXEMPT_IDENTIFIER_PATTERNS,
	findSecretValuePattern,
} from "./secret-egress-scan";

const CMS_JOB_PATTERN = EXEMPT_IDENTIFIER_PATTERNS[1];

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

	it("allows CMS deploy job IDs only under their exact schema pattern", () => {
		const sha = "abcdef0123".repeat(4);
		const site = "94d7d45c-642b-41ea-93c6-efdd1162cd28";
		const schema = {
			type: "object",
			properties: { jobId: { type: "string", pattern: CMS_JOB_PATTERN } },
		};
		for (const jobId of [`cms-${site}-e1-v11`, `cms-${site}-e1-v11-s${sha}`]) {
			expect(findSecretValuePattern({ jobId }, schema)).toBeNull();
			expect(findSecretValuePattern({ jobId })).toBe("long opaque token");
			expect(
				findSecretValuePattern(
					{ jobId },
					{ type: "object", properties: { jobId: { type: "string" } } },
				),
			).toBe("long opaque token");
		}
		for (const jobId of [
			`cms-${OPAQUE_KEY}-e1-v11`,
			`cms-${site}-e1-v11-s${OPAQUE_KEY}`,
			`cms-${site.toUpperCase()}-e1-v11`,
			`cms-${site}-e1-v11 ${OPAQUE_KEY}`,
			OPAQUE_KEY,
			GITHUB_TOKEN,
			JWT,
		]) {
			expect(findSecretValuePattern({ jobId }, schema)).not.toBeNull();
		}
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

	describe("public JWKS", () => {
		const coordinate = toBase64(randomBinary(32))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		const key = {
			kty: "EC",
			crv: "P-256",
			x: coordinate,
			y: coordinate,
			kid: OPAQUE_KEY,
			use: "sig",
			alg: "ES256",
		};
		const jwks = { keys: [key] };

		it("allows public members in objects, JSON files and base64 JSON files", () => {
			const json = JSON.stringify({ jwks });
			for (const content of [json, btoa(json)]) {
				expect(
					findSecretValuePattern({
						file: { filename: "client.json", content },
					}),
				).toBeNull();
			}
			expect(findSecretValuePattern(jwks)).toBeNull();
			expect(
				findSecretValuePattern({
					keys: [
						{ kty: "RSA", n: coordinate.repeat(8), e: "AQAB", kid: OPAQUE_KEY },
					],
				}),
			).toBeNull();
		});

		it("still scans private fields, symmetric keys, unrelated values and credentials in public fields", () => {
			for (const value of [
				{ keys: [{ ...key, d: OPAQUE_KEY }] },
				{ keys: [{ kty: "oct", k: OPAQUE_KEY, kid: OPAQUE_KEY }] },
				{ keys: [{ ...key, extra: OPAQUE_KEY }] },
				{ ...jwks, secret: OPAQUE_KEY },
				{ x: coordinate, kid: OPAQUE_KEY },
				{ keys: [{ kid: OPAQUE_KEY }] },
				{ keys: [{ ...key, kid: GITHUB_TOKEN }] },
			]) {
				expect(findSecretValuePattern(value)).not.toBeNull();
				expect(
					findSecretValuePattern({ content: JSON.stringify(value) }),
				).not.toBeNull();
			}
		});
	});

	it("blocks opaque secrets in overwritten JSON properties", () => {
		const content = `{"secret":"${OPAQUE_KEY}","secret":"public"}`;
		expect(findSecretValuePattern({ content })).toBe("long opaque token");
	});

	describe("word slugs", () => {
		const COPY_KEY =
			"ui_invoice_ocr_latency_spiked_2_9_on_jun_7_consider_adding_a_re";

		it("lets a lowercase copy-key slug through as a value or an object key", () => {
			expect(findSecretValuePattern({ key: COPY_KEY })).toBeNull();
			expect(
				findSecretValuePattern({ blocks: [{ copy: { [COPY_KEY]: "Hi" } }] }),
			).toBeNull();
		});

		it("allows long readable product URL slugs while blocking adjacent secrets", () => {
			const slug = "123456789-modern-outdoor-garden-table-with-six-chairs";
			const url = `https://catalog.example.com/products/${slug}`;
			expect(findSecretValuePattern({ url })).toBeNull();
			expect(
				findSecretValuePattern({ content: JSON.stringify([{ url }]) }),
			).toBeNull();
			expect(
				findSecretValuePattern({ url: `${url}?token=${GITHUB_TOKEN}` }),
			).toBe("GitHub token");
			expect(findSecretValuePattern({ url: `${url}/${OPAQUE_KEY}` })).toBe(
				"long opaque token",
			);
			expect(
				findSecretValuePattern({ url: OPAQUE_KEY.replace(/(.{8})/g, "$1-") }),
			).toBe("long opaque token");
		});

		it("still blocks random 40+ char tokens, including ones with a few underscores", () => {
			for (const token of [
				OPAQUE_KEY,
				"a8f3k29dj4h5_l6m7n8b9v0c1_x2z3q4w5e6r7t8y9",
				"Ab3d_Ef6h_Ij9l_Mn2p_Qr5t_Uv8x_Yz1b_Cd4f_Gh7j",
				"a8f3_k29d_j4h5_l6m7_n8b9_v0c1_x2z3_q4w5_e6r7",
				"abcdefghijklmnop0123_qrstuv_wxyz_ab_cd_ef_gh",
			]) {
				expect(findSecretValuePattern({ value: token })).toBe(
					"long opaque token",
				);
				expect(findSecretValuePattern({ [token]: "x" })).toBe(
					"long opaque token",
				);
			}
		});

		it("still blocks provider-prefixed keys shaped like snake_case", () => {
			expect(findSecretValuePattern({ [STRIPE_KEY]: "x" })).toBe(
				"prefixed API key",
			);
			expect(findSecretValuePattern({ [`${STRIPE_KEY}_a_b_c`]: "x" })).toBe(
				"prefixed API key",
			);
			expect(findSecretValuePattern({ value: `${GITHUB_TOKEN}_a_b_c` })).toBe(
				"GitHub token",
			);
		});
	});
	describe("references a tool returned earlier in the execution", () => {
		const PRODUCT_REF =
			"pr.v1.k1.QmFzZTY0RW5jb2RlZFRva2VuMTIzNDU2Nzg5MEFCQ0RFRkdISUo";

		it("collects only opaque strings, never provider-shaped secrets", () => {
			const returned = new Set<string>();
			collectReturnedOpaqueValues(
				{
					results: [{ productRef: PRODUCT_REF, name: "Switch 2" }],
					leaked: GITHUB_TOKEN,
				},
				returned,
			);
			expect([...returned]).toEqual([PRODUCT_REF]);
		});

		it("lets the same tool receive its own reference but nothing else", () => {
			const returned = new Set([PRODUCT_REF]);
			expect(findSecretValuePattern({ productRef: PRODUCT_REF })).toBe(
				"long opaque token",
			);
			expect(
				findSecretValuePattern(
					{ productRef: PRODUCT_REF },
					undefined,
					returned,
				),
			).toBeNull();
			expect(
				findSecretValuePattern({ productRef: OPAQUE_KEY }, undefined, returned),
			).toBe("long opaque token");
			expect(
				findSecretValuePattern(
					{ productRef: GITHUB_TOKEN },
					undefined,
					new Set([GITHUB_TOKEN]),
				),
			).toBe("GitHub token");
		});
	});
});
