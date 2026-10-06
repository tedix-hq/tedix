import { env } from "cloudflare:workers";
import { describe, expect, test } from "vite-plus/test";

import { tenantRuntimeEntrypointModule } from "./index";

function scheduledTenant(source: string) {
	const loader = (env as unknown as { LOADER: WorkerLoader }).LOADER;
	const worker = loader.get(`scheduled-permit:${crypto.randomUUID()}`, () => ({
		compatibilityDate: "2026-05-14",
		mainModule: "entry.mjs",
		modules: {
			"entry.mjs": tenantRuntimeEntrypointModule("./handler.mjs"),
			"handler.mjs": { js: source },
		},
	}));
	return worker.getEntrypoint() as unknown as {
		scheduled(controller: ScheduledController): Promise<void>;
		fetch(request: Request): Promise<Response>;
	};
}

const controller = {
	cron: "* * * * *",
	scheduledTime: Date.now(),
} as ScheduledController;

describe("tenant scheduled entrypoint", () => {
	test("drains waitUntil work added after the handler returns", async () => {
		const tenant = scheduledTenant(`
let completed = [];
export default {
  scheduled(_controller, _env, ctx) {
    ctx.waitUntil(new Promise((resolve) => setTimeout(() => {
      completed.push("first");
      ctx.waitUntil(new Promise((lateResolve) => setTimeout(() => {
        completed.push("late");
        lateResolve();
      }, 10)));
      resolve();
    }, 10)));
  },
  fetch() { return Response.json(completed); },
};`);

		await tenant.scheduled(controller);
		expect(
			await (await tenant.fetch(new Request("https://tenant.test/"))).json(),
		).toEqual(["first", "late"]);
	});
});
