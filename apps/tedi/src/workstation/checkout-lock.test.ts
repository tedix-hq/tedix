import { describe, expect, it, vi } from "vite-plus/test";
import {
	CheckoutAdmissionPendingError,
	checkoutOperationCommand,
	startCheckoutOperation,
} from "./checkout-lock";
import type { WorkstationRuntimeBody } from "./computer-body";

function fixture() {
	const process = {
		status: vi.fn(async (): Promise<any> => ({ state: "running" })),
		kill: vi.fn(async () => undefined),
	};
	const body = {
		launchExecution: vi.fn(async (_request: unknown) => ({
			state: "started",
			nativeId: "native-1",
		})),
		getProcess: vi.fn(async () => process),
		pathExists: vi.fn(async () => ({ pathExists: true })),
		writeFile: vi.fn(async () => undefined),
		renamePath: vi.fn(async () => ({ success: true })),
	};
	return {
		process,
		raw: body,
		body: body as unknown as WorkstationRuntimeBody,
	};
}

describe("operation-owned checkout authorization", () => {
	it("authorizes only after acquisition and publishes a unique gate", async () => {
		const f = fixture();
		const authorize = vi.fn(async () => {
			expect(f.raw.pathExists).toHaveBeenCalledOnce();
			expect(f.raw.renamePath).not.toHaveBeenCalled();
		});
		const result = await startCheckoutOperation(f.body, {
			command: "printf user-output",
			authorize,
			timeout: 40_000,
		});
		expect(result.process).toBe(f.process);
		expect(authorize).toHaveBeenCalledOnce();
		expect(f.raw.renamePath).toHaveBeenCalledOnce();
		expect(f.raw.launchExecution.mock.calls[0]?.[0]).toMatchObject({
			timeout: 40_000,
		});
		expect(f.process.kill).not.toHaveBeenCalled();
	});
	it("refuses a changed authority without publishing authorization", async () => {
		const f = fixture();
		const failure = new Error("authority changed");
		await expect(
			startCheckoutOperation(f.body, {
				command: "mutation",
				authorize: async () => {
					throw failure;
				},
			}),
		).rejects.toBe(failure);
		expect(f.raw.writeFile).not.toHaveBeenCalled();
		expect(f.process.kill).toHaveBeenCalledExactlyOnceWith(9);
	});
	it("never replays an ambiguous native dispatch", async () => {
		const f = fixture();
		f.raw.launchExecution.mockResolvedValue({ state: "unknown" } as never);
		await expect(
			startCheckoutOperation(f.body, {
				command: "mutation",
				executionId: "original",
				authorize: vi.fn(),
			}),
		).rejects.toMatchObject({
			executionId: "original",
			observation: "unavailable",
		});
		expect(f.raw.launchExecution).toHaveBeenCalledOnce();
		expect(f.raw.getProcess).not.toHaveBeenCalled();
		expect(f.raw.writeFile).not.toHaveBeenCalled();
	});
	it("cannot publish a late gate after local authorization deadline", async () => {
		vi.useFakeTimers();
		try {
			const f = fixture();
			let resume!: () => void;
			const paused = new Promise<void>((resolve) => {
				resume = resolve;
			});
			const outcome = startCheckoutOperation(f.body, {
				command: "mutation",
				authorize: () => paused,
			}).catch((e) => e);
			await vi.advanceTimersByTimeAsync(30_001);
			expect(await outcome).toBeInstanceOf(CheckoutAdmissionPendingError);
			resume();
			await vi.advanceTimersByTimeAsync(1);
			expect(f.raw.writeFile).not.toHaveBeenCalled();
			expect(f.raw.renamePath).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
	it("preserves an authorized execution when publication acknowledgement is lost", async () => {
		const f = fixture();
		f.raw.renamePath.mockRejectedValue(new Error("lost response"));
		await expect(
			startCheckoutOperation(f.body, {
				command: "mutation",
				executionId: "original",
				authorize: vi.fn(),
			}),
		).rejects.toMatchObject({
			executionId: "original",
			observation: "unavailable",
		});
		expect(f.process.kill).not.toHaveBeenCalled();
	});
	it("treats a failed staging write as an unknown dispatch", async () => {
		const f = fixture();
		f.raw.writeFile.mockRejectedValue(new Error("staging failed"));
		await expect(
			startCheckoutOperation(f.body, {
				command: "mutation",
				authorize: vi.fn(),
			}),
		).rejects.toMatchObject({
			observation: "unavailable",
		});
		expect(f.raw.renamePath).not.toHaveBeenCalled();
	});
	it("keeps control markers out of stdout and bounds abandoned authorization", () => {
		const command = checkoutOperationCommand({
			command: "printf user-output",
			directory: "/tmp/unique",
			mode: "exclusive",
			allowClosing: false,
		});
		expect(command).toContain("flock -x -w 30");
		expect(command).toContain("-ge 300");
		expect(command).toContain("printf acquired >");
		expect(command).not.toContain("sleep infinity");
		expect(command).toContain("workstation is closing");
	});
	it("recognizes native flock contention even when it beats the JS observation timeout", async () => {
		const f = fixture();
		f.process.status.mockResolvedValue({
			state: "exited",
			exit: { code: 200, timedOut: false },
		});
		await expect(
			startCheckoutOperation(f.body, {
				command: "mutation",
				executionId: "pending-original",
				authorize: vi.fn(),
			}),
		).rejects.toMatchObject({
			executionId: "pending-original",
			reason: "contention",
		});
		expect(f.raw.writeFile).not.toHaveBeenCalled();
	});
	it.each([1, 75])(
		"does not classify preauthorization failure %s as contention",
		async (code) => {
			const f = fixture();
			f.process.status.mockResolvedValue({
				state: "exited",
				exit: { code, timedOut: false },
			});
			const result = await startCheckoutOperation(f.body, {
				command: "mutation",
				authorize: vi.fn(),
			}).catch((error) => error);
			expect(result).not.toBeInstanceOf(CheckoutAdmissionPendingError);
			expect(result.message).toContain("ended before authorization");
		},
	);
	it("does not reinterpret an authorized command's eventual conflict-shaped exit", async () => {
		const f = fixture();
		const operation = await startCheckoutOperation(f.body, {
			command: "exit 200",
			authorize: vi.fn(),
		});
		f.process.status.mockResolvedValue({
			state: "exited",
			exit: { code: 200, timedOut: false },
		});
		expect(operation.process).toBe(f.process);
		expect(f.process.kill).not.toHaveBeenCalled();
	});
});
