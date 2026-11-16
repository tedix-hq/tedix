import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ActivityFeedItemSchema } from "@tedix/api-contract/schemas/os-activity-feed";
import { setOsFormattingPreferences } from "@/lib/format";
import { stalledCauses } from "@/lib/feed-timeline";
import { StalledCauseRow } from "./stalled-cause-row";

const workItemId = "11111111-1111-4111-8111-111111111111";
const projectId = "33333333-3333-4333-8333-333333333333";
const pauses = [0, 1, 2].map((n) =>
	ActivityFeedItemSchema.parse({
		id: `attempt:${n}`,
		actor: "Tedi",
		sentence: "Workspace file — paused before finishing.",
		source: `/work/items/${workItemId}`,
		projectId,
		workItemId,
		tediId: "22222222-2222-4222-8222-222222222222",
		kind: "result",
		classId: "tedi:result:expired",
		resultOutcome: "expired",
		importance: "low",
		at: `2026-10-25T1${n}:00:00.000Z`,
		dueAt: null,
		needsAction: false,
		stalled: true,
		done: false,
		explanation: "The linked attempt records this outcome.",
		attachment: {
			title: "Workspace file",
			...(n === 2
				? { summary: "Could not open budget.xlsx: the file is locked." }
				: {}),
		},
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

async function mount(items = pauses, open = false) {
	const [group, ...rest] = stalledCauses(items);
	expect(rest).toEqual([]);
	const onToggle = vi.fn();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root.render(
			<StalledCauseRow
				group={group!}
				actor="Cedar"
				project="Pine Studio"
				open={open}
				onToggle={onToggle}
			/>,
		),
	);
	return onToggle;
}

it("shows three identical pauses as one row with its target, reason, count and next action", async () => {
	const onToggle = await mount();
	const article = host.querySelector("article")!;
	expect(article.getAttribute("aria-label")).toBe(
		"Workspace file: Paused, 3 times",
	);
	expect(host.querySelector(".ft-sentence")!.textContent).toBe(
		"Workspace file",
	);
	expect(host.querySelector(".ft-byline")!.textContent).toContain("Cedar");
	expect(
		host
			.querySelector(`.ft-byline a[href="/work/projects/${projectId}"]`)
			?.textContent?.trim(),
	).toBe("Pine Studio");
	const why = host.querySelector(".ft-stalled-why")!.textContent;
	expect(why).toContain("Paused · 3 times");
	expect(why).toContain(
		"The Attempt stopped reporting before it delivered a result.",
	);
	expect(why).toContain(
		"Last report: Could not open budget.xlsx: the file is locked.",
	);
	const next = host.querySelectorAll(".ft-stalled-actions a");
	expect(next).toHaveLength(1);
	expect(next[0]!.getAttribute("href")).toBe(`/work/items/${workItemId}`);
	expect(next[0]!.textContent).toBe("Open Work Item");
	const toggle = host.querySelector<HTMLButtonElement>(".ft-more")!;
	expect(toggle.textContent).toBe("Show all 3 records");
	expect(toggle.getAttribute("aria-expanded")).toBe("false");
	await act(async () => toggle.click());
	expect(onToggle).toHaveBeenCalledTimes(1);
});

it("leaves the count off one pause that left two records", async () => {
	await mount(
		[
			pauses[0]!,
			ActivityFeedItemSchema.parse({
				...pauses[0],
				id: "work:expired",
				kind: "work",
				classId: "work:attempt.expired",
				resultOutcome: undefined,
				attachment: undefined,
				sentence: "Workspace file needs a fresh attempt.",
			}),
		],
		true,
	);
	expect(host.querySelector("article")!.getAttribute("aria-label")).toBe(
		"Workspace file: Paused",
	);
	expect(host.querySelector(".ft-stalled-why")!.textContent).not.toContain(
		"times",
	);
	expect(host.querySelector(".ft-more")!.textContent).toBe("Hide the records");
});

it("reads in Spanish for a Spanish reader", async () => {
	setOsFormattingPreferences({ locale: "es-ES", timezone: null });
	await mount();
	expect(host.querySelector("article")!.getAttribute("aria-label")).toBe(
		"Workspace file: En pausa, 3 veces",
	);
	expect(host.querySelector(".ft-stalled-actions a")!.textContent).toBe(
		"Abrir el trabajo",
	);
});
