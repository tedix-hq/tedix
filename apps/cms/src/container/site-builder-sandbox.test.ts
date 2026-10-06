import { describe, it, expect, vi } from "vite-plus/test";
vi.mock("@tedix/container-runtime/sandbox", () => ({
	NativeContainerSandbox: class {},
}));
vi.mock("@cloudflare/sandbox", () => ({
	Sandbox: class {},
}));
import { SiteBuilderSandboxRuntime } from "./site-builder-sandbox";
function fixture() {
	const rows = new Map<string, unknown>();
	const startProcess = vi.fn(async () => ({ id: "native-one" }));
	const getProcess = vi.fn(async () => ({
		status: async () => ({ state: "running" }),
	}));
	const create = () => {
		const instance = Object.create(
			SiteBuilderSandboxRuntime.prototype,
		) as SiteBuilderSandboxRuntime;
		const storage = {
			get: async (key: string) => rows.get(key),
			put: async (key: string, value: unknown) => {
				rows.set(key, value);
			},
			transaction: async (
				fn: (tx: unknown) => Promise<unknown>,
			): Promise<unknown> => fn(storage),
		};
		Object.defineProperties(instance, {
			ctx: { value: { storage } },
			startProcess: { value: startProcess },
			getProcess: { value: getProcess },
			deleteProcess: { value: vi.fn(async () => undefined) },
		});
		return instance;
	};
	return { rows, exec: startProcess, getProcess, create };
}
describe("CMS durable native process association", () => {
	it("recovers a logical job after DO reconstruction without dispatching again", async () => {
		const f = fixture();
		expect(
			await f.create().launchCmsJob("build:one", ["bun", "run", "build"], {}),
		).toBe("native-one");
		expect(
			await f.create().launchCmsJob("build:one", ["bun", "run", "build"], {}),
		).toBe("native-one");
		expect(f.exec).toHaveBeenCalledOnce();
	});
	it("does not repeat a launch with an unknown dispatch outcome", async () => {
		const f = fixture();
		f.exec.mockRejectedValueOnce(new Error("connection lost"));
		await expect(
			f.create().launchCmsJob("seed:one", ["sh", "seed.sh"], {}),
		).rejects.toThrow("connection lost");
		await expect(
			f.create().launchCmsJob("seed:one", ["sh", "seed.sh"], {}),
		).rejects.toThrow("unknown");
		expect(f.exec).toHaveBeenCalledOnce();
	});
	it("does not mistake a missing replaced-container process for a new job", async () => {
		const f = fixture();
		await f.create().launchCmsJob("one", ["echo", "ok"], {});
		f.exec.mockClear();
		f.getProcess.mockResolvedValueOnce(null as never);
		await expect(
			f.create().launchCmsJob("one", ["echo", "ok"], {}),
		).rejects.toThrow("lost");
		expect(f.exec).not.toHaveBeenCalled();
	});
	it("keeps a running singleton preview when explicitly started again", async () => {
		const f = fixture();
		f.rows.set("cms-job:preview", { id: "native-one" });
		await f.create().launchCmsJob("preview", ["bunx", "astro"], {}, true);
		expect(f.exec).not.toHaveBeenCalled();
	});
	it("explicitly restarts preview after known container loss", async () => {
		const f = fixture();
		f.rows.set("cms-job:preview", { id: "old" });
		f.getProcess.mockResolvedValueOnce(null as never);
		expect(
			await f.create().launchCmsJob("preview", ["bunx", "astro"], {}, true),
		).toBe("native-one");
		expect(f.exec).toHaveBeenCalledOnce();
	});
	it("never restarts an unknown preview dispatch", async () => {
		const f = fixture();
		f.rows.set("cms-job:preview", { pending: true });
		await expect(
			f.create().launchCmsJob("preview", ["bunx", "astro"], {}, true),
		).rejects.toThrow("unknown");
		expect(f.exec).not.toHaveBeenCalled();
	});
	it("rejects reuse of a job id with different command or launch options", async () => {
		const f = fixture();
		await f.create().launchCmsJob("one", ["echo", "ok"], {
			cwd: "/workspace",
			env: { A: "a", B: "b" },
			timeout: 1000,
		});
		await expect(
			f.create().launchCmsJob("one", ["echo", "changed"], {
				cwd: "/workspace",
				env: { A: "a", B: "b" },
				timeout: 1000,
			}),
		).rejects.toThrow("different launch inputs");
		await expect(
			f.create().launchCmsJob("one", ["echo", "ok"], {
				cwd: "/workspace",
				env: { A: "a", B: "b" },
				timeout: 2000,
			}),
		).rejects.toThrow("different launch inputs");
		expect(
			await f.create().launchCmsJob("one", ["echo", "ok"], {
				cwd: "/workspace",
				env: { B: "b", A: "a" },
				timeout: 1000,
			}),
		).toBe("native-one");
		expect(f.exec).toHaveBeenCalledOnce();
	});
});

it("serializes concurrent authoring initialization in the owning container and checks again after reset", async () => {
	const authoring = await import("../agent/authoring-workspace");
	let finish!: (value: string) => void;
	const prepare = vi
		.spyOn(authoring, "prepareAuthoringWorkspace")
		.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		)
		.mockResolvedValue("recovered-after-reset");
	const sandbox = fixture().create();
	const input = { templateSlug: "marketing", existingSite: true };
	const first = sandbox.prepareAuthoringWorkspace(input);
	const concurrent = sandbox.prepareAuthoringWorkspace(input);
	expect(prepare).toHaveBeenCalledTimes(1);
	finish("main");
	expect(await first).toBe("main");
	expect(await concurrent).toBe("main");
	expect(await sandbox.prepareAuthoringWorkspace(input)).toBe(
		"recovered-after-reset",
	);
	expect(prepare).toHaveBeenCalledTimes(2);
	prepare.mockRestore();
});
