/**
 * Runs cron and queue work in this Worker's placed fetch path.
 *
 * Cloudflare starts cron and queue handlers in whichever data centre it picks,
 * and placement only moves fetch handlers, so that work paid a cross-ocean
 * round trip on every D1 call and wallet hold. The handler now hands its event
 * to this Worker's own fetch handler through the loopback binding
 * (`ctx.exports.default`), which smart placement runs near D1, and waits for
 * the result. The relay is recognised only by `ctx.props`, which a request
 * from the internet cannot set.
 */

export type RelayKind = "scheduled" | "queue";

type RelayProps = { tedixRelay?: RelayKind };

type LoopbackFactory = (options: { props: RelayProps }) => {
	fetch(input: string, init?: RequestInit): Promise<Response>;
};

type RelayContext = ExecutionContext & {
	props?: RelayProps;
	exports?: { default?: LoopbackFactory };
};

type ScheduledRun = (
	controller: ScheduledController,
	env: CloudflareEnv,
	ctx: ExecutionContext,
) => Promise<void>;

type QueueMessage = {
	id?: string;
	timestamp?: Date;
	attempts?: number;
	body: unknown;
	ack: () => void;
	retry: () => void;
};

type QueueRun = (
	batch: { queue: string; messages: readonly QueueMessage[] },
	env: CloudflareEnv,
	ctx: { waitUntil: (p: Promise<unknown>) => void },
) => Promise<void>;

type Outcome = "ack" | "retry" | null;

/** The relay this fetch is, when this Worker sent it to itself; otherwise undefined. */
export function relayKind(ctx: ExecutionContext): RelayKind | undefined {
	return (ctx as RelayContext).props?.tedixRelay;
}

function loopback(ctx: ExecutionContext, kind: RelayKind) {
	const factory = (ctx as RelayContext).exports?.default;
	return typeof factory === "function"
		? factory({ props: { tedixRelay: kind } })
		: undefined;
}

/** Work handed to `waitUntil` finishes before the relayed response is sent. */
function collectingContext(ctx: ExecutionContext) {
	const pending: Promise<unknown>[] = [];
	const relayCtx = {
		waitUntil: (promise: Promise<unknown>) => {
			pending.push(promise);
		},
		passThroughOnException: () => ctx.passThroughOnException(),
		props: {},
	} as unknown as ExecutionContext;
	return { relayCtx, settle: () => Promise.allSettled(pending) };
}

async function relayed(
	ctx: ExecutionContext,
	kind: RelayKind,
	body: unknown,
): Promise<Response | undefined> {
	const target = loopback(ctx, kind);
	if (!target) return undefined;
	const response = await target.fetch(`https://placed-relay.internal/${kind}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	// A failed relayed run fails this invocation, as a local failure would; it
	// is never run a second time here.
	if (!response.ok)
		throw new Error(
			`Relayed ${kind} failed (${response.status}): ${(await response.text()).slice(0, 500)}`,
		);
	return response;
}

/** Run a cron event in the placed fetch path, or here when no loopback exists. */
export async function runScheduledPlaced(
	controller: ScheduledController,
	env: CloudflareEnv,
	ctx: ExecutionContext,
	run: ScheduledRun,
): Promise<void> {
	const response = await relayed(ctx, "scheduled", {
		cron: controller.cron,
		scheduledTime: controller.scheduledTime,
	});
	if (!response) await run(controller, env, ctx);
}

/**
 * Run a queue batch in the placed fetch path, then settle each real message
 * with the outcome the relayed consumer chose. A message it left unsettled
 * stays unsettled, so the platform acks it when this handler returns.
 */
export async function runQueuePlaced(
	batch: { queue: string; messages: readonly QueueMessage[] },
	env: CloudflareEnv,
	ctx: ExecutionContext,
	run: QueueRun,
): Promise<void> {
	const response = await relayed(ctx, "queue", {
		queue: batch.queue,
		messages: batch.messages.map((message) => ({
			id: message.id,
			attempts: message.attempts,
			timestamp: message.timestamp?.toISOString(),
			body: message.body,
		})),
	});
	if (!response) {
		await run(batch, env, ctx);
		return;
	}
	const { outcomes } = (await response.json()) as { outcomes: Outcome[] };
	batch.messages.forEach((message, index) => {
		if (outcomes[index] === "ack") message.ack();
		else if (outcomes[index] === "retry") message.retry();
	});
}

/** The fetch side: rebuild the event, run it here, and report the outcome. */
export async function serveRelay(
	kind: RelayKind,
	request: Request,
	env: CloudflareEnv,
	ctx: ExecutionContext,
	handlers: { scheduled: ScheduledRun; queue: QueueRun },
): Promise<Response> {
	const { relayCtx, settle } = collectingContext(ctx);
	try {
		if (kind === "scheduled") {
			const event = (await request.json()) as {
				cron: string;
				scheduledTime: number;
			};
			const controller = {
				cron: event.cron,
				scheduledTime: event.scheduledTime,
				type: "scheduled",
				noRetry: () => {},
			} as ScheduledController;
			await handlers.scheduled(controller, env, relayCtx);
			await settle();
			return new Response(null, { status: 204 });
		}
		const batch = (await request.json()) as {
			queue: string;
			messages: {
				id?: string;
				attempts?: number;
				timestamp?: string;
				body: unknown;
			}[];
		};
		const outcomes: Outcome[] = batch.messages.map(() => null);
		const messages = batch.messages.map((message, index) => ({
			id: message.id,
			attempts: message.attempts,
			timestamp: message.timestamp ? new Date(message.timestamp) : undefined,
			body: message.body,
			ack: () => {
				outcomes[index] = "ack";
			},
			retry: () => {
				outcomes[index] = "retry";
			},
		}));
		await handlers.queue({ queue: batch.queue, messages }, env, relayCtx);
		await settle();
		return Response.json({ outcomes });
	} catch (error) {
		await settle();
		return new Response(
			error instanceof Error ? error.message : String(error),
			{ status: 500 },
		);
	}
}
