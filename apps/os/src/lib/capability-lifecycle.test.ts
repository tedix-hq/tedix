import { describe, expect, it, vi } from "vite-plus/test";
import {
	installOsCapabilityPageLifecycle,
	installOsRealtimeWakeProbes,
} from "./capability-lifecycle";

describe("OS capability page lifecycle", () => {
	it("disposes on logout or cross-tenant document exit and removes its listener", () => {
		const owner: {
			listener: ((event: { persisted?: boolean }) => void) | null;
		} = { listener: null };
		const target = {
			addEventListener: vi.fn(
				(_type: "pagehide", next: (event: { persisted?: boolean }) => void) => {
					owner.listener = next;
				},
			),
			removeEventListener: vi.fn(),
		};
		const dispose = vi.fn();
		const remove = installOsCapabilityPageLifecycle(target, dispose);
		owner.listener?.({ persisted: false });
		expect(dispose).toHaveBeenCalledOnce();
		remove();
		remove();
		expect(target.removeEventListener).toHaveBeenCalledOnce();
	});

	it("retains capabilities while the browser freezes a bfcache entry", () => {
		const owner: {
			listener: ((event: { persisted?: boolean }) => void) | null;
		} = { listener: null };
		const target = {
			addEventListener: (
				_type: "pagehide",
				next: (event: { persisted?: boolean }) => void,
			) => {
				owner.listener = next;
			},
			removeEventListener: vi.fn(),
		};
		const dispose = vi.fn();
		installOsCapabilityPageLifecycle(target, dispose);
		owner.listener?.({ persisted: true });
		expect(dispose).not.toHaveBeenCalled();
	});
});

describe("OS realtime wake probes", () => {
	it("probes only visible tabs and online signals, then removes both listeners", () => {
		const listeners = new Map<string, () => void>();
		const target = {
			addEventListener: vi.fn((type: string, listener: () => void) => {
				listeners.set(type, listener);
			}),
			removeEventListener: vi.fn((type: string) => listeners.delete(type)),
		};
		let visibility: DocumentVisibilityState = "hidden";
		const probe = vi.fn(async () => true);
		const remove = installOsRealtimeWakeProbes(target, () => visibility, probe);

		listeners.get("visibilitychange")?.();
		expect(probe).not.toHaveBeenCalled();
		visibility = "visible";
		listeners.get("visibilitychange")?.();
		listeners.get("online")?.();
		expect(probe).toHaveBeenCalledTimes(2);

		remove();
		remove();
		expect(target.removeEventListener).toHaveBeenCalledTimes(2);
		expect(listeners.size).toBe(0);
	});
});
