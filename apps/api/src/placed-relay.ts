/**
 * Runs cron and queue work in this Worker's placed fetch path.
 *
 * Cloudflare starts cron and queue handlers in whichever data centre it picks,
 * and placement moves neither them nor a loopback call to this Worker's own
 * fetch handler (measured 24 Nov: relayed work stayed in San Jose, Seattle,
 * Atlanta), so that work paid a cross-ocean round trip on every D1 call and
 * wallet hold. The handler now hands its event to a fresh `PlacedJobRunner`
 * Durable Object created near D1 (location hint `weur`) and waits for the
 * result. Only this Worker can reach that object.
 */

import {
	durableObjectNamespace,
	durableObjectNewUniqueId,
} from "@tedix/worker-kit/durable-objects";

export type RelayKind = "scheduled" | "queue";

/** Where the job runner objects are created: Western Europe, near D1. */
export const PLACED_JOB_LOCATION: DurableObjectLocationHint = "weur";

type RelayContext = ExecutionContext & {
	exports?: { PlacedJobRunner?: DurableObjectNamespace };
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

/** A fresh runner near D1 for one cron run or queue batch; none without the binding. */
function runner(ctx: ExecutionContext, env: CloudflareEnv) {
	const namespace = (ctx as RelayContext).exports?.PlacedJobRunner;
	if (!namespace) return undefined;
	// The jurisdiction helper keeps env.DO_JURISDICTION authoritative.
	const scoped = durableObjectNamespace(namespace, env);
	return scoped.get(durableObjectNewUniqueId(namespace, env), {
		locationHint: PLACED_JOB_LOCATION,
	});
}

/** The job a runner request asks for, from its path. */
export function jobKind(request: Request): RelayKind | undefined {
	const path = new URL(request.url).pathname.slice(1);
	return path === "scheduled" || path === "queue" ? path : undefined;
}

/** Work handed to `waitUntil` finishes before the relayed response is sent. */
function collectingContext() {
	const pending: Promise<unknown>[] = [];
	const relayCtx = {
		waitUntil: (promise: Promise<unknown>) => {
			pending.push(promise);
		},
		passThroughOnException: () => {},
		props: {},
	} as unknown as ExecutionContext;
	return { relayCtx, settle: () => Promise.allSettled(pending) };
}

async function relayed(
	ctx: ExecutionContext,
	env: CloudflareEnv,
	kind: RelayKind,
	body: unknown,
): Promise<Response | undefined> {
	const target = runner(ctx, env);
	if (!target) return undefined;
	const response = await target.fetch(
		`https://placed-job-runner.internal/${kind}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	// A failed relayed run fails this invocation, as a local failure would; it
	// is never run a second time here.
	if (!response.ok)
		throw new Error(
			`Relayed ${kind} failed (${response.status}): ${(await response.text()).slice(0, 500)}`,
		);
	return response;
}

/** Run a cron event in a runner near D1, or here when there is no runner binding. */
export async function runScheduledPlaced(
	controller: ScheduledController,
	env: CloudflareEnv,
	ctx: ExecutionContext,
	run: ScheduledRun,
): Promise<void> {
	const response = await relayed(ctx, env, "scheduled", {
		cron: controller.cron,
		scheduledTime: controller.scheduledTime,
	});
	if (!response) await run(controller, env, ctx);
}

/**
 * Run a queue batch in a runner near D1, then settle each real message
 * with the outcome the relayed consumer chose. A message it left unsettled
 * stays unsettled, so the platform acks it when this handler returns.
 */
export async function runQueuePlaced(
	batch: { queue: string; messages: readonly QueueMessage[] },
	env: CloudflareEnv,
	ctx: ExecutionContext,
	run: QueueRun,
): Promise<void> {
	const response = await relayed(ctx, env, "queue", {
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

/** The runner side: rebuild the event, run it here, and report the outcome. */
export async function serveRelay(
	kind: RelayKind,
	request: Request,
	env: CloudflareEnv,
	handlers: { scheduled: ScheduledRun; queue: QueueRun },
): Promise<Response> {
	const { relayCtx, settle } = collectingContext();
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
