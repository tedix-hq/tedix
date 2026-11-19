/**
 * emdash-newsletter — double-opt-in newsletter plugin.
 *
 * Subscription routes (public) — emdash plugin routes use plain slugs as keys:
 *   POST /_emdash/api/plugins/emdash-newsletter/subscribe   — { email, source? }
 *   GET  /_emdash/api/plugins/emdash-newsletter/confirm?token=TOKEN
 *   GET  /_emdash/api/plugins/emdash-newsletter/unsubscribe?token=TOKEN
 *
 * Hook:
 *   content:afterPublish queues a digest; the native scheduler expands and sends it.
 *
 * Outbound email goes via the platform endpoint
 *   POST {PLATFORM_API_URL}/rpc/tediEmail/sendEmail
 * which sends through the platform Cloudflare Email Service binding.
 *
 * Settings (in Emdash settings KV):
 *   newsletter.platformApiKey   — REQUIRED Bearer token (sk_…)
 *   newsletter.platformApiUrl   — override platform API base
 *   newsletter.orgSlug          — overrides env.ORG_SLUG
 *   newsletter.disabled         — kill switch
 *   newsletter.digestCollections- default ["posts"]
 *   newsletter.digestPageSize   — default 25
 */

import { env as cfEnv } from "cloudflare:workers";
import { getCollectionInfo } from "emdash";
import type {
	ContentPublishStateChangeEvent,
	PluginContext,
	SandboxedPlugin,
} from "emdash/plugin";
import { callPlatformRpc } from "../../lib/platform-rpc";
import {
	DELIVERY_TASK,
	deliveryRoutes,
	ensureDeliverySchedule,
	enqueueDelivery,
	publication,
	processDeliveries,
	type DeliveryJob,
	type DeliveryResult,
} from "../../lib/publish-delivery";

type NewsletterContext = PluginContext<{
	subscribers: { indexes: string[] };
	deliveries: { indexes: string[] };
}>;
type Subscriber = Record<string, unknown> & {
	email?: string;
	status?: string;
	confirmToken?: string | null;
	unsubscribeToken?: string;
	source?: string | null;
};
type Brand = {
	siteName: string;
	siteUrl: string;
	slug: string;
	logo: string | null;
};
type EmailArgs = { to: string; subject: string; text: string; html: string };
type SendResult = {
	ok: boolean;
	error?: string;
	messageId?: string;
	provider?: string;
};

const workerEnv = (cfEnv ?? {}) as unknown as Record<
	string,
	string | undefined
>;

const DEFAULT_API_URL = "https://api.tedix.dev";
const DEFAULT_COLLECTIONS = ["posts"];
const DEFAULT_PAGE_SIZE = 25;

// ── tokens / validation ──────────────────────────────────────────────

const HEX = "0123456789abcdef";
function bytesToHex(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i] ?? 0;
		out += HEX[(b >> 4) & 0xf];
		out += HEX[b & 0xf];
	}
	return out;
}
function randomToken(byteLength = 24): string {
	const buf = new Uint8Array(byteLength);
	crypto.getRandomValues(buf);
	return bytesToHex(buf);
}
function subscriberId(): string {
	return `sub_${randomToken(12)}`;
}
function isLikelyEmail(email: unknown): email is string {
	if (typeof email !== "string") return false;
	const t = email.trim();
	if (t.length < 3 || t.length > 254) return false;
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
}

// ── settings + email helpers ─────────────────────────────────────────

/**
 * Trusted starters store prefixed keys (`newsletter.platformApiKey`); the
 * marketplace descriptor declares unprefixed ones (`platformApiKey`).
 */
async function readSetting(
	ctx: NewsletterContext,
	key: string,
): Promise<unknown> {
	for (const candidate of [key, key.slice(key.indexOf(".") + 1)]) {
		try {
			const value = await ctx.kv.get(`settings:${candidate}`);
			if (value !== undefined && value !== null) return value;
		} catch {
			/* fall through */
		}
	}
	return undefined;
}

