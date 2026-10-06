// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { runLoader, type LoaderOptions } from "./loader-harness";

let decode: () => Promise<void> = () => Promise.resolve();

afterEach(() => {
	vi.restoreAllMocks();
	decode = () => Promise.resolve();
	delete (document as { visibilityState?: unknown }).visibilityState;
});

async function launcherFor(
	options: LoaderOptions & {
		decode?: () => Promise<void>;
		storage?: Record<string, string>;
		hidden?: boolean;
	},
) {
	if (options.decode) decode = options.decode;
	vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(() =>
		decode(),
	);
	let visibility = options.hidden ? "hidden" : "visible";
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		get: () => visibility,
	});
	const loader = await runLoader({
		...options,
		dataset: { tedixTenant: "acme" },
		before: () => {
			for (const [key, value] of Object.entries(options.storage ?? {}))
				localStorage.setItem(key, value);
		},
	});
	return {
		...loader,
		shell: loader.shell()!,
		launcher: loader.launcher()!,
		show: () => {
			visibility = "visible";
			document.dispatchEvent(new Event("visibilitychange"));
		},
	};
}

const visible = (shell: HTMLElement) =>
	vi.waitFor(() => expect(shell.style.visibility).toBe("visible"));

describe("loader launcher visibility", () => {
	it("paints nothing at all before branding resolves", async () => {
		const { shell, launcher } = await launcherFor({
			branding: { title: "Acme Bot" },
			pendingFetch: true,
		});
		// The regression this replaces: a black circle with the platform's "T"
		// on a provider's dashboard, swapped for their logo seconds later.
		expect(shell.style.visibility).toBe("hidden");
		expect(shell.style.opacity).toBe("0");
		expect(launcher.childNodes).toHaveLength(0);
		expect(launcher.textContent).toBe("");
	});

	it("reveals the tenant's own icon once it has decoded", async () => {
		const mark = vi.spyOn(performance, "mark");
		const { shell, launcher } = await launcherFor({
			branding: {
				launcherIconUrl: "https://cdn.acme.example/logo.svg",
				accentColor: "#1594c7",
			},
		});
		await visible(shell);
		expect(launcher.children).toHaveLength(1);
		expect(launcher.querySelector("img")?.src).toBe(
			"https://cdn.acme.example/logo.svg",
		);
		expect(launcher.querySelector("svg")).toBeNull();
		expect(launcher.style.background).toBe("#1594c7");
		expect(mark).toHaveBeenCalledWith("tedix:shell-ready");
	});

	it("reveals a neutral mark, never a platform letter, when branding fails", async () => {
		const { shell, launcher } = await launcherFor({ branding: null });
		await visible(shell);
		expect(launcher.querySelector("svg path")?.getAttribute("d")).toBe(
			"M7 18.5 3.5 21v-5.2A8.5 8.5 0 1 1 7 18.5Z",
		);
		expect(launcher.textContent).toBe("");
		expect(launcher.querySelector("img")).toBeNull();
	});

	it("reveals rather than stranding the assistant behind a broken logo", async () => {
		const { shell, launcher } = await launcherFor({
			branding: { launcherIconUrl: "https://cdn.acme.example/missing.svg" },
			decode: () => Promise.reject(new Error("decode failed")),
		});
		await visible(shell);
		expect(launcher.querySelector("img")).toBeNull();
		expect(launcher.querySelector("svg")).not.toBeNull();
	});

	it("paints a returning visitor's logo without waiting for the network", async () => {
		const { shell, launcher, fetch } = await launcherFor({
			pendingFetch: true,
			storage: {
				"tedix:branding:acme:es-MX": JSON.stringify({
					launcherIconUrl: "https://cdn.acme.example/logo.svg",
				}),
			},
		});
		await visible(shell);
		expect(launcher.querySelector("img")?.src).toBe(
			"https://cdn.acme.example/logo.svg",
		);
		// Revalidation is still in flight; the paint did not wait for it.
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("stores the answer so the next visit can paint from it", async () => {
		await launcherFor({
			branding: { launcherIconUrl: "https://cdn.acme.example/logo.svg" },
		});
		await vi.waitFor(() =>
			expect(localStorage.getItem("tedix:branding:acme:es-MX")).not.toBeNull(),
		);
		expect(
			JSON.parse(localStorage.getItem("tedix:branding:acme:es-MX")!),
		).toEqual({ launcherIconUrl: "https://cdn.acme.example/logo.svg" });
	});

	it("does not run the give-up clock out while the tab is hidden", async () => {
		// A hidden tab defers image decoding indefinitely. Revealing the neutral
		// mark on the deadline would swap in the decoded logo at the exact
		// moment the visitor switches to the tab.
		let decoded: () => void = () => {};
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { shell, launcher, show } = await launcherFor({
			branding: { launcherIconUrl: "https://cdn.acme.example/logo.svg" },
			decode: () => new Promise<void>((resolve) => (decoded = resolve)),
			hidden: true,
		});
		await vi.advanceTimersByTimeAsync(5_000);
		expect(shell.style.visibility).toBe("hidden");
		expect(launcher.childNodes).toHaveLength(0);

		// Back in front of the visitor, the decode completes and wins the reveal.
		show();
		decoded();
		await vi.advanceTimersByTimeAsync(0);
		vi.useRealTimers();
		await visible(shell);
		expect(launcher.querySelector("img")?.src).toBe(
			"https://cdn.acme.example/logo.svg",
		);
		expect(launcher.querySelector("svg")).toBeNull();
	});

	it("reveals the neutral mark at the deadline when branding is merely slow", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { shell, launcher } = await launcherFor({ pendingFetch: true });
		await vi.advanceTimersByTimeAsync(1_799);
		expect(shell.style.visibility).toBe("hidden");
		await vi.advanceTimersByTimeAsync(1);
		expect(shell.style.visibility).toBe("visible");
		expect(launcher.querySelector("svg")).not.toBeNull();
		vi.useRealTimers();
	});

	it("hands the runtime the branding it already read", async () => {
		const { Tedix, fetch } = await launcherFor({
			branding: { title: "Acme Bot" },
		});
		const branding = Tedix.branding as {
			tenant: string;
			locale: string;
			ready: Promise<unknown>;
		};
		expect(branding.tenant).toBe("acme");
		expect(branding.locale).toBe("es-MX");
		await expect(branding.ready).resolves.toEqual({ title: "Acme Bot" });
		// One read for both the launcher and the runtime that replaces it.
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("positions and hides the shell as the host configures it", async () => {
		const loader = await runLoader();
		loader.Tedix.init({
			tenant: "acme",
			branding: false,
			launcherPosition: "bottom-left",
			horizontalOffset: 40,
			bottomOffset: 12,
			zIndex: 10,
		});
		const shell = loader.shell()!;
		expect(shell.style.left).toBe("40px");
		expect(shell.style.right).toBe("auto");
		expect(shell.style.bottom).toBe("12px");
		expect(shell.style.zIndex).toBe("10");
		loader.Tedix.shutdown();
		const hosted = await runLoader({ keepPage: true });
		hosted.Tedix.init({
			tenant: "acme",
			branding: false,
			launcherMode: "host",
		});
		expect(hosted.shell()!.hidden).toBe(true);
	});
});
