import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => {
	const rows = new Map<string, unknown>();
	const container = {
		running: false,
		images: { workstation: "registry/workstation@sha256:one" },
		start: vi.fn((_: unknown) => {
			container.running = true;
		}),
		inspect: vi.fn(async () =>
			container.running
				? { image: container.images.workstation, labels: {} }
				: null,
		),
		setInactivityTimeout: vi.fn(async () => undefined),
		exec: vi.fn(async () => ({
			output: async () => ({
				exitCode: 0,
				stdout: new ArrayBuffer(0),
				stderr: new ArrayBuffer(0),
			}),
		})),
		snapshotContainer: vi.fn(async () => ({ id: "snapshot-1", size: 10 })),
		destroy: vi.fn(async () => {
			container.running = false;
		}),
		interceptAllOutboundHttp: vi.fn(async () => undefined),
		interceptOutboundHttps: vi.fn(async () => undefined),
	};
	return { rows, container, alarms: [] as number[] };
});

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
vi.mock("@cloudflare/sandbox", () => ({
	DirectoryBackup: class {
		intercept = vi.fn(async () => undefined);
	},
}));
vi.mock("@tedix/container-runtime/sandbox", () => ({
	NativeContainerSandbox: class {
		env = { ENVIRONMENT: "test" };
		container = fixture.container;
		ctx = {
			id: { name: "workstation-1", toString: () => "native-id" },
			storage: {
				get: async (key: string) => fixture.rows.get(key),
				put: async (key: string, value: unknown) =>
					fixture.rows.set(key, value),
				delete: async (key: string) => fixture.rows.delete(key),
				setAlarm: async (at: number) => fixture.alarms.push(at),
			},
		};
		startOptions() {
			return {
				image: fixture.container.images.workstation,
				enableInternet: false,
			};
		}
		async startContainer() {
			fixture.container.start(this.startOptions());
		}
		async configureContainer() {}
		async afterContainerAccess() {}
		async ensureContainer() {
			if (!fixture.container.running) await this.startContainer();
			await this.configureContainer();
			await this.afterContainerAccess();
		}
		async readFile() {
			await this.ensureContainer();
			return { success: true, content: "", size: 0 };
		}
	},
}));
vi.mock("./egress", () => ({ outboundEgressHandler: vi.fn() }));

import { TediWorkstationRuntimeSandbox } from "./index";

const policy = {
	leaseId: "lease-1",
	organizationId: "org-1",
	tediId: "tedi-1",
	workstationId: "workstation-1",
	workItemId: "work-1",
};
const host = () =>
	new TediWorkstationRuntimeSandbox(
		{
			exports: {
				DirectoryBackupGateway: {},
				WorkstationOutbound: () => ({}),
			},
		} as never,
		{ ENVIRONMENT: "test" } as never,
	);

beforeEach(() => {
	fixture.rows.clear();
	fixture.alarms.length = 0;
	fixture.container.running = false;
	fixture.container.images.workstation = "registry/workstation@sha256:one";
	for (const fn of [
		fixture.container.start,
		fixture.container.inspect,
		fixture.container.exec,
		fixture.container.snapshotContainer,
		fixture.container.destroy,
	])
		fn.mockClear();
});

describe("native workstation snapshot resume", () => {
	it("saves on idle and consumes the snapshot for the same lease", async () => {
		const first = host();
		await first.setOutboundPolicy(policy);
		await first.readFile("/workspace");
		await first.alarm();
		expect(fixture.container.snapshotContainer).toHaveBeenCalledTimes(1);
		expect(fixture.container.destroy).toHaveBeenCalledTimes(1);
		expect(fixture.rows.get("native-resume-snapshot")).toMatchObject({
			fence: policy,
			image: "registry/workstation@sha256:one",
			snapshot: { id: "snapshot-1" },
		});

		const resumed = host();
		await resumed.setOutboundPolicy(policy);
		await resumed.readFile("/workspace");
		expect(fixture.container.start).toHaveBeenLastCalledWith(
			expect.objectContaining({
				containerSnapshot: { id: "snapshot-1" },
				enableInternet: false,
			}),
		);
		expect(fixture.rows.has("native-resume-snapshot")).toBe(false);
	});

	it("deletes a mismatched lease snapshot and cold starts", async () => {
		fixture.rows.set("native-resume-snapshot", {
			createdAt: "2026-10-01T00:00:00.000Z",
			expiresAt: "2099-10-01T00:00:00.000Z",
			fence: policy,
			image: fixture.container.images.workstation,
			snapshot: { id: "snapshot-1", size: 10 },
		});
		const instance = host();
		await instance.setOutboundPolicy({ ...policy, leaseId: "lease-2" });
		await instance.readFile("/workspace");
		expect(fixture.container.start).toHaveBeenLastCalledWith(
			expect.objectContaining({
				image: "registry/workstation@sha256:one",
			}),
		);
		expect(fixture.rows.has("native-resume-snapshot")).toBe(false);
	});

	it("falls back to the declared image when the provider rejects restore", async () => {
		fixture.rows.set("native-resume-snapshot", {
			createdAt: "2026-10-01T00:00:00.000Z",
			expiresAt: "2099-10-01T00:00:00.000Z",
			fence: policy,
			image: fixture.container.images.workstation,
			snapshot: { id: "snapshot-1", size: 10 },
		});
		fixture.container.start
			.mockImplementationOnce(() => {
				throw new Error("snapshot expired");
			})
			.mockImplementationOnce(() => {
				fixture.container.running = true;
			});
		const instance = host();
		await instance.setOutboundPolicy(policy);
		await instance.readFile("/workspace");
		expect(fixture.container.start).toHaveBeenCalledTimes(2);
		expect(fixture.container.start).toHaveBeenLastCalledWith(
			expect.objectContaining({ image: fixture.container.images.workstation }),
		);
		expect(fixture.rows.has("native-resume-snapshot")).toBe(false);
	});
});