function collectionList(value: unknown): string[] {
	if (Array.isArray(value))
		return value.filter((item): item is string => typeof item === "string");
	if (typeof value !== "string") return DEFAULT_COLLECTIONS;
	const collections = value
		.split(/[,\n]/)
		.map((item) => item.trim())
		.filter(Boolean);
	return collections.length > 0 ? collections : DEFAULT_COLLECTIONS;
}

function brandFromEnv(ctx: NewsletterContext): Brand {
	const e = workerEnv;
	const slug = e.ORG_SLUG ?? "tedix";
	const siteName = ctx?.site?.name ?? e.SITE_TITLE ?? "Tedix";
	const siteUrl = ctx?.site?.url ?? `https://${slug}.cms.tedix.dev`;
	let logo: string | null = null;
	try {
		const branding = e.PLATFORM_BRANDING
			? JSON.parse(e.PLATFORM_BRANDING)
			: null;
		logo = branding?.logo ?? branding?.images?.logo ?? null;
	} catch {}
	return { siteName, siteUrl, slug, logo };
}

async function contentUrl(
	ctx: NewsletterContext,
	collection: string,
	slug: string,
): Promise<string> {
	const safeSlug = encodeURIComponent(slug);
	try {
		const info = await getCollectionInfo(collection);
		const pattern = info?.urlPattern?.trim();
		if (pattern) {
			const path = pattern
				.replaceAll("{slug}", safeSlug)
				.replaceAll("{id}", safeSlug);
			return ctx.url(path.startsWith("/") ? path : `/${path}`);
		}
	} catch {
		// Keep newsletter delivery best-effort; content links fall back below.
	}
	return ctx.url(`/${collection}/${safeSlug}/`);
}

