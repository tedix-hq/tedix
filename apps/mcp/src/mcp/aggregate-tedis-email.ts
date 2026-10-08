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

/**
 * Mirrors `EmailRoutingPolicySchema` (packages/api-contract/src/schemas/
 * tedi-email.ts). Strict on both sides: the inbound policy reads exactly these
 * keys, so an unknown key is rejected rather than silently ignored.
 */
const EMAIL_ROUTING_POLICY_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		allowedSenders: {
			type: "array",
			items: { type: "string" },
			maxItems: 200,
			description:
				'Trusted senders: full lowercase emails ("ceo@example.com") or @domain suffixes ("@example.com"). A match is trusted only when the message passed DKIM or DMARC for that domain. Replaces the whole list on update.',
		},
		untrustedSenders: {
			type: "string",
			enum: ["deliver", "quarantine"],
			description:
				"Disposition for senders not in allowedSenders: deliver runs a reply-only turn; quarantine stores the message as spam and never reaches the model.",
		},
		spamThreshold: {
			type: "number",
			minimum: 0,
			maximum: 20,
			description:
				"Spam score (0-20, default 5) at or above which inbound mail is quarantined regardless of sender.",
		},
		source: {
			type: "string",
			maxLength: 100,
			description: "Optional provenance label for who or what set this policy.",
		},
	},
	additionalProperties: false,
};

const EMAIL_ADDRESS_CREATE_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		address: {
			type: "string",
			format: "email",
			description:
				"Mailbox to create for this tedi: {slug}@tedix.tech (kind primary) or {slug}+tag@tedix.tech (kind plus) activate immediately; alias and custom_domain addresses are reserved until a platform admin provisions them.",
		},
		kind: {
			type: "string",
			enum: ["primary", "plus", "alias", "custom_domain"],
		},
		routingPolicy: EMAIL_ROUTING_POLICY_SCHEMA,
	},
	required: ["address", "kind"],
	additionalProperties: false,
};

const EMAIL_ADDRESS_UPDATE_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		addressId: { type: "string", format: "uuid" },
		status: {
			type: "string",
			enum: ["active", "paused"],
			description:
				"active receives mail; paused keeps the address and its threads but stops routing. Omit to leave the status unchanged.",
		},
		routingPolicy: {
			anyOf: [EMAIL_ROUTING_POLICY_SCHEMA, { type: "null" }],
			description:
				"Replaces the whole routing policy; null clears it (default routing). Omit to leave it unchanged.",
		},
	},
	required: ["addressId"],
	additionalProperties: false,
};

const EMAIL_ADDRESS_DELETE_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		addressId: { type: "string", format: "uuid" },
	},
	required: ["addressId"],
	additionalProperties: false,
};

const ROUTING_POLICY_KEYS_HINT =
	"routingPolicy keys: allowedSenders = sender emails or @domain suffixes trusted only with a DKIM/DMARC pass; untrustedSenders = deliver (reply-only turn) | quarantine (stored as spam, no model) for everyone else; spamThreshold = spam score 0-20 (default 5) at or above which mail is quarantined.";

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
	// Mailbox address self-serve. All four ride the aggregate rpc transport so
	// the selected tedi is injected as `tediId` and the native dispatch gate
	// requires mcp:messaging.read / mcp:messaging.write, matching the API's
	// withAuthorization pairs (packages/mcp reviewed-rpc-endpoint-scopes).
	{
		name: "list_tedi_email_addresses",
		remoteName: "list_tedi_email_addresses",
		description:
			"List this tedi's mailbox addresses ({slug}@tedix.tech, +tag aliases, custom domains) with status and routing policy. " +
			ROUTING_POLICY_KEYS_HINT,
		inputSchema: EMAIL_ADDRESS_LIST_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "tediEmail/listAddresses",
	},
	{
		name: "create_tedi_email_address",
		remoteName: "create_tedi_email_address",
		description:
			"Create a mailbox for this tedi: {slug}@tedix.tech or {slug}+tag@tedix.tech with an optional inbound routing policy. " +
			ROUTING_POLICY_KEYS_HINT,
		inputSchema: EMAIL_ADDRESS_CREATE_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "tediEmail/createAddress",
	},
	{
		name: "update_tedi_email_address",
		remoteName: "update_tedi_email_address",
		description:
			"Update a mailbox's status (active, paused, reserved) and/or replace its inbound routing policy, e.g. to set a sender allowlist. " +
			ROUTING_POLICY_KEYS_HINT,
		inputSchema: EMAIL_ADDRESS_UPDATE_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "tediEmail/updateAddress",
	},
	{
		// Named retire_, not delete_: a delete_ name or destructiveHint resolves
		// to mcp:messaging.admin in the native dispatch gate, one tier above the
		// API's mcp:messaging.write guard, which would lock tenant admins out of
		// their own mailbox. Stored threads and messages survive the row removal.
		name: "retire_tedi_email_address",
		remoteName: "retire_tedi_email_address",
		description:
			"Retire a mailbox address so it stops receiving mail; stored threads and messages are kept. To pause instead, use update_tedi_email_address with status=paused.",
		inputSchema: EMAIL_ADDRESS_DELETE_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "tediEmail/deleteAddress",
	},
];
