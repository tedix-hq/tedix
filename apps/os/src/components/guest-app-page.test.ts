import { WIDGET_CATALOGS } from "@tedix/widget-i18n/catalogs";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { guestCopy } from "@/components/guest-app-page";

const de = WIDGET_CATALOGS.de as Record<string, string>;
const en = WIDGET_CATALOGS.en as Record<string, string>;

describe("guestCopy", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("speaks the organization's visitor language over the guest's browser", () => {
		vi.stubGlobal("navigator", { language: "en-US" });
		const { locale, t } = guestCopy({
			name: "Example",
			logoUrl: null,
			locale: "de-DE",
		});
		expect(locale).toBe("de-DE");
		expect(t("share_can_use")).toBe(de.share_can_use);
	});

	it("follows the guest's browser when the organization set no language", () => {
		vi.stubGlobal("navigator", { language: "es-MX" });
		expect(guestCopy(null).t("share_opening_app")).toBe(
			WIDGET_CATALOGS.es?.share_opening_app,
		);
		vi.stubGlobal("navigator", { language: "ja-JP" });
		expect(guestCopy(null).t("share_can_use")).toBe(en.share_can_use);
	});

	it("puts the organization's own wording above the catalog, exact locale first", () => {
		const { t } = guestCopy({
			name: "Example",
			logoUrl: null,
			locale: "de-AT",
			copy: {
				de: { share_can_use: "Darf nutzen", share_no_sign_in: "Ohne Konto" },
				"de-AT": { share_can_use: "Darf verwenden" },
			},
		});
		expect(t("share_can_use")).toBe("Darf verwenden");
		expect(t("share_no_sign_in")).toBe("Ohne Konto");
		expect(t("share_opening_app")).toBe(de.share_opening_app);
	});
});