// Local copy: this template ships to tenant sites, which cannot import
// workspace packages such as @tedix/chat-transport.
function escapeHtml(s: unknown): string {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function shellHtml(brand: Brand, body: string): string {
	const logoTag = brand.logo
		? `<img src="${escapeHtml(brand.logo)}" alt="${escapeHtml(brand.siteName)}" style="max-height:48px;height:auto;display:block;margin:0 auto 24px"/>`
		: "";
	return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f7f7f8;margin:0;padding:24px;color:#111;">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
${logoTag}
${body}
<hr style="border:none;border-top:1px solid #eee;margin:32px 0"/>
<p style="font-size:12px;color:#888;text-align:center">Sent by <a href="${escapeHtml(brand.siteUrl)}" style="color:#888">${escapeHtml(brand.siteName)}</a></p>
</div></body></html>`;
}

function renderConfirmation(brand: Brand, confirmUrl: string) {
	const subject = `Confirm your subscription to ${brand.siteName}`;
	const text = `Confirm your subscription to ${brand.siteName} by clicking:\n\n${confirmUrl}\n\nIf you didn't request this, ignore this email.`;
	const html = shellHtml(
		brand,
		`<h1 style="font-size:20px;margin:0 0 16px">Confirm your subscription</h1>
<p>Click the button below to confirm your subscription to <strong>${escapeHtml(brand.siteName)}</strong>.</p>
<p style="text-align:center;margin:24px 0"><a href="${escapeHtml(confirmUrl)}" style="background:#111;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;display:inline-block;font-weight:600">Confirm subscription</a></p>
<p style="font-size:13px;color:#666">If the button doesn't work, paste this URL:<br/>${escapeHtml(confirmUrl)}</p>`,
	);
	return { subject, text, html };
}

function renderDigest(
	brand: Brand,
	title: string,
	excerpt: string,
	postUrl: string,
	unsubscribeUrl: string,
) {
	const subject = `New on ${brand.siteName}: ${title}`;
	const text = `${title}\n\n${excerpt}\n\nRead more: ${postUrl}\n\n—\nUnsubscribe: ${unsubscribeUrl}`;
	const html = shellHtml(
		brand,
		`<h1 style="font-size:22px;margin:0 0 8px">${escapeHtml(title)}</h1>
${excerpt ? `<p style="color:#444;line-height:1.6">${escapeHtml(excerpt)}</p>` : ""}
<p style="text-align:center;margin:24px 0"><a href="${escapeHtml(postUrl)}" style="background:#111;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;display:inline-block;font-weight:600">Read on ${escapeHtml(brand.siteName)}</a></p>
<p style="font-size:12px;color:#888;text-align:center"><a href="${escapeHtml(unsubscribeUrl)}" style="color:#888">Unsubscribe</a></p>`,
	);
	return { subject, text, html };
}

function htmlPage(message: string, ok = true, status = 200): Response {
	const color = ok ? "#0a7a3a" : "#a32a2a";
	return new Response(
		`<!doctype html><html><body style="font-family:-apple-system,sans-serif;background:#f7f7f8;margin:0;padding:80px 24px;text-align:center"><div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:40px"><h1 style="color:${color};margin:0 0 16px">${escapeHtml(message)}</h1></div></body></html>`,
		{ status, headers: { "content-type": "text/html; charset=utf-8" } },
	);
}

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function sendPlatformEmail(
	ctx: NewsletterContext,
	args: EmailArgs,
): Promise<SendResult> {
	const e = workerEnv;
	const apiKey =
		(await readSetting(ctx, "newsletter.platformApiKey")) ??
		(await readSetting(ctx, "tedi.platformApiKey")) ??
		e.PLATFORM_API_KEY;
	if (!apiKey || typeof apiKey !== "string") {
		ctx.log?.warn?.(
			"[newsletter] newsletter.platformApiKey not set — skipping send (subscriber still stored)",
		);
		return { ok: false, error: "platformApiKey missing" };
	}
	const apiUrl = (
		(await readSetting(ctx, "newsletter.platformApiUrl")) ??
		(await readSetting(ctx, "tedi.platformApiUrl")) ??
		e.PLATFORM_API_URL ??
		DEFAULT_API_URL
	)
		.toString()
		.replace(/\/+$/, "");
	const appSlug =
		((await readSetting(ctx, "newsletter.orgSlug")) ?? e.ORG_SLUG) || "tedix";

	const input = {
		appSlug,
		to: [normalizeRecipient(args.to)],
		subject: args.subject,
		...(args.text ? { text: args.text } : {}),
		...(args.html ? { html: args.html } : {}),
	};
	if (!ctx.http) {
		ctx.log?.warn?.("[newsletter] HTTP capability unavailable");
		return { ok: false, error: "HTTP capability unavailable" };
	}
	const capabilityFetch = ctx.http.fetch.bind(ctx.http);
	const platformFetch = (url: string, init?: RequestInit) =>
		capabilityFetch(url, { ...init, signal: AbortSignal.timeout(8_000) });
	try {
		const out = await callPlatformRpc<{
			ok?: boolean;
			messageId?: string;
			provider?: string;
		}>(apiUrl, ["tediEmail", "sendEmail"], input, apiKey, platformFetch);
		if (out.ok !== true) return { ok: false, error: "send failed" };
		return { ok: true, messageId: out.messageId, provider: out.provider };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		ctx.log?.warn?.(`[newsletter] tediEmail.sendEmail threw: ${msg}`);
		return { ok: false, error: msg };
	}
}

function normalizeRecipient(value: string) {
	return { email: value.trim().toLowerCase() };
}

function pickStr(
	obj: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	if (!obj) return undefined;
	const v = obj[key];
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
	const n =
		typeof v === "number"
			? Math.floor(v)
			: Number.parseInt(String(v ?? ""), 10);
	if (!Number.isFinite(n)) return dflt;
	return Math.min(max, Math.max(min, n));
}

/** A fan-out job checkpoints one subscriber page; child keys make page replay safe. */
async function deliverNewsletter(
	ctx: NewsletterContext,
	job: DeliveryJob,
): Promise<DeliveryResult> {
	if (job.payload.kind === "fanout") {
		const pageSize = clampInt(
			await readSetting(ctx, "newsletter.digestPageSize"),
			1,
			25,
			DEFAULT_PAGE_SIZE,
		);
		const cursor =
			typeof job.payload.cursor === "string" ? job.payload.cursor : undefined;
		const page = await ctx.storage.subscribers.query({
			where: { status: "active" },
			limit: pageSize,
			cursor,
		});
		for (const item of page.items) {
			const sub = item.data as Subscriber;
			if (!sub.email || !sub.unsubscribeToken) continue;
			const to = sub.email.trim().toLowerCase();
			const unsubscribeUrl = ctx.url(
				`/_emdash/api/plugins/emdash-newsletter/unsubscribe?token=${sub.unsubscribeToken}`,
			);
			const tpl = renderDigest(
				job.payload.brand as Brand,
				String(job.payload.title),
				String(job.payload.excerpt),
				String(job.payload.postUrl),
				unsubscribeUrl,
			);
			await enqueueDelivery(ctx, job, to, {
				kind: "email",
				subscriberId: item.id,
				to,
				...tpl,
			});
		}
		if (page.hasMore) {
			if (!page.cursor || page.cursor === cursor)
				throw new Error("Subscriber cursor did not advance");
			return { continuation: { ...job.payload, cursor: page.cursor } };
		}
		return { receipt: { expanded: true } };
	}
	const sub = (await ctx.storage.subscribers.get(
		String(job.payload.subscriberId),
	)) as Subscriber | null;
	if (
		!sub ||
		sub.status !== "active" ||
		sub.email?.trim().toLowerCase() !== job.recipient
	)
		return {
			skipped: true,
			receipt: { reason: "Subscriber no longer active" },
		};
	const result = await sendPlatformEmail(ctx, job.payload as EmailArgs);
	if (!result.ok) throw new Error("Newsletter delivery failed");
	return {
		receipt: {
			acknowledged: true,
			...(result.messageId ? { messageId: result.messageId } : {}),
			...(result.provider ? { provider: result.provider } : {}),
		},
	};
}

// ── plugin definition ────────────────────────────────────────────────

export default {
	routes: {
		...deliveryRoutes,
		// POST /_emdash/api/plugins/emdash-newsletter/subscribe
		subscribe: {
			public: true,
			handler: async (routeCtx, pluginCtx) => {
				const ctx = pluginCtx as NewsletterContext;
				// Emdash parses the body into `input`; the request body is already read.
				const body =
					routeCtx.input && typeof routeCtx.input === "object"
						? (routeCtx.input as Record<string, unknown>)
						: {};
				const email = String(body.email ?? "")
					.trim()
					.toLowerCase();
				if (!isLikelyEmail(email)) {
					return jsonResponse(
						{ ok: false, error: "Invalid email address" },
						400,
					);
				}
				const source =
					typeof body.source === "string" ? body.source.slice(0, 200) : null;
				const subscribers = ctx.storage.subscribers;
				const existing = await subscribers.query({
					where: { email },
					limit: 1,
				});
				const item = existing.items[0];

				let record: Subscriber;
				if (item) {
					const data = item.data as Subscriber;
					if (data.status === "active") {
						return jsonResponse({ ok: true, alreadySubscribed: true });
					}
					const confirmToken = randomToken(24);
					record = {
						...data,
						email,
						status: "pending",
						confirmToken,
						unsubscribeToken: data.unsubscribeToken ?? randomToken(24),
						source: source ?? data.source ?? null,
						confirmedAt: null,
						unsubscribedAt: null,
					};
					await subscribers.put(item.id, record);
				} else {
					const id = subscriberId();
					record = {
						email,
						status: "pending",
						confirmToken: randomToken(24),
						unsubscribeToken: randomToken(24),
						createdAt: new Date().toISOString(),
						confirmedAt: null,
						unsubscribedAt: null,
						source,
					};
					await subscribers.put(id, record);
					record = { id, ...record };
				}

				// Token passed as query param — emdash plugin routes use plain slugs,
				// dynamic path segments aren't supported.
				const confirmUrl = ctx.url(
					`/_emdash/api/plugins/emdash-newsletter/confirm?token=${String(record.confirmToken ?? "")}`,
				);
				const brand = brandFromEnv(ctx);
				const tpl = renderConfirmation(brand, confirmUrl);
				await sendPlatformEmail(ctx, {
					to: email,
					subject: tpl.subject,
					text: tpl.text,
					html: tpl.html,
				});
				return jsonResponse({ ok: true, pending: true });
			},
		},
		// GET /_emdash/api/plugins/emdash-newsletter/confirm?token=TOKEN
		confirm: {
			public: true,
			handler: async (routeCtx, pluginCtx) => {
				const ctx = pluginCtx as NewsletterContext;
				const url = new URL(routeCtx.request.url);
				const token = url.searchParams.get("token") ?? "";
				if (!token || token.length < 8) {
					return htmlPage("Invalid link", false, 400);
				}
				const subscribers = ctx.storage.subscribers;
				const found = await subscribers.query({
					where: { confirmToken: token },
					limit: 1,
				});
				const item = found.items[0];
				if (!item) return htmlPage("Link expired or already used", false, 404);
				const data = item.data as Subscriber;
				await subscribers.put(item.id, {
					...data,
					status: "active",
					confirmToken: null,
					confirmedAt: new Date().toISOString(),
				});
				return htmlPage("Subscription confirmed — thanks!");
			},
		},
		// GET /_emdash/api/plugins/emdash-newsletter/unsubscribe?token=TOKEN
		unsubscribe: {
			public: true,
			handler: async (routeCtx, pluginCtx) => {
				const ctx = pluginCtx as NewsletterContext;
				const url = new URL(routeCtx.request.url);
				const token = url.searchParams.get("token") ?? "";
				if (!token || token.length < 8) {
					return htmlPage("Invalid unsubscribe link", false, 400);
				}
				const subscribers = ctx.storage.subscribers;
				const found = await subscribers.query({
					where: { unsubscribeToken: token },
					limit: 1,
				});
				const item = found.items[0];
				if (!item) return htmlPage("Link not recognised", false, 404);
				const data = item.data as Subscriber;
				await subscribers.put(item.id, {
					...data,
					status: "unsubscribed",
					unsubscribedAt: new Date().toISOString(),
				});
				return htmlPage("You've been unsubscribed.");
			},
		},
	},
	hooks: {
		cron: {
			timeout: 60_000,
			handler: async (event, pluginCtx) => {
				if (event.name !== DELIVERY_TASK) return;
				const ctx = pluginCtx as NewsletterContext;
				const disabled = await readSetting(ctx, "newsletter.disabled");
				if (disabled === true || disabled === "true") return;
				await processDeliveries(ctx, (job) => deliverNewsletter(ctx, job));
			},
		},
		"content:afterPublish": {
			errorPolicy: "continue",
			handler: async (
				event: ContentPublishStateChangeEvent,
				pluginCtx: PluginContext,
			) => {
				const ctx = pluginCtx as NewsletterContext;
				try {
					const disabled = await readSetting(ctx, "newsletter.disabled");
					if (disabled === true || disabled === "true") return;

					const collections = collectionList(
						await readSetting(ctx, "newsletter.digestCollections"),
					);
					if (!collections.includes(event.collection)) return;

					// Emdash passes the published content item as `event.content`.
					const entry = event.content as {
						id: string;
						slug?: string | null;
						data?: Record<string, unknown>;
					};
					const data = entry.data ?? {};
					const title = pickStr(data, "title") ?? entry.slug ?? entry.id;
					const excerpt =
						pickStr(data, "excerpt") ??
						pickStr(data, "description") ??
						pickStr(data, "summary") ??
						"";
					const slug = entry.slug ?? entry.id;
					const brand = brandFromEnv(ctx);
					const postUrl = await contentUrl(ctx, event.collection, slug);

					await ensureDeliverySchedule(ctx);
					await enqueueDelivery(
						ctx,
						publication(event, ctx),
						"newsletter:fanout",
						{ kind: "fanout", brand, title, excerpt, postUrl },
					);
				} catch {
					ctx.log?.warn?.("[newsletter] delivery enqueue failed");
				}
			},
		},
	},
} satisfies SandboxedPlugin;
