/**
 * Tedi runtime inbound email ingress
 *
 * Inbound: Routes emails addressed to {slug}@tedix.tech to the correct tedi.
 * Messages are persisted via apps/api `tediEmail/inboundEmail` (durable mailbox
 * row), then handed to the AgentTediDO using the Agents SDK `routeAgentEmail()`
 * primitive (DO namespace binding, not a custom service-binding hop).
 *
 * Uses Cloudflare Email Routing (GA, free) on tedix.tech domain.
 */

import { callRpc, serviceBindingFetch } from "@tedix/api-client/internal";
import { getTediEmailIngressRouteBySlug } from "@tedix/db/queries/tedi-runtime-bootstrap";
import { routeAgentEmail } from "agents";
import { createSecureReplyEmailResolver } from "agents/email";
import { logInboundEmailPersistenceFailure } from "./email-ingress-failure-log";
import {
	type InboundTrust,
	parseAuthenticationResults,
	stampInboundTrustOnHeaders,
	stampInboundTrustOnRawBytes,
	isAutoSubmittedEmail,
} from "./email-sender-policy";

interface Env {
	API_SERVICE: Fetcher;
	DB: D1Database;
	TEDI_AGENT?: DurableObjectNamespace;
	TEDI_STORAGE: R2Bucket;
	EMAIL_SECRET?: string;
}

const MAX_MIME_DEPTH = 12;

type HeaderMap = Map<string, string[]>;

export interface ParsedEmailAttachment {
	filename?: string;
	contentType?: string;
	size?: number;
	r2Key?: string;
	contentId?: string;
	disposition?: string;
}

export interface ParsedInboundEmail {
	text: string;
	html?: string;
	attachments: ParsedEmailAttachment[];
	attachmentParts: ParsedEmailAttachmentPart[];
}

interface ParsedEmailAttachmentPart extends ParsedEmailAttachment {
	bytes: Uint8Array;
}

function normaliseEmail(value: string): string {
	return value.trim().toLowerCase();
}

function parseReferences(value: string | null): string[] {
	if (!value) return [];
	return [
		...new Set(
			value
				.split(/\s+/)
				.map((part) => part.trim())
				.filter(Boolean),
		),
	];
}

export function decodeMimeHeader(value: string): string {
	return value.replace(
		/=\?([^?]+)\?([bqBQ])\?([^?]+)\?=/g,
		(_match, charsetRaw: string, encodingRaw: string, data: string) => {
			const charset = charsetRaw.toLowerCase();
			const encoding = encodingRaw.toUpperCase();
			try {
				const bytes =
					encoding === "B"
						? Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
						: decodeQuotedPrintableHeader(data);
				return new TextDecoder(charset).decode(bytes);
			} catch {
				try {
					const bytes =
						encoding === "B"
							? Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
							: decodeQuotedPrintableHeader(data);
					return new TextDecoder("utf-8").decode(bytes);
				} catch {
					return data;
				}
			}
		},
	);
}

function decodeQuotedPrintableHeader(value: string): Uint8Array {
	const bytes: number[] = [];
	for (let i = 0; i < value.length; i += 1) {
		const char = value[i];
		if (char === "_") {
			bytes.push(0x20);
			continue;
		}
		if (char === "=" && /^[0-9a-fA-F]{2}$/.test(value.slice(i + 1, i + 3))) {
			bytes.push(Number.parseInt(value.slice(i + 1, i + 3), 16));
			i += 2;
			continue;
		}
		bytes.push(char?.charCodeAt(0) ?? 0);
	}
	return new Uint8Array(bytes);
}

function decodeQuotedPrintableText(value: string): string {
	const withoutSoftBreaks = value.replace(/=\r?\n/g, "");
	const encoder = new TextEncoder();
	const bytes: number[] = [];
	for (let i = 0; i < withoutSoftBreaks.length; i += 1) {
		const char = withoutSoftBreaks[i];
		if (
			char === "=" &&
			/^[0-9a-fA-F]{2}$/.test(withoutSoftBreaks.slice(i + 1, i + 3))
		) {
			bytes.push(Number.parseInt(withoutSoftBreaks.slice(i + 1, i + 3), 16));
			i += 2;
			continue;
		}
		bytes.push(...encoder.encode(char ?? ""));
	}
	return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}

