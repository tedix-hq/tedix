import { describe, expect, it } from "vite-plus/test";
import {
	describeToolCall,
	describeToolFailure,
	formatJson,
	formatPartialJson,
	jsonSizeLabel,
	parseJsonLoose,
	parseWriteApprovalRequest,
	parseWriteFailure,
	plainError,
	readJsonPayload,
	splitJsonSegments,
	unwrapMcpContent,
} from "./chat-structured-content";

const REQUEST_ID = "4f0c2a8e-1b7d-4c3e-9a51-0d6e2f8b7c10";
const ARGS = {
	kind: "sheet",
	title: "Opportunities - final format",
	content: {
		tabs: [
			{
				name: "Leads",
				rows: [
					["Company", "Stage", "Next step"],
					["Northwind Tiles", "Qualified", "Send pricing"],
				],
			},
		],
	},
};

/** The exact shape `kernelWriteCardContent` writes. */
function serverApprovalText(args: string): string {
	return [
		"Create sheet “Opportunities - final format”.",
		"Nothing has been executed. Reply “approve” or “yes” to proceed, or “reject” to cancel.",
		"### Details",
		"Tool: `os.create_os_output` on fern-labs",
		`Request: ${REQUEST_ID}`,
		`Arguments: ${args}`,
	].join("\n\n");
}

describe("unwrapMcpContent", () => {
	it("joins the text items of an MCP content array", () => {
		expect(
			unwrapMcpContent([
				{ type: "text", text: "First." },
				{ type: "text", text: "Second." },
			]),
		).toBe("First.\n\nSecond.");
	});

	it("leaves anything that is not all text items alone", () => {
		expect(unwrapMcpContent([{ type: "image", data: "…" }])).toBeNull();
		expect(unwrapMcpContent([{ type: "text" }])).toBeNull();
		expect(unwrapMcpContent([])).toBeNull();
		expect(unwrapMcpContent({ type: "text", text: "x" })).toBeNull();
		expect(unwrapMcpContent("text")).toBeNull();
	});
});

describe("parseJsonLoose", () => {
	it("reads plain and once-escaped JSON", () => {
		expect(parseJsonLoose('{"a":1}')).toEqual({ value: { a: 1 } });
		expect(
			parseJsonLoose('[{\\"type\\":\\"text\\",\\"text\\":\\"hi\\"}]'),
		).toEqual({ value: [{ type: "text", text: "hi" }] });
	});

	it("rejects text that is not JSON", () => {
		expect(parseJsonLoose("not json")).toBeNull();
		expect(parseJsonLoose('{"a":')).toBeNull();
	});
});

describe("splitJsonSegments", () => {
	it("returns plain text as a single unchanged segment", () => {
		const text = "Invoice F-241 needs a **credit note**. [Open it](/work)";
		expect(splitJsonSegments(text)).toEqual([{ kind: "text", text }]);
	});

	it("cuts a large embedded object out of the prose", () => {
		const json = JSON.stringify(ARGS);
		const segments = splitJsonSegments(`Here is the result: ${json} Done.`);
		expect(segments).toEqual([
			{ kind: "text", text: "Here is the result: " },
			{ kind: "json", raw: json, value: ARGS },
			{ kind: "text", text: " Done." },
		]);
	});

	it("keeps short JSON, invalid JSON and code spans as text", () => {
		const short = 'Set {"a":1} and [1, 2].';
		expect(splitJsonSegments(short)).toEqual([{ kind: "text", text: short }]);
		const broken = `Broken: {"title": "${"x".repeat(100)}", }`;
		expect(splitJsonSegments(broken)).toEqual([{ kind: "text", text: broken }]);
		const fenced = `Example:\n\n\`\`\`json\n${JSON.stringify(ARGS)}\n\`\`\``;
		expect(splitJsonSegments(fenced)).toEqual([{ kind: "text", text: fenced }]);
		const inline = `Use \`${JSON.stringify(ARGS)}\` here.`;
		expect(splitJsonSegments(inline)).toEqual([{ kind: "text", text: inline }]);
	});

	it("ignores markdown links and brackets inside JSON strings", () => {
		const value = {
			note: "see [docs](https://example.com) and {braces}",
			n: "y".repeat(80),
		};
		const json = JSON.stringify(value);
		const text = `[link](/a) then ${json}`;
		expect(splitJsonSegments(text)).toEqual([
			{ kind: "text", text: "[link](/a) then " },
			{ kind: "json", raw: json, value },
		]);
	});

	it("unwraps an MCP content array to its text", () => {
		const raw = JSON.stringify([
			{
				type: "text",
				text: "The tool ran but returned a warning about rate limits.",
			},
		]);
		expect(splitJsonSegments(`Result: ${raw}`)).toEqual([
			{ kind: "text", text: "Result: " },
			{
				kind: "mcp_text",
				raw,
				text: "The tool ran but returned a warning about rate limits.",
			},
		]);
	});
});

