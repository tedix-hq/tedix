import { describe, expect, it, vi } from "vite-plus/test";
import { Card } from "./card";

describe("Card interaction semantics", () => {
	it("gives interactive cards button semantics and selection state", () => {
		const element = Card({ onClick: () => undefined, selected: true });

		expect(element.props.role).toBe("button");
		expect(element.props.tabIndex).toBe(0);
		expect(element.props["aria-pressed"]).toBe(true);
	});

	it.each(["Enter", " "])("activates on %s", (key) => {
		const onClick = vi.fn();
		const click = vi.fn();
		const preventDefault = vi.fn();
		const element = Card({ onClick });

		element.props.onKeyDown({ key, currentTarget: { click }, preventDefault });

		expect(preventDefault).toHaveBeenCalledOnce();
		expect(click).toHaveBeenCalledOnce();
	});
});
