import { DEFAULT_OS_USER_PREFERENCES } from "@tedix/api-contract/schemas/user-settings";
import { act, memo, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vite-plus/test";
import { RelativeTime } from "@/components/work-ledger-row";
import {
	formatCount,
	setOsFormattingPreferences,
	useOsFormattingPreferences,
} from "@/lib/format";
import { applyOsPreferences } from "@/lib/os-presentation";
import { absoluteTime } from "@/lib/time";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const instant = "2099-08-14T01:40:00Z";
const Timestamp = memo(RelativeTime);
let cleanup: (() => void) | undefined;

afterEach(() => {
	cleanup?.();
	cleanup = undefined;
	applyOsPreferences(DEFAULT_OS_USER_PREFERENCES);
});

it("updates an already-mounted memoized timestamp after delayed preferences hydrate", async () => {
	setOsFormattingPreferences({ locale: null, timezone: null });
	const before = absoluteTime(instant);
	// Pick a zone with a different calendar date from the platform fallback.
	const timezone = before.includes("Aug 14")
		? "America/New_York"
		: "Europe/Berlin";
	let hydrate!: () => void;
	const ready = new Promise<void>((resolve) => {
		hydrate = resolve;
	});
	function Hydration() {
		useEffect(() => {
			void ready.then(() =>
				applyOsPreferences({ ...DEFAULT_OS_USER_PREFERENCES, timezone }),
			);
		}, []);
		return null;
	}
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	cleanup = () => {
		act(() => root.unmount());
		container.remove();
	};
	await act(async () =>
		root.render(
			<>
				<Hydration />
				<Timestamp at={instant} />
			</>,
		),
	);
	const timestamp = container.querySelector("time")!;
	expect(timestamp.title).toBe(before);
	await act(async () => {
		hydrate();
		await ready;
	});
	expect(timestamp.title).toBe(absoluteTime(instant));
	expect(timestamp.title).not.toBe(before);
	expect(container.querySelector("time")).toBe(timestamp);
});

it("reacts to timezone, locale and reset changes without losing state or rerendering for unchanged formatting", () => {
	let renders = 0;
	function Consumer() {
		useOsFormattingPreferences();
		renders++;
		const [draft, setDraft] = useState("draft");
		return (
			<button onClick={() => setDraft("edited")}>
				{draft}: {formatCount(12345)} {absoluteTime(instant)}
			</button>
		);
	}
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	cleanup = () => {
		act(() => root.unmount());
		container.remove();
	};
	act(() => root.render(<Consumer />));
	const button = container.querySelector("button")!;
	act(() => button.click());
	act(() =>
		applyOsPreferences({
			...DEFAULT_OS_USER_PREFERENCES,
			timezone: "Europe/Berlin",
		}),
	);
	expect(button.textContent).toContain("edited: 12,345 Aug 14, 2099, 3:40 AM");
	act(() =>
		applyOsPreferences({
			...DEFAULT_OS_USER_PREFERENCES,
			locale: "de-DE",
			timezone: "Europe/Berlin",
		}),
	);
	expect(button.textContent).toContain("edited: 12.345");
	expect(button.textContent).toContain(absoluteTime(instant));
	const previousRenders = renders;
	act(() =>
		applyOsPreferences({
			...DEFAULT_OS_USER_PREFERENCES,
			locale: "de-DE",
			timezone: "Europe/Berlin",
			density: "compact",
		}),
	);
	expect(renders).toBe(previousRenders);
	act(() => applyOsPreferences(DEFAULT_OS_USER_PREFERENCES));
	expect(button.textContent).toBe(`edited: 12,345 ${absoluteTime(instant)}`);
	expect(container.querySelector("button")).toBe(button);
});
