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
		scheduled(
			controller: ScheduledController,
			completed?: () => Promise<void>,
		): Promise<{ ok: true } | { ok: false; error: string }>;
		fetch(request: Request): Promise<Response>;
	};
}

const controller = {
	cron: "* * * * *",
	scheduledTime: Date.now(),
} as ScheduledController;

describe("tenant fetch entrypoint", () => {
	test("preserves a streamed static page and its response metadata", async () => {
		const tenant = scheduledTenant(`
export default {
  fetch() {
    return new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("<h1>"));
        await new Promise(resolve => setTimeout(resolve, 10));
        controller.enqueue(new TextEncoder().encode("Welcome</h1>"));
        controller.close();
      },
    }), { status: 201, headers: { "Content-Type": "text/html", "X-Page": "static" } });
  },
};`);
		const response = await tenant.fetch(new Request("https://tenant.test/"));
		expect(response.status).toBe(201);
		expect(response.headers.get("X-Page")).toBe("static");
		expect(await response.text()).toBe("<h1>Welcome</h1>");
	});

	test("reports late render failure and its cause before crossing the Loader boundary", async () => {
		const tenant = scheduledTenant(`
export default {
  fetch() {
    return new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("<html>"));
        await new Promise(resolve => setTimeout(resolve, 10));
        const error = new Error("Font data missing", { cause: new Error("Unregistered cssVariable") });
        error.name = "FontFamilyNotFound";
        controller.error(error);
      },
    }), { headers: { "Content-Type": "text/html" } });
  },
};`);
		await expect(
			tenant.fetch(new Request("https://tenant.test/")),
		).rejects.toThrow(
			"Tenant response failed: FontFamilyNotFound: Font data missing; caused by Error: Unregistered cssVariable",
		);
	});
});

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

		let acknowledged = false;
		await expect(
			tenant.scheduled(controller, async () => {
				expect(
					await (
						await tenant.fetch(new Request("https://tenant.test/"))
					).json(),
				).toEqual(["first", "late"]);
				acknowledged = true;
			}),
		).resolves.toEqual({ ok: true });
		expect(acknowledged).toBe(true);
		expect(
			await (await tenant.fetch(new Request("https://tenant.test/"))).json(),
		).toEqual(["first", "late"]);
	});

	test("reports handler failure only after outstanding work drains", async () => {
		const tenant = scheduledTenant(`
let completed = false;
export default {
  scheduled(_controller, _env, ctx) {
    ctx.waitUntil(new Promise((resolve) => setTimeout(() => {
      completed = true;
      resolve();
    }, 10)));
    throw new Error("handler failed");
  },
  fetch() { return Response.json(completed); },
};`);
		await expect(tenant.scheduled(controller)).resolves.toEqual({
			ok: false,
			error: "Error: handler failed",
		});
		expect(
			await (await tenant.fetch(new Request("https://tenant.test/"))).json(),
		).toBe(true);
	});

	test("reports a rejected waitUntil only after other callbacks drain", async () => {
		const tenant = scheduledTenant(`
let completed = false;
export default {
  scheduled(_controller, _env, ctx) {
    ctx.waitUntil(Promise.reject(new Error("background failed")));
    ctx.waitUntil(new Promise((resolve) => setTimeout(() => {
      completed = true;
      resolve();
    }, 10)));
  },
  fetch() { return Response.json(completed); },
};`);
		await expect(tenant.scheduled(controller)).resolves.toEqual({
			ok: false,
			error: "Error: background failed",
		});
		expect(
			await (await tenant.fetch(new Request("https://tenant.test/"))).json(),
		).toBe(true);
	});
});
