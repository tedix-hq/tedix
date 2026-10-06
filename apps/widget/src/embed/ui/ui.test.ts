import { buildTranslate } from "@tedix/widget-i18n";
import enCatalog from "@tedix/widget-i18n/en.json";
import esCatalog from "@tedix/widget-i18n/es.json";
import { describe, expect, it } from "vite-plus/test";
import {
	embeddedApprovalLabel,
	embeddedConnectionLabel,
	embeddedConnectionMarkup,
	numericMountOption,
	embeddedSessionFailureLabel,
	embeddedTediBaseStyles,
} from "./index";
import { embeddedTediStyles } from "./styles";

describe("framework-neutral Tedi embed primitives", () => {
	it("inherits the canonical widget control and radius tokens", () => {
		expect(embeddedTediBaseStyles).toContain("--tedix-touch-target: 2.75rem");
		expect(embeddedTediBaseStyles).toContain("--tedix-radius-full: 9999px");
		expect(embeddedTediBaseStyles).toContain("prefers-reduced-motion");
	});

	it("owns the complete isolated chat skin and validates host accents", () => {
		const styles = embeddedTediStyles("red; } body { display:none");
		expect(styles).toContain("--tedix-accent: #2557d6");
		expect(styles).not.toContain("body { display:none");
		for (const primitive of [
			"message",
			"activity",
			"approval",
			"widget-frame",
			"composer-wrap",
		]) {
			expect(styles).toContain(`.tedix-${primitive}`);
		}
		expect(styles).toContain("max-width: 600px");
		expect(styles).toContain(".tedix-launcher-mark");
		expect(styles).toContain(
			".tedix-launcher-mark:has(.tedix-brand-image) { border: 0; background: transparent; }",
		);
		expect(styles).not.toContain(".tedix-attention-dot");
		expect(styles).not.toContain(".tedix-launcher-count");
		expect(styles).not.toContain(".tedix-attention-item");
		expect(styles).toContain(
			".tedix-message-assistant { flex-direction: column; align-items: stretch; }",
		);
		expect(styles).not.toContain(".tedix-attention-loading");
		expect(styles).toContain(".tedix-panel[data-history] .tedix-history-bar");
		expect(styles).toContain(
			'.tedix-history-item[data-active="true"] { background: var(--tedix-soft); }',
		);
		expect(styles).toContain(".tedix-panel[data-history] .tedix-context");
		expect(styles).toContain("--tedix-viewport-height: 100dvh");
		expect(styles).toContain("height: var(--tedix-viewport-height)");
		expect(styles).toContain(
			":host([data-keyboard-open]) .tedix-composer-wrap { padding-bottom: 0; }",
		);
		expect(styles).toContain(
			":host([data-keyboard-open]) .tedix-footer { display: none; }",
		);
		expect(styles).toContain(
			"@media (pointer: coarse) { .tedix-input { font-size: 16px; } }",
		);
	});

	it("keeps explicit host themes authoritative and avoids light-only control fills", () => {
		const styles = embeddedTediStyles("#2557d6");
		expect(styles).toContain(':host([data-theme="dark"])');
		expect(styles).toContain(':host([data-theme="light"])');
		expect(styles).toContain(':host:not([data-theme="light"])');
		expect(styles).toContain(
			"background: color-mix(in srgb, var(--tedix-accent) 6%, var(--tedix-bg))",
		);
		expect(styles).not.toContain(
			"background: color-mix(in srgb, var(--tedix-accent) 3%, white)",
		);
		expect(styles).toContain("border: 2px solid var(--tedix-bg)");
		expect(styles).toContain(
			".tedix-input::placeholder { color: var(--tedix-muted)",
		);
	});

	it("bounds configurable placement, stacking, and dark accents", () => {
		const styles = embeddedTediStyles("#112233", {
			accentDark: "#ddeeff",
			position: "bottom-left",
			horizontalOffset: 500,
			bottomOffset: -1,
			zIndex: 99,
		});
		expect(styles).toContain("--tedix-accent-dark: #ddeeff");
		expect(styles).toContain("left: 120px; right: auto;");
		expect(styles).toContain("bottom: 8px");
		expect(styles).toContain("z-index: 99");
		expect(styles).toContain(".tedix-brand-image[data-theme-dark]");
	});

	it("renders the recording stop control as a filled square", () => {
		const styles = embeddedTediStyles("#2557d6");
		expect(styles).toContain(
			'.tedix-form[data-voice-state="recording"] .tedix-voice svg { fill: currentColor; stroke: none; }',
		);
	});

	it("yields to host modal interaction layers", () => {
		const styles = embeddedTediStyles("#2557d6");
		expect(styles).toContain(':host([aria-hidden="true"])');
		expect(styles).toContain(":host([inert])");
		expect(styles).toContain(":host([data-base-ui-inert])");
		expect(styles).toContain("visibility: hidden; pointer-events: none");
	});

	it("keeps thinking text-only and gives voice the full composer waveform", () => {
		const styles = embeddedTediStyles("#2557d6");
		expect(styles).not.toContain(".tedix-thinking-shimmer");
		expect(styles).toContain(
			".tedix-voice-wave { display: flex; width: min(100%, 420px); height: 34px",
		);
		expect(styles).toContain(".tedix-voice-wave i { width: 3px; height: 4px");
		expect(styles).toContain(
			"transition: height 160ms cubic-bezier(.22, 1, .36, 1), opacity 160ms ease-out",
		);
		expect(styles).not.toContain("tedix-wave-pulse");
		expect(styles).toContain(".tedix-voice-error[hidden] { display: none; }");
	});

	it("renders a semantic live connection status from the catalog", () => {
		const es = buildTranslate(esCatalog, enCatalog);
		const en = buildTranslate(enCatalog, enCatalog);
		expect(embeddedConnectionMarkup("webmcp", es)).toContain('role="status"');
		expect(embeddedConnectionMarkup("webmcp", es)).toContain(
			'data-state="webmcp"',
		);
		expect(embeddedConnectionLabel("webmcp", es)).toBe("Página conectada");
		expect(embeddedConnectionLabel("error", es)).toBe("Sin conexión");
		expect(embeddedConnectionLabel("webmcp", en)).toBe("Page connected");
		expect(embeddedSessionFailureLabel("capacity_unavailable", es)).toBe(
			"La capacidad no está disponible temporalmente.",
		);
		// A locale that translated nothing still reads, in the source language.
		expect(
			embeddedSessionFailureLabel(
				"session_unavailable",
				buildTranslate({}, enCatalog),
			),
		).toBe("{{assistant}} could not connect.");
	});

	it("centralizes approval states used by the embed", () => {
		const es = buildTranslate(esCatalog, enCatalog);
		expect(embeddedApprovalLabel("saving", es)).toBe("Guardando tu decisión…");
		expect(embeddedApprovalLabel("rejected", es)).toBe("Rechazado");
		expect(embeddedApprovalLabel("saving", buildTranslate(enCatalog))).toBe(
			"Saving your decision…",
		);
	});

	it("styles the shared conversation renderer's code, prompt, and activity chrome", () => {
		const styles = embeddedTediStyles("#2557d6");
		expect(styles).toContain(".tedix-md-code-bar");
		expect(styles).toContain(".tedix-md-copy");
		expect(styles).toContain(".tedix-prompt:hover");
		expect(styles).toContain(".tedix-activities:empty { display: none; }");
		expect(styles).toContain('.tedix-md-link[href^="/"]');
	});
});

describe("numericMountOption", () => {
	/**
	 * The regression: `Number(value) || fallback` rewrote a valid 0 to the
	 * default, so a host could not place the launcher flush to the edge and
	 * `zIndex: 0` was unreachable.
	 */
	it("honours an explicitly configured zero", () => {
		expect(numericMountOption(0, 22)).toBe(0);
		expect(numericMountOption("0", 22)).toBe(0);
	});

	it("still falls back for absent or unparseable values", () => {
		expect(numericMountOption(undefined, 22)).toBe(22);
		expect(numericMountOption(null, 22)).toBe(22);
		expect(numericMountOption("", 22)).toBe(22);
		expect(numericMountOption("flush", 22)).toBe(22);
		expect(numericMountOption(Number.NaN, 22)).toBe(22);
		expect(numericMountOption(Number.POSITIVE_INFINITY, 22)).toBe(22);
	});

	it("passes ordinary values through", () => {
		expect(numericMountOption(40, 22)).toBe(40);
		expect(numericMountOption("2147483000", 0)).toBe(2_147_483_000);
	});
});
