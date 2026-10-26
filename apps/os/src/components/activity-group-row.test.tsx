import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ActivityFeedItemSchema } from "@tedix/api-contract/schemas/os-activity-feed";
import { setOsFormattingPreferences } from "@/lib/format";
import { ActivityGroupRow } from "./activity-group-row";

const items = [0, 1, 2].map((n) =>
	ActivityFeedItemSchema.parse({
		id: `commit:${n}`,
		actor: "Codex",
		sentence: `Codex shipped fix ${n}.`,
		source: `/work/${n}`,
		projectId: null,
		workItemId: null,
		tediId: null,
		kind: "work",
		classId: "work:work.completed",
		importance: "low",
		at: `2026-10-25T1${n}:00:00.000Z`,
		dueAt: null,
		needsAction: false,
		stalled: false,
		done: true,
		explanation: "",
		reactions: [],
	}),
);

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	setOsFormattingPreferences({ locale: null, timezone: null });
});

async function mount(open = false) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root.render(
			<ActivityGroupRow
				id="group:commit:0"
				items={items}
				actor="Codex"
				open={open}
				onToggle={vi.fn()}
			/>,
		),
	);
}

it("renders the folded row labels in English", async () => {
	await mount();
	const article = host.querySelector("article")!;
	expect(article.getAttribute("aria-label")).toBe("3 updates from Codex");
	expect(article.textContent).toContain("Codex posted 3 similar updates");
	const toggle = host.querySelector<HTMLButtonElement>(".ft-more")!;
	expect(toggle.textContent).toBe("Show all 3");
});

it("renders the folded row labels in Spanish", async () => {
	setOsFormattingPreferences({ locale: "es-ES", timezone: null });
	await mount(true);
	const article = host.querySelector("article")!;
	expect(article.getAttribute("aria-label")).toBe("3 actualizaciones de Codex");
	expect(article.textContent).toContain(
		"Codex publicó 3 actualizaciones similares",
	);
	const toggle = host.querySelector<HTMLButtonElement>(".ft-more")!;
	expect(toggle.textContent).toBe("Mostrar menos");
});