function decodeQuotedPrintableBytes(value: string): Uint8Array {
	const withoutSoftBreaks = value.replace(/=\r?\n/g, "");
	const bytes: number[] = [];
	for (let i = 0; i < withoutSoftBreaks.length; i += 1) {
		const char = withoutSoftBreaks[i];
		if (
			char === "=" &&
			/^[0-9a-fA-F]{2}$/.test(withoutSoftBreaks.slice(i + 1, i + 3))
		) {
			bytes.push(Number.parseInt(withoutSoftBreaks.slice(i + 1, i + 3), 16));
			i += 2;
			continue;
		}
		bytes.push((char?.charCodeAt(0) ?? 0) & 0xff);
	}
	return new Uint8Array(bytes);
}

export interface EmailRecipientPayload {
	email: string;
	name?: string;
}

export function extractEmailRecipient(
	value: string | null | undefined,
): EmailRecipientPayload {
	const decoded = decodeMimeHeader(value ?? "").trim();
	const bracketMatch = decoded.match(/<([^<>]+)>/);
	const candidate = (bracketMatch?.[1] ?? decoded.split(",")[0] ?? "").trim();
	const emailMatch = candidate.match(/[^\s<>"]+@[^\s<>"]+/);
	const email = normaliseEmail(emailMatch?.[0] ?? candidate);
	const rawName = bracketMatch
		? decoded.slice(0, bracketMatch.index).trim()
		: decoded.replace(emailMatch?.[0] ?? "", "").trim();
	const name = rawName
		.replace(/^"+|"+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return name ? { email, name } : { email };
}

export function extractEmailRecipients(
	value: string | null | undefined,
): EmailRecipientPayload[] {
	return splitAddressHeader(value ?? "")
		.map(extractEmailRecipient)
		.filter((recipient) => recipient.email.length > 0);
}

function splitAddressHeader(value: string): string[] {
	const decoded = decodeMimeHeader(value).trim();
	if (!decoded) return [];
	const parts: string[] = [];
	let current = "";
	let inQuote = false;
	let angleDepth = 0;
	for (const char of decoded) {
		if (char === '"') inQuote = !inQuote;
		if (!inQuote && char === "<") angleDepth += 1;
		if (!inQuote && char === ">") angleDepth = Math.max(0, angleDepth - 1);
		if (!inQuote && angleDepth === 0 && char === ",") {
			if (current.trim()) parts.push(current.trim());
			current = "";
			continue;
		}
		current += char;
	}
	if (current.trim()) parts.push(current.trim());
	return parts;
}

function decodeHtmlEntities(value: string): string {
	// `&amp;` is decoded last so `&amp;#61;` stays the literal text `&#61;`.
	return value
		.replace(/&#x3d;/gi, "=")
		.replace(/&#61;/g, "=")
		.replaceAll("&amp;", "&");
}

function hasQuotedPrintableTransferEncoding(value: string): boolean {
	return /^content-transfer-encoding:\s*quoted-printable\b/im.test(value);
}

function decodeEmailText(
	value: string,
	options: { quotedPrintable?: boolean } = {},
): string {
	const decoded = options.quotedPrintable
		? decodeQuotedPrintableText(value)
		: value.replace(/=\r?\n/g, "");
	return decodeHtmlEntities(decoded);
}

function stripMessageHeaders(value: string): string {
	const match = value.match(/\r?\n\r?\n/);
	if (match?.index == null) return value;
	return value.slice(match.index + match[0].length);
}

function normalizeHeaderName(value: string): string {
	return value.trim().toLowerCase();
}

function parseHeaderBlock(value: string): HeaderMap {
	const headers: HeaderMap = new Map();
	let currentName: string | null = null;
	for (const rawLine of value.split(/\r?\n/)) {
		if (/^[\t ]/.test(rawLine) && currentName) {
			const values = headers.get(currentName);
			if (values?.length) values[values.length - 1] += ` ${rawLine.trim()}`;
			continue;
		}
		const separator = rawLine.indexOf(":");
		if (separator === -1) continue;
		currentName = normalizeHeaderName(rawLine.slice(0, separator));
		const next = rawLine.slice(separator + 1).trim();
		headers.set(currentName, [...(headers.get(currentName) ?? []), next]);
	}
	return headers;
}

function getHeader(headers: HeaderMap, name: string): string | null {
	return headers.get(normalizeHeaderName(name))?.[0] ?? null;
}

export function createEmailHeaderReader(
	headers: Pick<Headers, "get"> | undefined,
	rawBody: string,
): (name: string) => string | null {
	const rawHeaders = parseRawPart(rawBody).headers;
	return (name: string) => headers?.get(name) ?? getHeader(rawHeaders, name);
}

function parseRawPart(value: string): { headers: HeaderMap; body: string } {
	const match = value.match(/\r?\n\r?\n/);
	if (match?.index == null) {
		return { headers: new Map(), body: value };
	}
	return {
		headers: parseHeaderBlock(value.slice(0, match.index)),
		body: value.slice(match.index + match[0].length),
	};
}

function stripQuotes(value: string): string {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function decodeHeaderParameter(value: string): string {
	const stripped = stripQuotes(value);
	const encoded = stripped.match(/^([^']*)'[^']*'(.*)$/);
	if (encoded) {
		try {
			return decodeURIComponent(encoded[2] ?? "");
		} catch {
			return encoded[2] ?? stripped;
		}
	}
	return decodeMimeHeader(stripped);
}

function parseStructuredHeader(value: string | null): {
	value: string;
	params: Record<string, string>;
} {
	if (!value) return { value: "", params: {} };
	const parts = value.split(";").map((part) => part.trim());
	const params: Record<string, string> = {};
	for (const part of parts.slice(1)) {
		const separator = part.indexOf("=");
		if (separator === -1) continue;
		const name = part.slice(0, separator).trim().toLowerCase();
		params[name] = decodeHeaderParameter(part.slice(separator + 1));
	}
	return { value: (parts[0] ?? "").toLowerCase(), params };
}

function splitMultipartBody(body: string, boundary: string): string[] {
	const segments = body.split(`--${boundary}`);
	return segments
		.slice(1)
		.filter((segment) => !segment.trimStart().startsWith("--"))
		.map((segment) =>
			segment
				.replace(/^\r?\n/, "")
				.replace(/\r?\n$/, "")
				.replace(/\r?\n--$/, ""),
		)
		.filter((segment) => segment.trim().length > 0);
}

function decodeBase64Bytes(value: string): Uint8Array {
	const cleaned = value.replace(/\s+/g, "");
	try {
		return Uint8Array.from(atob(cleaned), (char) => char.charCodeAt(0));
	} catch {
		return new TextEncoder().encode(value);
	}
}

function decodePartText(body: string, transferEncoding: string | null): string {
	const encoding = (transferEncoding ?? "").trim().toLowerCase();
	if (encoding === "quoted-printable") return decodeQuotedPrintableText(body);
	if (encoding === "base64") {
		return new TextDecoder("utf-8").decode(decodeBase64Bytes(body));
	}
	return body;
}

function decodePartBytes(
	body: string,
	transferEncoding: string | null,
): Uint8Array {
	const encoding = (transferEncoding ?? "").trim().toLowerCase();
	if (encoding === "base64") return decodeBase64Bytes(body);
	if (encoding === "quoted-printable") return decodeQuotedPrintableBytes(body);
	return new TextEncoder().encode(body);
}

/**
 * Remove every `<tag ...>...</tag ...>` block in one linear pass, leaving an
 * unclosed block for the generic tag strip. Sender-controlled HTML must not
 * reach a lazy `<tag[\s\S]*?</tag>` regex, which rescans the remainder once
 * per unclosed opener.
 */
function stripHtmlElementBlocks(value: string, tag: string): string {
	const lower = value.toLowerCase();
	const open = `<${tag}`;
	const close = `</${tag}`;
	let output = "";
	let position = 0;
	for (;;) {
		const start = lower.indexOf(open, position);
		if (start === -1) return output + value.slice(position);
		const end = lower.indexOf(close, start + open.length);
		const endTag = end === -1 ? -1 : lower.indexOf(">", end + close.length);
		if (endTag === -1) return output + value.slice(position);
		output += `${value.slice(position, start)} `;
		position = endTag + 1;
	}
}

function htmlToText(value: string): string {
	return stripHtmlElementBlocks(
		stripHtmlElementBlocks(value, "style"),
		"script",
	)
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, " ")
		.replace(/<[^<>]+>/g, " ")
		.replace(/\u00a0/g, " ")
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s+/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function parseMimePart(
	rawPart: string,
	result: ParsedInboundEmail,
	depth = 0,
): void {
	if (depth > MAX_MIME_DEPTH) return;
	const { headers, body } = parseRawPart(rawPart);
	const contentType = parseStructuredHeader(getHeader(headers, "content-type"));
	const disposition = parseStructuredHeader(
		getHeader(headers, "content-disposition"),
	);
	const mediaType = contentType.value || "text/plain";
	const boundary = contentType.params.boundary;
	const transferEncoding = getHeader(headers, "content-transfer-encoding");

	if (mediaType.startsWith("multipart/") && boundary) {
		for (const child of splitMultipartBody(body, boundary)) {
			parseMimePart(child, result, depth + 1);
		}
		return;
	}

	const filename =
		disposition.params.filename ??
		disposition.params["filename*"] ??
		contentType.params.name ??
		contentType.params["name*"];
	const dispositionValue = disposition.value || undefined;
	const isAttachment =
		Boolean(filename) ||
		disposition.value === "attachment" ||
		(Boolean(disposition.value) &&
			disposition.value !== "inline" &&
			!mediaType.startsWith("text/"));

	if (!isAttachment && mediaType.startsWith("text/plain") && !result.text) {
		result.text = decodePartText(body, transferEncoding).trim();
		return;
	}

	if (!isAttachment && mediaType.startsWith("text/html") && !result.html) {
		result.html = decodePartText(body, transferEncoding).trim();
		return;
	}

	if (isAttachment || !mediaType.startsWith("text/")) {
		const bytes = decodePartBytes(body, transferEncoding);
		const metadata = {
			filename,
			contentType: mediaType || undefined,
			size: bytes.byteLength,
			contentId: getHeader(headers, "content-id")?.replace(/[<>]/g, ""),
			disposition: dispositionValue,
		};
		result.attachments.push(metadata);
		result.attachmentParts.push({ ...metadata, bytes });
	}
}

export function parseInboundEmail(rawBody: string): ParsedInboundEmail {
	const result: ParsedInboundEmail = {
		text: "",
		attachments: [],
		attachmentParts: [],
	};
	parseMimePart(rawBody, result);
	if (!result.text && result.html) result.text = htmlToText(result.html);
	if (!result.text) {
		result.text = decodeEmailText(stripMessageHeaders(rawBody), {
			quotedPrintable: hasQuotedPrintableTransferEncoding(rawBody),
		}).trim();
	}
	return result;
}

function optionalNumber(value: number): number | undefined {
	return Number.isFinite(value) ? value : undefined;
}

function trimHyphens(value: string): string {
	let start = 0;
	let end = value.length;
	while (start < end && value[start] === "-") start += 1;
	while (end > start && value[end - 1] === "-") end -= 1;
	return value.slice(start, end);
}

function safeObjectSegment(value: string): string {
	return (
		trimHyphens(
			value
				.trim()
				.toLowerCase()
				.replace(/[^a-z0-9._-]+/g, "-"),
		).slice(0, 100) || "item"
	);
}

function todayPrefix(): string {
	return new Date().toISOString().slice(0, 10);
}

async function storeInboundEmailObjects(
	env: Env,
	input: {
		slug: string;
		parsed: ParsedInboundEmail;
		rawBytes: Uint8Array;
	},
): Promise<{
	rawR2Key?: string;
	htmlR2Key?: string;
	attachments: ParsedEmailAttachment[];
}> {
	const bucket = env.TEDI_STORAGE;
	if (!bucket) {
		console.warn("[Email] TEDI_STORAGE binding missing; storing metadata only");
		return { attachments: input.parsed.attachments };
	}

	const prefix = [
		"email",
		safeObjectSegment(input.slug),
		todayPrefix(),
		crypto.randomUUID(),
	].join("/");
	const rawR2Key = `${prefix}/raw.eml`;
	await bucket.put(rawR2Key, input.rawBytes, {
		httpMetadata: { contentType: "message/rfc822" },
	});

	let htmlR2Key: string | undefined;
	if (input.parsed.html) {
		htmlR2Key = `${prefix}/body.html`;
		await bucket.put(htmlR2Key, input.parsed.html, {
			httpMetadata: { contentType: "text/html; charset=utf-8" },
		});
	}

	const attachments: ParsedEmailAttachment[] = [];
	for (const [index, attachment] of input.parsed.attachmentParts.entries()) {
		const filename = attachment.filename
			? safeObjectSegment(attachment.filename)
			: `attachment-${index + 1}`;
		const r2Key = `${prefix}/attachments/${String(index + 1).padStart(3, "0")}-${filename}`;
		await bucket.put(r2Key, attachment.bytes, {
			httpMetadata: {
				contentType: attachment.contentType ?? "application/octet-stream",
			},
		});
		attachments.push({
			filename: attachment.filename,
			contentType: attachment.contentType,
			size: attachment.bytes.byteLength,
			contentId: attachment.contentId,
			disposition: attachment.disposition,
			r2Key,
		});
	}

	return { rawR2Key, htmlR2Key, attachments };
}

async function deleteInboundEmailObjects(
	env: Env,
	objects: {
		rawR2Key?: string;
		htmlR2Key?: string;
		attachments: ParsedEmailAttachment[];
	},
): Promise<void> {
	const bucket = env.TEDI_STORAGE;
	if (!bucket) return;
	const keys = [
		objects.rawR2Key,
		objects.htmlR2Key,
		...objects.attachments.map((attachment) => attachment.r2Key),
	].filter((key): key is string => Boolean(key));
	if (keys.length === 0) return;
	await bucket.delete(keys);
}

/**
 * For Agent-runtime tedis, route the email to the AgentTediDO via the SDK's
 * `routeAgentEmail()` primitive. The resolver maps `{slug}@tedix.tech →
 * { agentName: "TEDI_AGENT", agentId: <isolateAgentId|slug> }`.
 *
 * `agentName` matches the DO namespace env binding name (the SDK walks env for
 * any object exposing `idFromName`). `agentId` becomes the DO instance name
 * (`idFromName(agentId)`), which we set to the resolved tedi's
 * `isolate_agent_id` (defaults to slug). This mirrors the existing forwarding
 * path that apps/tedi-runtime's parent Worker uses for HTTP routes.
 *
 * Fail-soft: the durable mailbox row is already written by apps/api before we
 * get here, so a routing failure logs and returns rather than rejecting the
 * message (the tedi can still triage via mailbox tools).
 */
/**
 * Wrap a {@link ForwardableEmailMessage} so {@link routeAgentEmail}'s
 * internal `EmailBridge.getRaw()` can re-read the body even though we
 * already drained `message.raw` earlier in the handler (we needed the
 * bytes to MIME-parse and persist to R2 + apps/api).
 *
 * Cloudflare's `message.raw` is a single-consumer `ReadableStream` and
 * cannot be re-read. The SDK's `EmailBridge` calls `email.raw.getReader()`
 * inside `Agent._onEmail`, which throws `This ReadableStream is currently
 * locked to a reader.` when the upstream stream has already been consumed.
 *
 * The proxy delegates every field/method (from, to, setReject, forward,
 * reply) to the original message and overrides `raw`, `rawSize` and
 * `headers` with the buffered bytes stamped with the apps/api sender
 * verdict: any sender-supplied `x-tedix-inbound-trust` is stripped first, so
 * the DO reads one unforgeable value whether it uses `headers.get()` or
 * parses the MIME bytes. Reply/forward still hit the live connection.
 */
export function rawReplayableEmailMessage(
	message: ForwardableEmailMessage,
	rawBytes: Uint8Array,
	trust: InboundTrust,
): ForwardableEmailMessage {
	const stampedBytes = stampInboundTrustOnRawBytes(rawBytes, trust);
	const stampedHeaders = stampInboundTrustOnHeaders(message.headers, trust);
	// Host objects like `ForwardableEmailMessage` carry getters/methods that
	// only work when invoked with the original host object as `this`. A naive
	// Proxy with `Reflect.get(target, prop, receiver)` forwards `this = Proxy`
	// into those getters and crashes with `Illegal invocation`. Read every
	// non-`raw` property directly off the original message and re-bind methods
	// to the host object, so the SDK's downstream code (`email.headers.get`,
	// `email.setReject`, `email.forward`, `email.reply`) keeps working.
	return new Proxy(message, {
		get(target, prop) {
			if (prop === "raw") {
				return new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(stampedBytes);
						controller.close();
					},
				});
			}
			if (prop === "rawSize") return stampedBytes.byteLength;
			if (prop === "headers") return stampedHeaders;
			const value = (target as unknown as Record<string | symbol, unknown>)[
				prop as string
			];
			return typeof value === "function"
				? (value as (...args: unknown[]) => unknown).bind(target)
				: value;
		},
	});
}

async function maybeRouteToAgent(
	message: ForwardableEmailMessage,
	env: Env,
	input: { slug: string; rawBytes: Uint8Array; senderTrust: InboundTrust },
): Promise<"sdk_returned" | "no_route" | "skipped" | "failed"> {
	let route: { agentId: string } | null;
	try {
		route = await getTediEmailIngressRouteBySlug(env.DB, input.slug);
	} catch {
		console.warn("[Email] active tedi lookup failed");
		return "failed";
	}
	if (!route) return "skipped";
	if (!env.TEDI_AGENT) {
		console.warn(
			"[Email] TEDI_AGENT DO binding missing; skipping inbound hook",
		);
		return "skipped";
	}

	try {
		// The DB query resolved the live DO instance name from isolate_agent_id.
		const agentId = route.agentId;

		// Compose the resolver: secure-reply (HMAC) first when EMAIL_SECRET is
		// set, then a pinned mapping to (TEDI_AGENT, agentId).
		const secureResolver = env.EMAIL_SECRET
			? createSecureReplyEmailResolver<Env>(env.EMAIL_SECRET, {
					onInvalidSignature: () => {
						console.warn("[Email] invalid secure-reply signature");
					},
				})
			: null;

		const replayableMessage = rawReplayableEmailMessage(
			message,
			input.rawBytes,
			input.senderTrust,
		);
		let noRoute = false;
		await routeAgentEmail(replayableMessage, env as unknown as Cloudflare.Env, {
			resolver: async (email, _workerEnv) => {
				if (secureResolver) {
					const secureReply = await secureResolver(email, env);
					if (secureReply) return secureReply;
				}
				return { agentName: "TEDI_AGENT", agentId };
			},
			onNoRoute: () => {
				noRoute = true;
				console.warn("[Email] routeAgentEmail found no route");
			},
		});
		return noRoute ? "no_route" : "sdk_returned";
	} catch {
		console.warn("[Email] routeAgentEmail failed");
		return "failed";
	}
}

export async function handleInboundEmail(
	message: ForwardableEmailMessage,
	env: Env,
	_ctx: ExecutionContext,
): Promise<void> {
	const ingressStartedAt = Date.now();
	const recipient = message.to;
	const rawBuffer = await new Response(message.raw).arrayBuffer();
	const rawBytes = new Uint8Array(rawBuffer);
	const rawBody = new TextDecoder("utf-8").decode(rawBytes);
	const parsed = parseInboundEmail(rawBody);
	const getMessageHeader = createEmailHeaderReader(message.headers, rawBody);
	const subject = decodeMimeHeader(
		getMessageHeader("subject") || "(no subject)",
	);
	const from = extractEmailRecipient(getMessageHeader("from") || message.from);
	const replyTo = extractEmailRecipients(getMessageHeader("reply-to"))[0];
	const cc = extractEmailRecipients(getMessageHeader("cc"));
	const bcc = extractEmailRecipients(getMessageHeader("bcc"));
	const headerTo = extractEmailRecipients(getMessageHeader("to"))[0];
	const to = headerTo?.name
		? { email: normaliseEmail(recipient), name: headerTo.name }
		: { email: normaliseEmail(recipient) };

	// The slug names the R2 prefix and the DO route; delivery itself requires an
	// active address row in apps/api (no implicit `{slug}@tedix.tech` fallback).
	const slug = recipient.match(/^(.+)@tedix\.tech$/)?.[1];
	const authResults = parseAuthenticationResults(
		parseRawPart(rawBody).headers.get("authentication-results") ?? [],
	);
	const storedObjects = await storeInboundEmailObjects(env, {
		slug: slug ?? recipient,
		parsed,
		rawBytes,
	});

	let result:
		| {
				delivered?: boolean;
				threadId?: string;
				messageId?: string;
				senderTrust?: InboundTrust;
				ingressDecision?: "deliver" | "quarantine";
		  }
		| undefined;
	try {
		result = await callRpc(
			"tediEmail/inboundEmail",
			{
				slug,
				from,
				to,
				...(cc.length ? { cc } : {}),
				...(bcc.length ? { bcc } : {}),
				...(replyTo ? { replyTo } : {}),
				subject,
				body: parsed.text,
				attachments: storedObjects.attachments,
				rawR2Key: storedObjects.rawR2Key,
				htmlR2Key: storedObjects.htmlR2Key,
				rawSize: rawBytes.byteLength || message.rawSize,
				spamScore: optionalNumber(
					Number.parseFloat(getMessageHeader("x-cf-spamh-score") ?? ""),
				),
				...(authResults ? { authResults } : {}),
				messageId: getMessageHeader("message-id") ?? undefined,
				inReplyTo: getMessageHeader("in-reply-to") ?? undefined,
				references: parseReferences(getMessageHeader("references")),
			},
			{
				apiUrl: "http://api",
				fetch: serviceBindingFetch(env.API_SERVICE),
				headers: { "X-Service-Binding": "true" },
			},
		);
	} catch (error) {
		logInboundEmailPersistenceFailure(error);
		await deleteInboundEmailObjects(env, storedObjects);
		return;
	}
	if (result?.delivered === false) {
		await deleteInboundEmailObjects(env, storedObjects);
		message.setReject("Unknown tedi email recipient");
		return;
	}

	// apps/api `tediEmail/inboundEmail` already persisted the durable mailbox
	// row. Route the original ForwardableEmailMessage to the AgentTediDO via
	// the Agents SDK `routeAgentEmail()` primitive. The SDK uses the DO
	// namespace binding (`TEDI_AGENT`) and invokes `Agent.onEmail()` directly.
	// No /hooks/email round-trip.
	if (result?.messageId) {
		// A quarantined or machine-generated message is persisted for triage but
		// never wakes the model: tedi replies carry `Auto-Submitted`, so two
		// mailboxes cannot answer each other in a loop.
		const dispatchResult =
			slug &&
			result.threadId &&
			result.ingressDecision !== "quarantine" &&
			!isAutoSubmittedEmail(getMessageHeader)
				? await maybeRouteToAgent(message, env, {
						slug,
						rawBytes,
						senderTrust: result.senderTrust ?? "untrusted",
					})
				: "skipped";
		try {
			// Capture elapsed time before the receipt RPC so it measures inbound
			// persistence and SDK dispatch, not the observation write itself.
			await callRpc(
				"tediEmail/recordOutcome",
				{
					kind: "worker_dispatch",
					messageId: result.messageId,
					result: dispatchResult,
					elapsedMs: Math.min(
						86_400_000,
						Math.max(0, Date.now() - ingressStartedAt),
					),
				},
				{
					apiUrl: "http://api",
					fetch: serviceBindingFetch(env.API_SERVICE),
					headers: { "X-Service-Binding": "true" },
				},
			);
		} catch {
			// This is observational only. The durable mailbox already exists;
			// receipt failure must not change delivery or trigger another send.
			console.warn("[Email] dispatch outcome receipt failed");
		}
	}
}
