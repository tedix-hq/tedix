// Tedi mailbox and outbound email tool specs.
import type { ToolInputJsonSchema } from "@tedix/api-contract/schemas/tools";
import {
	MUTATING,
	READ_ONLY,
	type TediToolSpec,
} from "./aggregate-tedis-shared";

const EMAIL_INBOX_LIST_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		status: {
			type: "string",
			enum: ["open", "archived", "spam", "all"],
		},
		unread: { type: "boolean" },
		query: { type: "string" },
		cursor: { type: "string" },
		limit: { type: "integer" },
	},
	additionalProperties: false,
};

const EMAIL_THREAD_READ_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		threadId: { type: "string", format: "uuid" },
		markRead: { type: "boolean" },
	},
	required: ["threadId"],
	additionalProperties: false,
};

const EMAIL_SEARCH_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		query: { type: "string" },
		limit: { type: "integer" },
	},
	required: ["query"],
	additionalProperties: false,
};

const EMAIL_RECIPIENT_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		email: { type: "string", format: "email" },
		name: { type: "string" },
	},
	required: ["email"],
	additionalProperties: false,
};

const EMAIL_SEND_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		to: {
			type: "array",
			items: EMAIL_RECIPIENT_SCHEMA,
			minItems: 1,
			maxItems: 50,
		},
		cc: {
			type: "array",
			items: EMAIL_RECIPIENT_SCHEMA,
			maxItems: 50,
		},
		bcc: {
			type: "array",
			items: EMAIL_RECIPIENT_SCHEMA,
			maxItems: 50,
		},
		subject: { type: "string" },
		text: { type: "string" },
		html: { type: "string" },
		replyTo: EMAIL_RECIPIENT_SCHEMA,
		threadId: { type: "string", format: "uuid" },
	},
	required: ["to", "subject"],
	additionalProperties: false,
};

const EMAIL_REPLY_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		threadId: { type: "string", format: "uuid" },
		messageId: { type: "string", format: "uuid" },
		subject: { type: "string" },
		text: { type: "string" },
		html: { type: "string" },
		cc: {
			type: "array",
			items: EMAIL_RECIPIENT_SCHEMA,
			maxItems: 49,
		},
		bcc: {
			type: "array",
			items: EMAIL_RECIPIENT_SCHEMA,
			maxItems: 49,
		},
		replyTo: EMAIL_RECIPIENT_SCHEMA,
	},
	additionalProperties: false,
};

const EMAIL_MARK_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		threadId: { type: "string", format: "uuid" },
		messageId: { type: "string", format: "uuid" },
		read: { type: "boolean" },
		archived: { type: "boolean" },
		spam: { type: "boolean" },
	},
	additionalProperties: false,
};

const EMAIL_ATTACHMENT_GET_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		attachmentId: { type: "string", format: "uuid" },
		maxBytes: { type: "integer" },
	},
	required: ["attachmentId"],
	additionalProperties: false,
};

const EMAIL_MESSAGE_SOURCE_GET_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		messageId: { type: "string", format: "uuid" },
		part: { type: "string", enum: ["raw", "html"] },
		maxBytes: { type: "integer" },
	},
	required: ["messageId", "part"],
	additionalProperties: false,
};

const EMAIL_ADDRESS_LIST_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		status: {
			type: "string",
			enum: ["active", "paused", "reserved", "all"],
		},
	},
	additionalProperties: false,
};

const EMAIL_ADDRESS_REQUEST_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		address: { type: "string", format: "email" },
		kind: { type: "string", enum: ["alias", "plus", "custom_domain"] },
		routingPolicy: { type: "object", additionalProperties: true },
	},
	required: ["address", "kind"],
	additionalProperties: false,
};

export const EMAIL_TOOLS: TediToolSpec[] = [
	{
		// Platform-routed via apps/api `/rpc/tediEmail/sendEmail` → sendTransactionalEmail.
		// Runtime-neutral. `rpcEndpoint` makes this an
		// RPC-transport tool, so the aggregate config carries the selected tedi
		// identity out of band and the handler resolves it to `tediId` for the
		// contract. Mailbox-read tools still need a native provider or Agent-runtime route before aggregate advertisement.
		name: "email_send",
		remoteName: "email_send",
		description: "Send a new outbound email as this tedi.",
		inputSchema: EMAIL_SEND_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "tediEmail/sendEmail",
	},
];
