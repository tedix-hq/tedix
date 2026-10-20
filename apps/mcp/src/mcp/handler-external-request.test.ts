import type { ToolConfig } from "@tedix/api-contract/schemas/tools";
import { describe, expect, it } from "vite-plus/test";
import {
	buildMultipartBody,
	buildUrlEncodedBody,
	ExternalRequestInputError,
	fileParamToBlob,
	parseDataUrl,
	parseExternalResponse,
} from "./handler-external-request";

const config = (
	responseMode: ToolConfig["responseMode"] = "auto",
): ToolConfig => ({ endpoint: "", responseMode });

describe("external request helpers", () => {
	it("builds multipart files and repeated scalar fields while omitting nulls", async () => {
		const form = buildMultipartBody(
			{
				upload: {
					content: "data:text/plain;base64,aGVsbG8=",
					filename: " note.txt ",
				},
				tags: ["one", 2, false],
				metadata: { active: true },
				absent: null,
			},
			["upload"],
		);
		const file = form.get("upload") as File;
		expect(file.name).toBe("note.txt");
		expect(file.type).toBe("text/plain");
		expect(await file.text()).toBe("hello");
		expect(form.getAll("tags")).toEqual(["one", "2", "false"]);
		expect(form.get("metadata")).toBe('{"active":true}');
		expect(form.has("absent")).toBe(false);
	});

	it("encodes urlencoded arrays, objects, and special characters", () => {
		const body = buildUrlEncodedBody({
			q: "a+b & c",
			list: ["x", null, [2, false]],
			obj: { n: 1 },
			missing: undefined,
		});
		expect(body.get("q")).toBe("a+b & c");
		expect(body.getAll("list")).toEqual(["x", "2", "false"]);
		expect(body.get("obj")).toBe('{"n":1}');
		expect(body.has("missing")).toBe(false);
		expect(body.toString()).toContain("q=a%2Bb+%26+c");
	});

	it("recognizes base64 data URLs and rejects invalid file input", async () => {
		expect(parseDataUrl("data:text/plain;charset=utf-8;base64,aGk=")).toEqual({
			mimeType: "text/plain",
			base64: "aGk=",
		});
		for (const value of ["text", "data:text/plain", "data:text/plain,hi"])
			expect(parseDataUrl(value)).toBeNull();
		expect(
			await fileParamToBlob("file", {
				base64: "a G k=",
				name: "hi.txt",
				type: "text/plain",
			}).blob.text(),
		).toBe("hi");
		for (const value of [null, "", "%%%", {}])
			expect(() => fileParamToBlob("file", value)).toThrow(
				ExternalRequestInputError,
			);
	});

	it("parses JSON and text automatically and honors explicit modes", async () => {
		expect(
			await parseExternalResponse(
				new Response('{"ok":true}', {
					headers: {
						"content-type": "application/problem+json; charset=utf-8",
					},
				}),
				config(),
			),
		).toEqual({ ok: true });
		expect(
			await parseExternalResponse(
				new Response("hello", { headers: { "content-type": "text/plain" } }),
				config(),
			),
		).toBe("hello");
		expect(
			await parseExternalResponse(new Response('{"ok":true}'), config("json")),
		).toEqual({ ok: true });
		expect(
			await parseExternalResponse(new Response("hello"), config("text")),
		).toBe("hello");
		expect(
			await parseExternalResponse(
				new Response('{"error":"denied"}', {
					status: 403,
					headers: { "content-type": "application/json" },
				}),
				config("base64"),
			),
		).toEqual({ error: "denied" });
	});

	it("encodes binary responses across base64 chunk boundaries and decodes filenames", async () => {
		const bytes = Uint8Array.from(
			{ length: 40_000 },
			(_, index) => index % 256,
		);
		const result = await parseExternalResponse(
			new Response(bytes, {
				headers: {
					"content-type": "application/octet-stream",
					"content-disposition":
						"attachment; filename=old.bin; filename*=UTF-8''report%20new.bin",
				},
			}),
			config(),
		);
		expect(result).toEqual({
			filename: "report new.bin",
			mimeType: "application/octet-stream",
			base64encoded: true,
			content: btoa(String.fromCharCode(...bytes)),
		});
		expect(
			await parseExternalResponse(
				new Response(new Uint8Array([1, 2, 3])),
				config(),
			),
		).toEqual({
			filename: null,
			mimeType: "application/octet-stream",
			base64encoded: true,
			content: "AQID",
		});
	});
});
