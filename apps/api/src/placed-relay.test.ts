import { describe, expect, it } from "vite-plus/test";
import {
	relayKind,
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

/** A context whose loopback runs the relay in-process, as the platform would. */
function loopbackCtx(handlers: Parameters<typeof serveRelay>[4]) {
	return {
		...plainCtx(),
		exports: {
			default: ({
				props,
			}: {
				props: { tedixRelay?: "scheduled" | "queue" };
			}) => ({
				fetch: (url: string, init?: RequestInit) =>
					serveRelay(
						props.tedixRelay!,
						new Request(url, init),
						env,
						{ ...plainCtx(), props } as unknown as ExecutionContext,
						handlers,
					),
			}),
		},
	} as unknown as ExecutionContext;
}

describe("placed relay", () => {
	it("treats only a loopback with relay props as a relay", () => {
		expect(relayKind(plainCtx())).toBeUndefined();
		expect(
			relayKind({ ...plainCtx(), props: {} } as unknown as ExecutionContext),
		).toBeUndefined();
		expect(
			relayKind({
				...plainCtx(),
				props: { tedixRelay: "queue" },
			} as unknown as ExecutionContext),
		).toBe("queue");
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
		await runScheduledPlaced(
			{ cron: "*/2 * * * *", scheduledTime: 1 } as ScheduledController,
			env,
			loopbackCtx({
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
			}),
			async () => {
				locally++;
			},
		);
		expect(background).toBe(true);
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
