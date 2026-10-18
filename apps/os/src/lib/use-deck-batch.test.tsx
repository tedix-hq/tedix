import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vite-plus/test";
import { useDeckBatch } from "./use-deck-batch";
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	sessionStorage.clear();
});
function Preview({
	ids,
	person = "fictional-person",
	ready = true,
}: {
	ids: string[];
	person?: string;
	ready?: boolean;
}) {
	const { batch, dismiss } = useDeckBatch(`${person}:batch-one`, ids, 2, ready);
	return (
		<>
			<output>{JSON.stringify(batch)}</output>
			<button onClick={() => dismiss("a")}>Later</button>
		</>
	);
}
it("freezes a bounded list, preserves Later across a remount, and separates people", async () => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const render = async (ids: string[], person?: string, ready?: boolean) =>
		act(async () =>
			root.render(<Preview ids={ids} person={person} ready={ready} />),
		);
	await render(["a", "b", "c"], undefined, false);
	expect(host.querySelector("output")!.textContent).toBe("null");
	await render(["a", "b", "c"]);
	expect(JSON.parse(host.querySelector("output")!.textContent!)).toMatchObject({
		ids: ["a", "b"],
	});
	await render(["new", "a", "b", "c"]);
	expect(JSON.parse(host.querySelector("output")!.textContent!)).toMatchObject({
		ids: ["a", "b"],
	});
	await act(async () => host.querySelector("button")!.click());
	await act(async () => root.unmount());
	root = createRoot(host);
	await render(["new", "a", "b", "c"]);
	expect(JSON.parse(host.querySelector("output")!.textContent!)).toMatchObject({
		ids: ["a", "b"],
		dismissed: ["a"],
	});
	await render(["new", "a"], "another-person");
	expect(JSON.parse(host.querySelector("output")!.textContent!)).toMatchObject({
		ids: ["new", "a"],
		dismissed: [],
	});
});

it("restores an underfilled batch while loading and fills only its unused capacity without reviving Later", async () => {
	sessionStorage.setItem(
		"decision-deck:fictional-person:batch-one",
		JSON.stringify({
			key: "fictional-person:batch-one",
			ids: ["a"],
			dismissed: ["a"],
		}),
	);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root.render(<Preview ids={["a", "b", "c"]} ready={false} />),
	);
	expect(JSON.parse(host.querySelector("output")!.textContent!)).toMatchObject({
		ids: ["a"],
		dismissed: ["a"],
	});
	await act(async () => root.render(<Preview ids={["a", "b", "c"]} />));
	expect(JSON.parse(host.querySelector("output")!.textContent!)).toMatchObject({
		ids: ["a", "b"],
		dismissed: ["a"],
	});
	await act(async () => root.render(<Preview ids={["new", "a", "b", "c"]} />));
	expect(JSON.parse(host.querySelector("output")!.textContent!)).toMatchObject({
		ids: ["a", "b"],
		dismissed: ["a"],
	});
});
