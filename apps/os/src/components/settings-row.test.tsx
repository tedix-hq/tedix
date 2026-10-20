import { Gear } from "@phosphor-icons/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { SettingsRow, SettingsRows } from "./settings-row";

function render(icon?: Parameters<typeof SettingsRow>[0]["icon"]) {
	const host = document.createElement("div");
	host.innerHTML = renderToStaticMarkup(
		<SettingsRows>
			<SettingsRow icon={icon} title="Appearance" description="Choose a theme">
				<button type="button">Theme</button>
			</SettingsRow>
		</SettingsRows>,
	);
	return host;
}

describe("SettingsRow", () => {
	it.each([Gear, <Gear key="gear" size={18} />])(
		"renders component and node icons with the existing slots",
		(icon) => {
			const host = render(icon);
			expect(
				host.querySelector(
					'[data-slot="setting-row"] > [data-slot="icon-frame"] svg',
				),
			).not.toBeNull();
			expect(
				host.querySelector('[data-slot="setting-row-title"]')?.textContent,
			).toBe("Appearance");
			expect(
				host.querySelector('[data-slot="setting-row-description"]')
					?.textContent,
			).toBe("Choose a theme");
			expect(
				host.querySelector('[data-slot="setting-row-control"] button')
					?.textContent,
			).toBe("Theme");
		},
	);
	it("omits the icon column when no icon is supplied", () => {
		const host = render();
		expect(host.querySelector('[data-slot="icon-frame"]')).toBeNull();
		expect(
			host.querySelector('[data-slot="setting-row"]')?.className,
		).toContain("grid-cols-1");
	});
});
