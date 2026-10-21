import { describe, expect, it } from "vite-plus/test";
import {
	applyApprovalEdits,
	applyApproverEditsToPayload,
	approvalEditableFieldKind,
	approvalPayloadEditableFields,
	deriveApprovalEditableFields,
} from "./approval-edits";

const inputSchema = {
	properties: {
		folderId: { type: "string", description: "Destination folder" },
		title: { type: "string", minLength: 1, maxLength: 120 },
		recipients: { type: "array", items: { type: "string" } },
		visibility: { enum: ["private", "team"] },
		notify: { type: "boolean" },
		priority: { type: "integer", minimum: 1, maximum: 5 },
		accountId: { type: "string" },
		body: { type: "string" },
	},
	required: ["folderId", "title"],
};

describe("deriveApprovalEditableFields", () => {
	it("offers content scalars without destination fields in schema order", () => {
		const fields = deriveApprovalEditableFields({
			inputSchema,
			pinned: ["accountId"],
		});
		expect(fields.map((field) => field.name)).toEqual([
			"title",
			"visibility",
			"notify",
			"priority",
			"body",
		]);
		expect(fields[0]).toMatchObject({
			label: "Title",
			required: true,
		});
		expect(fields.map((field) => approvalEditableFieldKind(field))).toEqual([
			"text",
			"choice",
			"boolean",
			"integer",
			"long_text",
		]);
	});

	it.each([
		"recipient",
		"emailaddress",
		"channelname",
		"recipients",
		"to",
		"cc",
		"bcc",
		"replyTo",
		"recipientEmail",
		"email",
		"email_address",
		"callbackUrl",
		"endpoint",
		"webhookUrl",
		"channel",
		"channel_id",
		"filePath",
		"repo",
		"repository",
		"branch",
		"accountId",
		"connection_id",
		"workspaceId",
		"organizationId",
		"org_id",
		"folderId",
		"destination",
		"target",
		"userIds",
	])("requires explicit policy for destination %s", (name) => {
		const schema = { properties: { [name]: { type: "string" } } };
		expect(deriveApprovalEditableFields({ inputSchema: schema })).toEqual([]);
		expect(
			deriveApprovalEditableFields({
				inputSchema: schema,
				declared: [name],
			}).map((field) => field.name),
		).toEqual([name]);
		expect(
			deriveApprovalEditableFields({
				inputSchema: schema,
				declared: [name],
				pinned: [name],
			}),
		).toEqual([]);
	});

	it("keeps plain content fields editable", () => {
		const names = ["subject", "body", "text", "label", "title"];
		expect(
			deriveApprovalEditableFields({
				inputSchema: {
					properties: Object.fromEntries(
						names.map((name) => [name, { type: "string" }]),
					),
				},
			}).map((field) => field.name),
		).toEqual(names);
	});

	it("uses the tool's configured list, and an empty list turns edits off", () => {
		expect(
			deriveApprovalEditableFields({
				inputSchema,
				declared: ["title", "recipients", "missing", "accountId"],
				pinned: ["accountId"],
			}).map((field) => field.name),
		).toEqual(["title"]);
		expect(deriveApprovalEditableFields({ inputSchema, declared: [] })).toEqual(
			[],
		);
	});
});

describe("applyApprovalEdits", () => {
	const fields = deriveApprovalEditableFields({
		inputSchema,
		declared: Object.keys(inputSchema.properties),
	});
	const args = { folderId: "f-1", title: "Draft", recipients: ["a@x.test"] };

	it("records only real changes against the tool schema", () => {
		const result = applyApprovalEdits({
			fields,
			args,
			edits: { folderId: "f-2", title: "Draft", priority: 3 },
		});
		expect(result).toEqual({
			ok: true,
			args: { ...args, folderId: "f-2", priority: 3 },
			changes: [
				{ field: "folderId", before: "f-1", after: "f-2" },
				{ field: "priority", before: null, after: 3 },
			],
		});
	});

	it("rejects undeclared fields, invalid values and empty required fields", () => {
		expect(
			applyApprovalEdits({ fields, args, edits: { recipients: [] } }),
		).toEqual({ ok: false, error: '"recipients" cannot be changed' });
		expect(
			applyApprovalEdits({ fields, args, edits: { visibility: "public" } }),
		).toMatchObject({ ok: false });
		expect(
			applyApprovalEdits({ fields, args, edits: { priority: 9 } }),
		).toMatchObject({ ok: false });
		expect(applyApprovalEdits({ fields, args, edits: { title: "" } })).toEqual({
			ok: false,
			error: "Title is required",
		});
	});

	it("clears an optional field set to empty", () => {
		expect(
			applyApprovalEdits({
				fields,
				args: { ...args, body: "Hello" },
				edits: { body: null },
			}),
		).toEqual({
			ok: true,
			args,
			changes: [{ field: "body", before: "Hello", after: null }],
		});
	});
});

describe("applyApproverEditsToPayload", () => {
	const payload = {
		kind: "home_tool_write",
		args: { folderId: "f-1", title: "Draft" },
		editableFields: deriveApprovalEditableFields({ inputSchema }),
	};

	it("rewrites args and records who changed what", () => {
		const result = applyApproverEditsToPayload({
			payload,
			edits: { title: "Final" },
			editedBy: "user-1",
			editedAt: "2026-10-21T10:00:00.000Z",
		});
		expect(result).toEqual({
			ok: true,
			changes: [{ field: "title", before: "Draft", after: "Final" }],
			payload: {
				...payload,
				args: { folderId: "f-1", title: "Final" },
				approverEdits: {
					editedBy: "user-1",
					editedAt: "2026-10-21T10:00:00.000Z",
					changes: [{ field: "title", before: "Draft", after: "Final" }],
				},
			},
		});
	});

	it("refuses edits when the request declares no editable fields", () => {
		expect(approvalPayloadEditableFields({ kind: "deploy" })).toEqual([]);
		expect(
			applyApproverEditsToPayload({
				payload: { kind: "deploy" },
				edits: { title: "x" },
				editedBy: "user-1",
				editedAt: "2026-10-21T10:00:00.000Z",
			}),
		).toMatchObject({ ok: false });
	});
});

it.each(["reportTitle", "reportText", "securityLabel"])(
	"does not mistake content field %s for a destination substring",
	(name) => {
		expect(
			deriveApprovalEditableFields({
				inputSchema: { properties: { [name]: { type: "string" } } },
			}).map((field) => field.name),
		).toEqual([name]);
	},
);
