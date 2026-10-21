import assert from "node:assert/strict";
import {
	AiRequestTooLargeError,
	assertAiRequestSize,
	DEFAULT_MAX_AI_REQUEST_BYTES,
	resolveMaxAiRequestBytes,
} from "./ai-request-guard";

for (const configured of [
	undefined,
	"",
	" \t\n",
	"0",
	"-0",
	"-1",
	"-1.5",
	"NaN",
	"not-a-number",
	"Infinity",
	"-Infinity",
	"1e309",
	"0.5",
	"0.999999",
	"5e-324",
	"9007199254740992",
	"9007199254740993",
	"1e100",
]) {
	assert.equal(
		resolveMaxAiRequestBytes(configured),
		DEFAULT_MAX_AI_REQUEST_BYTES,
		`invalid limit ${JSON.stringify(configured)} uses the default`,
	);
}

for (const [configured, expected] of [
	["1", 1],
	["1.9", 1],
	["123", 123],
	["123.75", 123],
	[" 123.75 ", 123],
	["1e3", 1000],
	["0x10", 16],
	["9007199254740990", Number.MAX_SAFE_INTEGER - 1],
	["9007199254740991", Number.MAX_SAFE_INTEGER],
] as const) {
	assert.equal(resolveMaxAiRequestBytes(configured), expected, configured);
}

const backing = new ArrayBuffer(16);
const bodies: Array<{ name: string; body: BodyInit; bytes: number }> = [
	{ name: "UTF-8 string", body: "é🙂", bytes: 6 },
	{
		name: "URLSearchParams serialization",
		body: new URLSearchParams({ q: "é 🙂" }),
		bytes: 21,
	},
	{ name: "Blob", body: new Blob(["é🙂"]), bytes: 6 },
	{ name: "ArrayBuffer", body: new ArrayBuffer(6), bytes: 6 },
	{
		name: "Uint8Array with nonzero offset",
		body: new Uint8Array(backing, 4, 6),
		bytes: 6,
	},
	{
		name: "Uint16Array with nonzero offset",
		body: new Uint16Array(backing, 4, 3),
		bytes: 6,
	},
	{
		name: "DataView with nonzero offset",
		body: new DataView(backing, 4, 6),
		bytes: 6,
	},
];

for (const { name, body, bytes } of bodies) {
	assert.doesNotThrow(() => assertAiRequestSize(body, String(bytes)), name);
	assert.throws(
		() => assertAiRequestSize(body, String(bytes - 1)),
		(error) => {
			assert.ok(error instanceof AiRequestTooLargeError, name);
			assert.equal(error.name, "AiRequestTooLargeError", name);
			assert.equal(error.bytes, bytes, name);
			assert.equal(error.limit, bytes - 1, name);
			return true;
		},
	);
}

for (const body of [
	null,
	undefined,
	"",
	new URLSearchParams(),
	new Blob(),
	new ArrayBuffer(0),
	new Uint8Array(backing, 4, 0),
	new DataView(backing, 4, 0),
]) {
	assert.doesNotThrow(() => assertAiRequestSize(body, "1"));
}

assert.doesNotThrow(() => assertAiRequestSize("x", "1.9"));
assert.throws(() => assertAiRequestSize("xx", "1.9"), {
	name: "AiRequestTooLargeError",
	bytes: 2,
	limit: 1,
});

for (const configured of [undefined, "0.5", "9007199254740992"]) {
	const body = "x".repeat(DEFAULT_MAX_AI_REQUEST_BYTES);
	assert.doesNotThrow(() => assertAiRequestSize(body, configured));
	assert.throws(() => assertAiRequestSize(`${body}x`, configured), {
		name: "AiRequestTooLargeError",
		bytes: DEFAULT_MAX_AI_REQUEST_BYTES + 1,
		limit: DEFAULT_MAX_AI_REQUEST_BYTES,
	});
}

// These bodies remain unbuffered; their serialized size is intentionally unknown.
const form = new FormData();
form.append("q", "oversized");
assert.doesNotThrow(() => assertAiRequestSize(form, "1"));
const stream = new ReadableStream<Uint8Array>();
assert.doesNotThrow(() => assertAiRequestSize(stream, "1"));
assert.equal(stream.locked, false);

console.log("PASS: AI request limit normalization and body byte boundaries");