describe("describeToolCall", () => {
	it("names the action in plain words", () => {
		expect(describeToolCall("os.create_os_output")).toBe("Create output");
		expect(describeToolCall("tedix__send_email")).toBe("Send email");
	});

	it("uses kind and title arguments", () => {
		expect(describeToolCall("os.create_os_output", ARGS)).toBe(
			"Create sheet “Opportunities - final format”",
		);
		expect(describeToolCall("crm.update_contact", { name: "Ada Fern" })).toBe(
			"Update contact “Ada Fern”",
		);
	});

	it("describes failures as what could not be done", () => {
		expect(describeToolFailure("os.create_os_output")).toBe(
			"Couldn't create the output",
		);
		expect(describeToolFailure("os.create_os_output", { kind: "sheet" })).toBe(
			"Couldn't create the sheet",
		);
		expect(describeToolFailure("gmail_lookup")).toBe(
			"Couldn't run Gmail lookup",
		);
	});
});

describe("parseWriteApprovalRequest", () => {
	it("reads the server's approval message", () => {
		const json = JSON.stringify(ARGS);
		expect(parseWriteApprovalRequest(serverApprovalText(json))).toEqual({
			summary: "Create sheet “Opportunities - final format”",
			note: null,
			instruction:
				"Nothing has been executed. Reply “approve” or “yes” to proceed, or “reject” to cancel.",
			toolName: "os.create_os_output",
			appSlug: "fern-labs",
			requestId: REQUEST_ID,
			args: { complete: true, value: ARGS, raw: json },
		});
	});

	it("reads the flattened one-line form with shortened arguments", () => {
		const json = JSON.stringify(ARGS).slice(0, 60);
		const text = `Create sheet 'Opportunities - final format'. Nothing has been executed. Reply 'approve' or 'yes' to proceed, or 'reject' to cancel. Details: Tool: os.create_os_output on fern-labs. Request: ${REQUEST_ID}. Arguments: ${json}…`;
		const parsed = parseWriteApprovalRequest(text);
		expect(parsed).toMatchObject({
			summary: "Create sheet 'Opportunities - final format'",
			instruction:
				"Nothing has been executed. Reply 'approve' or 'yes' to proceed, or 'reject' to cancel.",
			toolName: "os.create_os_output",
			appSlug: "fern-labs",
			requestId: REQUEST_ID,
			args: { complete: false, raw: json },
		});
	});

	it("keeps a reasoning paragraph as a note", () => {
		const text = serverApprovalText("{}").replace(
			"\n\nNothing",
			"\n\nThe team asked for a weekly digest.\n\nNothing",
		);
		expect(parseWriteApprovalRequest(text)?.note).toBe(
			"The team asked for a weekly digest.",
		);
	});

	it("ignores ordinary text", () => {
		expect(
			parseWriteApprovalRequest("Tool: hammer. Arguments: none"),
		).toBeNull();
		expect(
			parseWriteApprovalRequest(
				"Nothing has been executed yet, I am thinking.",
			),
		).toBeNull();
	});
});

describe("parseWriteFailure", () => {
	const mcpError =
		'[{"type":"text","text":"Action \\"tedix__create_os_output\\" requires approval. No side effect was executed."}]';

	it("unwraps an MCP content array in the error", () => {
		expect(
			parseWriteFailure(
				`Approved write os.create_os_output on fern-labs failed: ${mcpError}`,
			),
		).toEqual({
			toolName: "os.create_os_output",
			appSlug: "fern-labs",
			error:
				'Action "tedix__create_os_output" requires approval. No side effect was executed.',
		});
	});

	it("unwraps an escaped MCP content array", () => {
		const escaped = JSON.stringify(mcpError).slice(1, -1);
		expect(
			parseWriteFailure(
				`Approved write os.create_os_output on fern-labs failed: ${escaped}`,
			)?.error,
		).toBe(
			'Action "tedix__create_os_output" requires approval. No side effect was executed.',
		);
	});

	it("keeps a plain error and ignores other text", () => {
		expect(
			parseWriteFailure("Approved write crm.update_contact failed: timeout")
				?.error,
		).toBe("timeout");
		expect(parseWriteFailure("The write failed: timeout")).toBeNull();
	});

	it("reads message objects and empty errors", () => {
		expect(plainError('{"message":"Quota reached"}')).toBe("Quota reached");
		expect(plainError("  ")).toBe("No reason was given.");
	});
});

describe("JSON formatting", () => {
	it("pretty-prints and folds long strings on request", () => {
		const value = { short: "ok", long: "z".repeat(300) };
		expect(formatJson(value).text).toBe(JSON.stringify(value, null, 2));
		const folded = formatJson(value, { fold: true });
		expect(folded.folded).toBe(1);
		expect(folded.text).toContain("… (180 more characters)");
		expect(folded.text).not.toContain("z".repeat(200));
	});

	it("indents JSON that was cut short", () => {
		expect(formatPartialJson('{"a":[1,{"b":"x, {y}"}],"c":"tr')).toBe(
			'{\n  "a": [\n    1,\n    {\n      "b": "x, {y}"\n    }\n  ],\n  "c": "tr',
		);
	});

	it("reads complete and shortened payloads", () => {
		expect(readJsonPayload('{"a":1}')).toEqual({
			complete: true,
			value: { a: 1 },
			raw: '{"a":1}',
		});
		expect(readJsonPayload('{"a":1…')).toEqual({
			complete: false,
			raw: '{"a":1',
		});
		expect(readJsonPayload("none")).toBeNull();
	});

	it("labels the size of a payload", () => {
		expect(jsonSizeLabel({ a: 1 })).toBe("1 field");
		expect(jsonSizeLabel([1, 2])).toBe("2 items");
		expect(jsonSizeLabel("x")).toBeNull();
	});
});
