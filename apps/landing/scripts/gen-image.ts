#!/usr/bin/env bun
import { writeFile } from "node:fs/promises";
import { argv, env, exit } from "node:process";

const apiKey = env.GEMINI_API_KEY;
if (!apiKey) {
	console.error(
		"Set GEMINI_API_KEY in your environment, then run:\n" +
			"  bun apps/landing/scripts/gen-image.ts <out> <prompt>",
	);
	exit(1);
}

const [, , outPath, ...promptParts] = argv;
if (!outPath || promptParts.length === 0) {
	console.error("usage: gen-image.ts <out-path> <prompt...>");
	exit(1);
}
const prompt = promptParts.join(" ");

const model = env.GEMINI_IMAGE_MODEL ?? "gemini-2.5-flash-image";
const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

const res = await fetch(url, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({
		contents: [{ parts: [{ text: prompt }] }],
		generationConfig: { responseModalities: ["IMAGE"] },
	}),
});

if (!res.ok) {
	console.error(`HTTP ${res.status} ${res.statusText}`);
	console.error(await res.text());
	exit(1);
}

const json = (await res.json()) as {
	candidates?: Array<{
		content?: {
			parts?: Array<{ inlineData?: { mimeType: string; data: string } }>;
		};
	}>;
};
const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
if (!part?.inlineData) {
	console.error("no image in response:", JSON.stringify(json, null, 2));
	exit(1);
}

const buf = Buffer.from(part.inlineData.data, "base64");
await writeFile(outPath, buf);
console.log(
	`wrote ${outPath} (${(buf.length / 1024).toFixed(1)} KiB, ${part.inlineData.mimeType})`,
);
