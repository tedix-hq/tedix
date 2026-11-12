import { describe, expect, it } from "vite-plus/test";
import {
	CANVAS_PHONE_PANE_KEY_PREFIX,
	persistCanvasPhonePane,
	restoreCanvasPhonePane,
} from "@/lib/canvas-phone-pane";

function memoryStorage() {
	const values = new Map<string, string>();
	return {
		values,
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => void values.set(key, value),
	};
}

describe("phone tab memory", () => {
	it("remembers the tab per workspace", () => {
		const storage = memoryStorage();
		persistCanvasPhonePane(storage, "a", "resources");
		persistCanvasPhonePane(storage, "b", "chat");
		expect(restoreCanvasPhonePane(storage, "a")).toBe("resources");
		expect(restoreCanvasPhonePane(storage, "b")).toBe("chat");
		expect(restoreCanvasPhonePane(storage, "c")).toBeNull();
	});

	it("keeps only the three phone tabs", () => {
		const storage = memoryStorage();
		persistCanvasPhonePane(storage, "a", "work");
		persistCanvasPhonePane(storage, "a", undefined);
		expect(storage.values.size).toBe(0);
		storage.values.set(`${CANVAS_PHONE_PANE_KEY_PREFIX}a`, "elsewhere");
		expect(restoreCanvasPhonePane(storage, "a")).toBeNull();
	});

	it("works without storage", () => {
		const blocked = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
		};
		expect(restoreCanvasPhonePane(blocked, "a")).toBeNull();
		expect(() => persistCanvasPhonePane(blocked, "a", "chat")).not.toThrow();
		expect(restoreCanvasPhonePane(null, "a")).toBeNull();
	});
});
