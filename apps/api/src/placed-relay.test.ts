import { describe, expect, it } from "vite-plus/test";
import {
	PLACED_JOB_LOCATION,
	jobKind,
	runQueuePlaced,
	runScheduledPlaced,
	serveRelay,
} from "./placed-relay";

const env = {} as CloudflareEnv;
const plainCtx = () =>
	({
		waitUntil: () => {},
		passThroughOnException: () => {},
	}) as unknown as ExecutionContext;

/** A context whose runner namespace serves jobs in-process, as the object would. */
function loopbackCtx(
	handlers: Parameters<typeof serveRelay>[3],
	hints: string[] = [],
) {
	return {
		...plainCtx(),
		exports: {
			PlacedJobRunner: {
				newUniqueId: () => ({}),
				get: (_id: unknown, options: { locationHint: string }) => {
					hints.push(options.locationHint);
					return {
						fetch: (url: string, init?: RequestInit) => {
							const request = new Request(url, init);
							return serveRelay(jobKind(request)!, request, env, handlers);
						},
					};
				},
			},
		},
	} as unknown as ExecutionContext;
}

describe("placed relay", () => {
	it("routes only known job paths", () => {
		expect(jobKind(new Request("https://runner/scheduled"))).toBe("scheduled");
		expect(jobKind(new Request("https://runner/queue"))).toBe("queue");
		expect(jobKind(new Request("https://runner/other"))).toBeUndefined();
	});

	it("settles each real queue message with the relayed consumer's outcome", async () => {
		const settled: string[] = [];
		const message = (id: string, body: unknown) => ({
			id,
			body,
			ack: () => settled.push(`${id}:ack`),
			retry: () => settled.push(`${id}:retry`),
		});
		await runQueuePlaced(
			{
				queue: "tedix-automation-events",
				messages: [
					message("a", { n: 1 }),
					message("b", { n: 2 }),
					message("c", 3),
				],
			},
			env,
			loopbackCtx({
				scheduled: async () => {},
				queue: async (batch) => {
					expect(batch.messages.map((m) => m.body)).toEqual([
						{ n: 1 },
						{ n: 2 },
						3,
					]);
					batch.messages[0]!.ack();
					batch.messages[1]!.retry();
					// The third is left unsettled: the platform acks it on return.
				},
			}),
			async () => {
				throw new Error("ran locally");
			},
		);
		expect(settled).toEqual(["a:ack", "b:retry"]);
	});

	it("finishes waitUntil work before a relayed cron returns, and fails without a local rerun", async () => {
		let background = false;
		let locally = 0;
		const hints: string[] = [];
		await runScheduledPlaced(
			{ cron: "*/2 * * * *", scheduledTime: 1 } as ScheduledController,
			env,
			loopbackCtx(
				{
					scheduled: async (controller, _env, ctx) => {
						expect(controller.cron).toBe("*/2 * * * *");
						ctx.waitUntil(
							new Promise<void>((resolve) =>
								setTimeout(() => {
									background = true;
									resolve();
								}, 5),
							),
						);
					},
					queue: async () => {},
				},
				hints,
			),
			async () => {
				locally++;
			},
		);
		expect(background).toBe(true);
		expect(hints).toEqual([PLACED_JOB_LOCATION]);
		await expect(
			runScheduledPlaced(
				{ cron: "0 * * * *", scheduledTime: 2 } as ScheduledController,
				env,
				loopbackCtx({
					scheduled: async () => {
						throw new Error("job failed");
					},
					queue: async () => {},
				}),
				async () => {
					locally++;
				},
			),
		).rejects.toThrow("Relayed scheduled failed (500): job failed");
		expect(locally).toBe(0);
	});

	it("runs in place when the Worker has no loopback binding", async () => {
		let ran = false;
		await runScheduledPlaced(
			{ cron: "*/2 * * * *", scheduledTime: 1 } as ScheduledController,
			env,
			plainCtx(),
			async () => {
				ran = true;
			},
		);
		expect(ran).toBe(true);
	});
});
