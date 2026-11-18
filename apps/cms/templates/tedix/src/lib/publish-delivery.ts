import type { StorageCollection } from "emdash";
import type {
	ContentPublishStateChangeEvent,
	PluginContext,
} from "emdash/plugin";

export const DELIVERY_TASK = "publish-deliveries";
const TERMINAL = Number.MAX_SAFE_INTEGER;
const LEASE_MS = 120_000;
export const DELIVERY_BATCH_SIZE = 5;
export type Publication = {
	site: string;
	collection: string;
	entry: string;
	locale: string | null;
	revision: string;
};
export type DeliveryJob = Publication & {
	recipient: string;
	payload: Record<string, unknown>;
	status: "pending" | "processing" | "failed" | "sent" | "skipped";
	attempts: number;
	due: number;
	receipt?: Record<string, unknown>;
	error?: string;
};
export type DeliveryContext = PluginContext<{
	deliveries: { indexes: string[] };
}>;
export type DeliveryResult = {
	receipt?: Record<string, unknown>;
	skipped?: boolean;
	continuation?: Record<string, unknown>;
};
const store = (ctx: PluginContext) =>
	(ctx as DeliveryContext).storage.deliveries as StorageCollection<DeliveryJob>;

export function publication(
	event: ContentPublishStateChangeEvent,
	ctx: PluginContext,
): Publication {
	const entry = event.content;
	if (
		typeof entry.id !== "string" ||
		typeof entry.liveRevisionId !== "string" ||
		!entry.liveRevisionId ||
		!ctx.site.url
	)
		throw new Error("Published entry identity and live revision are required");
	return {
		site: ctx.site.url,
		collection: event.collection,
		entry: entry.id,
		locale: typeof entry.locale === "string" ? entry.locale : null,
		revision: entry.liveRevisionId,
	};
}

export async function deliveryId(
	source: Publication,
	recipient: string,
): Promise<string> {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			JSON.stringify([
				source.site,
				source.collection,
				source.entry,
				source.locale,
				source.revision,
				recipient,
			]),
		),
	);
	return Array.from(new Uint8Array(bytes), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

export async function ensureDeliverySchedule(
	ctx: PluginContext,
): Promise<void> {
	if (!ctx.cron) throw new Error("Delivery scheduler unavailable");
	if (!(await ctx.cron.list()).some((task) => task.name === DELIVERY_TASK))
		await ctx.cron.schedule(DELIVERY_TASK, { schedule: "* * * * *" });
}

export async function enqueueDelivery(
	ctx: PluginContext,
	source: Publication,
	recipient: string,
	payload: Record<string, unknown>,
): Promise<void> {
	const id = await deliveryId(source, recipient);
	await store(ctx).compareAndSet(id, null, {
		site: source.site,
		collection: source.collection,
		entry: source.entry,
		locale: source.locale,
		revision: source.revision,
		recipient,
		payload,
		status: "pending",
		attempts: 0,
		due: Date.now(),
	});
}

/** Native storage CAS fences overlap and stale workers; the scheduler recovers expired leases. */
export async function processDeliveries(
	ctx: PluginContext,
	deliver: (job: DeliveryJob) => Promise<DeliveryResult>,
	now = Date.now(),
): Promise<void> {
	const jobs = store(ctx);
	const page = await jobs.query({
		where: { due: { lte: now } },
		orderBy: { due: "asc" },
		limit: DELIVERY_BATCH_SIZE,
	});
	for (const item of page.items) {
		const current = await jobs.getVersioned(item.id);
		if (
			!current ||
			current.value.due > now ||
			["sent", "skipped"].includes(current.value.status)
		)
			continue;
		const job = {
			...current.value,
			status: "processing" as const,
			attempts: current.value.attempts + 1,
			due: now + LEASE_MS,
		};
		const claim = await jobs.compareAndSet(item.id, current.revision, job);
		if (!claim.applied) continue;
		let next: DeliveryJob;
		try {
			const result = await deliver(job);
			next = result.continuation
				? {
						...job,
						payload: result.continuation,
						status: "pending",
						attempts: 0,
						due: Date.now(),
						error: undefined,
					}
				: {
						...job,
						status: result.skipped ? "skipped" : "sent",
						due: TERMINAL,
						receipt: {
							...result.receipt,
							recordedAt: new Date().toISOString(),
						},
						error: undefined,
					};
		} catch {
			// Provider errors can contain credentials or recipient data. Keep a safe reason in admin receipts.
			next = {
				...job,
				status: "failed",
				error: "Delivery failed; check configuration and retry.",
				due:
					job.attempts >= 8
						? TERMINAL
						: Date.now() +
							Math.min(3_600_000, 60_000 * 2 ** (job.attempts - 1)),
			};
		}
		await jobs.compareAndSet(item.id, claim.revision, next);
	}
}

export const deliveryRoutes = {
	"deliveries/status": {
		methods: ["GET" as const],
		permission: "plugins:manage" as const,
		response: "raw" as const,
		cacheControl: "no-store",
		handler: async (route: { input?: unknown }, ctx: PluginContext) => {
			const jobs = store(ctx);
			const input = route.input as
				| { cursor?: unknown; status?: unknown }
				| undefined;
			const cursor =
				typeof input?.cursor === "string" ? input.cursor : undefined;
			const status =
				typeof input?.status === "string" &&
				["pending", "failed", "sent", "skipped", "processing"].includes(
					input.status,
				)
					? input.status
					: undefined;
			const [pending, processing, failed, sent, skipped, page] =
				await Promise.all([
					jobs.count({ status: "pending" }),
					jobs.count({ status: "processing" }),
					jobs.count({ status: "failed" }),
					jobs.count({ status: "sent" }),
					jobs.count({ status: "skipped" }),
					jobs.query({
						where: status ? { status } : undefined,
						orderBy: { due: "asc" },
						limit: 25,
						cursor,
					}),
				]);
			return Response.json(
				{
					pending: pending + processing,
					cursor: page.cursor,
					hasMore: page.hasMore,
					failed,
					sent,
					skipped,
					receipts: page.items.map(({ id, data }) => ({
						id,
						collection: data.collection,
						entry: data.entry,
						revision: data.revision,
						recipient: data.recipient,
						status: data.status,
						attempts: data.attempts,
						nextAttemptAt:
							data.due === TERMINAL ? null : new Date(data.due).toISOString(),
						receipt: data.receipt,
						error: data.error,
					})),
				},
				{ headers: { "Cache-Control": "no-store" } },
			);
		},
	},
	"deliveries/retry": {
		methods: ["POST" as const],
		permission: "plugins:manage" as const,
		response: "raw" as const,
		handler: async (route: { input?: unknown }, ctx: PluginContext) => {
			const id = (route.input as { id?: unknown } | undefined)?.id;
			if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
				return Response.json(
					{ error: "Delivery id required" },
					{ status: 400 },
				);
			await ensureDeliverySchedule(ctx);
			const current = await store(ctx).getVersioned(id);
			if (!current)
				return Response.json({ error: "Delivery not found" }, { status: 404 });
			if (current.value.status !== "failed")
				return Response.json(
					{ error: "Only failed deliveries can be retried" },
					{ status: 409 },
				);
			const result = await store(ctx).compareAndSet(id, current.revision, {
				...current.value,
				status: "pending",
				attempts: 0,
				due: Date.now(),
				error: undefined,
			});
			return Response.json(
				{ queued: result.applied },
				{ status: result.applied ? 200 : 409 },
			);
		},
	},
};
