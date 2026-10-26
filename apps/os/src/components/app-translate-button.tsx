import { Translate } from "@phosphor-icons/react";
import { Button } from "@/components/kumo/button";
import type { AppRuntimeTranslation } from "@/lib/app-runtime-translation";

/** A language's own name for itself ("Deutsch", "English"), or its code. */
export function languageName(code: string): string {
	try {
		return new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
	} catch {
		return code;
	}
}

/**
 * Translate for a runtime app, in the host's header row. It names the
 * language a click switches to, each in its own words, so it needs no
 * wording of its own: the viewer's language, then the app's original.
 */
export function AppTranslateButton({
	translation,
	compact = false,
}: {
	translation: AppRuntimeTranslation;
	/** Icon only below the small breakpoint. */
	compact?: boolean;
}) {
	const { available, source, target, status, toggle } = translation;
	if (!available || !source) return null;
	const on = status.state !== "original" && status.state !== "unavailable";
	const label = languageName(on ? source : target);
	const progress =
		status.state === "downloading"
			? ` ${Math.round(status.progress * 100)} %`
			: "";
	return (
		<Button
			variant="ghost"
			size="sm"
			aria-pressed={on}
			aria-busy={
				status.state === "downloading" || status.state === "translating"
			}
			aria-label={label}
			title={label}
			lang={on ? source : target}
			translate="no"
			data-app-translate={status.state}
			onClick={() => void toggle()}
		>
			<Translate size={16} aria-hidden />
			<span className={compact ? "sr-only sm:not-sr-only" : undefined}>
				{label}
				{progress}
			</span>
		</Button>
	);
}
