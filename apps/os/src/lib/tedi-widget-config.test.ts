import { describe, expect, it } from "vite-plus/test";
import {
	defaultTediWidgetConfig,
	resolveTediWidgetConfig,
} from "./tedi-widget-config";

describe("Tedi widget organization configuration", () => {
	it("derives neutral defaults from the organization identity", () => {
		const config = defaultTediWidgetConfig({ name: "Acme" });
		expect(config.product).toBe("Acme");
		expect(config.subtitle).toContain("Acme");
		expect(config.locale).toBe("en-US");
		expect(config.themeMode).toBe("host");
		expect(config.launcherPosition).toBe("bottom-right");
		expect(config.homeModules).toEqual(["welcome", "attention", "recent"]);
		expect(config.analyticsEnabled).toBe(false);
		expect(JSON.stringify(config)).not.toContain("Globex");
	});

	it("uses the published versioned configuration without tenant branches", () => {
		const published = {
			version: 1 as const,
			locale: "es-MX",
			title: "Ayudante",
			subtitle: "Tu asistente",
			product: "Mi taller",
			conversationStarters: ["¿Qué sigue?"],
		};
		expect(
			resolveTediWidgetConfig({
				name: "Ignored",
				metadata: { tediWidget: published },
			}),
		).toMatchObject(published);
	});

	it("fills newly configurable appearance defaults into older published profiles", () => {
		const config = resolveTediWidgetConfig({
			name: "Acme",
			metadata: {
				tediWidget: {
					version: 1,
					title: "Helper",
					subtitle: "Ready",
					product: "Acme",
					conversationStarters: [],
				},
			},
		});
		expect(config.title).toBe("Helper");
		expect(config.accentColor).toBe("#2557d6");
		expect(config.launcherMode).toBe("default");
		expect(config.analyticsEnabled).toBe(false);
	});
});
