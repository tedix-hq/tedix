import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { KeepAliveProvider, KeepAliveSlot } from "./keep-alive";

type Movable = { moveBefore?: (node: Node, child: Node | null) => void };
const proto = Element.prototype as unknown as Movable;
const original = proto.moveBefore;
afterEach(() => {
	if (original) proto.moveBefore = original;
	else delete proto.moveBefore;
	document.body.replaceChildren();
});

const mounts: string[] = [];
function Piece({ name, label }: { name: string; label: string }) {
	useEffect(() => {
		mounts.push(`mount:${name}`);
		return () => void mounts.push(`unmount:${name}`);
	}, [name]);
	return <p data-piece={name}>{label}</p>;
}

function Screen({ show, label = "one" }: { show: string[]; label?: string }) {
	return (
		<KeepAliveProvider>
			{show.map((name) => (
				<KeepAliveSlot key={name} id={name} data-slot={name}>
					<Piece name={name} label={label} />
				</KeepAliveSlot>
			))}
		</KeepAliveProvider>
	);
}

function setup() {
	mounts.length = 0;
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	return {
		host,
		render: (node: React.ReactNode) => act(() => root.render(node)),
	};
}

describe("KeepAlive", () => {
	it("keeps a piece mounted while hidden and shows the same element again", () => {
		proto.moveBefore = function (this: Element, node, child) {
			this.insertBefore(node, child);
		};
		const view = setup();
		view.render(<Screen show={["a"]} />);
		const first = view.host.querySelector('[data-slot="a"] [data-piece="a"]');
		expect(first?.textContent).toBe("one");

		view.render(<Screen show={["b"]} />);
		expect(mounts).not.toContain("unmount:a");
		const parked = view.host.querySelector(
			'[data-keep-alive-parking] [data-piece="a"]',
		);
		expect(parked).toBe(first);
		expect(view.host.querySelector("[data-keep-alive-parking]")).toHaveProperty(
			"hidden",
			true,
		);

		view.render(<Screen show={["a"]} label="two" />);
		const again = view.host.querySelector('[data-slot="a"] [data-piece="a"]');
		expect(again).toBe(first);
		expect(again?.textContent).toBe("two");
		expect(mounts.filter((entry) => entry === "mount:a")).toHaveLength(1);
	});

	it("drops the oldest hidden pieces beyond the limit", () => {
		proto.moveBefore = function (this: Element, node, child) {
			this.insertBefore(node, child);
		};
		const view = setup();
		for (const name of ["a", "b", "c", "d", "e", "f"])
			view.render(<Screen show={[name]} />);
		expect(mounts).toContain("unmount:a");
		expect(mounts).not.toContain("unmount:b");
		expect(
			view.host.querySelectorAll("[data-keep-alive-parking] [data-piece]"),
		).toHaveLength(4);
	});

	it("renders in place, as before, where the browser cannot move a frame", () => {
		delete proto.moveBefore;
		const view = setup();
		view.render(<Screen show={["a"]} />);
		expect(
			view.host.querySelector('[data-slot="a"] > [data-piece="a"]'),
		).not.toBeNull();
		view.render(<Screen show={["b"]} />);
		expect(mounts).toContain("unmount:a");
	});
});
