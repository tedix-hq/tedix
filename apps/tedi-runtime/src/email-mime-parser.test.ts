import assert from "node:assert/strict";
import PostalMime from "postal-mime";
import { parseInboundEmailMime } from "./email-mime-parser";

const privateText =
	"PRIVATE subject body sender https://private.example/secret";
const warnings: unknown[][] = [];
const originalWarn = console.warn;
console.warn = (...fields: unknown[]) => warnings.push(fields);
try {
	const parsed = await parseInboundEmailMime("Subject: fixture\r\n\r\nhello");
	assert.equal(parsed.subject, "fixture");
	assert.equal(parsed.text?.trim(), "hello");
	assert.equal(warnings.length, 0);
	let parserError: unknown;
	await assert.rejects(
		parseInboundEmailMime(
			`Subject: ${privateText.repeat(20)}\r\n\r\n${privateText}`,
			async (raw) => {
				try {
					return await PostalMime.parse(raw, { maxHeadersSize: 128 });
				} catch (error) {
					parserError = error;
					throw error;
				}
			},
		),
		(error) => error === parserError,
	);
	assert.deepEqual(warnings.pop(), [
		{
			component: "tedi-runtime",
			event: "tedi.runtime.email_parse_failed",
			parserCode: "EMAXHEADERSIZE",
			exception: { type: "Error" },
		},
	]);
	for (const code of ["EMAXPARTCOUNT", privateText]) {
		const original = Object.assign(new Error(privateText), { code });
		await assert.rejects(
			parseInboundEmailMime(privateText, async () => {
				throw original;
			}),
			(error) => error === original,
		);
		const diagnostic = warnings.pop();
		assert.equal(
			(diagnostic?.[0] as { parserCode: string }).parserCode,
			code === "EMAXPARTCOUNT" ? code : "unknown",
		);
		assert.ok(!JSON.stringify(diagnostic).includes("PRIVATE"));
		assert.ok(!JSON.stringify(diagnostic).includes("private.example"));
	}
	const original = new Error(privateText);
	console.warn = () => {
		throw new Error("unavailable");
	};
	await assert.rejects(
		parseInboundEmailMime(privateText, async () => {
			throw original;
		}),
		(error) => error === original,
	);
	assert.equal(warnings.length, 0);
} finally {
	console.warn = originalWarn;
}
console.log(
	"Inbound MIME parser: stable codes, original error identity and privacy-safe diagnostics pass",
);
