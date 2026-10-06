import type { Translate } from "@tedix/widget-i18n";
import {
	widgetCssVariables,
	widgetHostCssVariables,
} from "@tedix/design-tokens/widget";

/** Framework-neutral UI primitives for the one-script Tedi Shadow DOM. */
export const embeddedTediBaseStyles = `
	:host {
		${Object.entries({
			...widgetHostCssVariables.radius,
			...widgetHostCssVariables.fontWeight,
		})
			.map(([name, value]) => `${name}: ${value};`)
			.join("\n")}
		--tedix-radius-sm: ${widgetCssVariables.radius.sm};
		--tedix-radius-md: ${widgetCssVariables.radius.md};
		--tedix-radius-lg: ${widgetCssVariables.radius.lg};
		--tedix-radius-xl: ${widgetCssVariables.radius.xl};
		--tedix-radius-2xl: ${widgetCssVariables.radius["2xl"]};
		--tedix-radius-full: ${widgetCssVariables.radius.full};
		--tedix-control-sm: ${widgetCssVariables.control.heightSm};
		--tedix-control-md: ${widgetCssVariables.control.heightMd};
		--tedix-touch-target: ${widgetCssVariables.control.touchTarget};
		--tedix-font-medium: ${widgetCssVariables.fontWeight.medium};
		--tedix-font-semibold: ${widgetCssVariables.fontWeight.semibold};
	}
	.tedix-status {
		display: inline-flex; min-height: 22px; align-items: center; gap: 6px;
		padding: 3px 8px; border: 1px solid var(--tedix-border);
		border-radius: var(--tedix-radius-full); background: var(--tedix-bg);
		color: var(--tedix-muted); font-size: 10px;
		font-weight: var(--tedix-font-medium); line-height: 1; white-space: nowrap;
	}
	.tedix-status-dot { width: 7px; height: 7px; border-radius: var(--tedix-radius-full); background: #a1a1aa; }
	.tedix-status[data-state="connecting"] .tedix-status-dot { background: #f59e0b; animation: tedix-status-pulse 1.2s ease-in-out infinite; }
	.tedix-status[data-state="connected"] .tedix-status-dot,
	.tedix-status[data-state="webmcp"] .tedix-status-dot { background: #22a06b; }
	.tedix-status[data-state="error"] .tedix-status-dot { background: #dc2626; }
	@keyframes tedix-status-pulse { 50% { opacity: .35; } }
	@media (prefers-reduced-motion: reduce) {
		.tedix-status[data-state="connecting"] .tedix-status-dot { animation: none; }
	}
`;

export type EmbeddedConnectionState =
	| "idle"
	| "connecting"
	| "connected"
	| "webmcp"
	| "error";

export function embeddedConnectionLabel(
	state: EmbeddedConnectionState,
	t: Translate,
): string {
	switch (state) {
		case "connecting":
			return t("connecting");
		case "connected":
			return t("connected");
		case "webmcp":
			return t("page_connected");
		case "error":
			return t("offline");
		default:
			return t("ready");
	}
}

export function embeddedConnectionMarkup(
	state: EmbeddedConnectionState,
	t: Translate,
): string {
	return `<span class="tedix-status" data-state="${state}" role="status"><span class="tedix-status-dot" aria-hidden="true"></span><span class="tedix-status-label">${embeddedConnectionLabel(state, t)}</span></span>`;
}

export function embeddedSessionFailureLabel(
	code: string | null,
	t: Translate,
): string {
	return code === "capacity_unavailable"
		? t("capacity_unavailable")
		: t("could_not_connect");
}

export function embeddedApprovalLabel(
	state: "pending" | "approved" | "rejected" | "saving" | "error",
	t: Translate,
): string {
	switch (state) {
		case "approved":
			return t("approved");
		case "rejected":
			return t("rejected");
		case "saving":
			return t("saving_your_decision");
		case "error":
			return t("could_not_save_try_again");
		default:
			return t("confirmation_required");
	}
}

/**
 * Read a numeric mount option, honouring an explicitly configured `0`.
 *
 * `Number(value) || fallback` silently rewrites a valid zero to the default,
 * so a host asking for a flush-edge launcher (`horizontalOffset: 0`) got the
 * 22px inset instead, with no way to override it. `zIndex: 0` was unreachable
 * for the same reason. Empty string and null stay "unset" — those mean absent,
 * not zero — but any finite number is taken at its word.
 */
export function numericMountOption(value: unknown, fallback: number): number {
	if (value === null || value === undefined || value === "") return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}
