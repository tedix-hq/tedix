import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { useCallback, useMemo, useRef, useState } from "react";
import {
	APP_RUNTIME_DETECT_LANGUAGE_METHOD,
	APP_RUNTIME_LANGUAGE_METHOD,
	APP_RUNTIME_TRANSLATE_METHOD,
	APP_RUNTIME_TRANSLATION_METHOD,
	type AppRuntimeTranslateParams,
	type AppRuntimeTranslationStatus,
	appRuntimeGlossary,
} from "@/lib/app-runtime-host";

/**
 * The host half of Translate for a runtime app: the app frame attaches its
 * message port here, the header button reads `available` and calls `toggle`.
 * The app's language is `settings.locale`, else what the browser's language
 * detector finds in the app's text; the target is the viewer's browser
 * language. Nothing is shown where the browser has no on-device translator.
 */
export interface AppRuntimeTranslationChannel {
	/** The frame's post function once the app document is ready; null when it goes. */
	attach: (post: ((message: unknown) => void) | null) => void;
	receive: (method: string, params: unknown) => void;
}

export interface AppRuntimeTranslation {
	channel: AppRuntimeTranslationChannel;
	available: boolean;
	/** The app's language and the viewer's, as primary language subtags. */
	source: string | null;
	target: string;
	status: AppRuntimeTranslationStatus;
	toggle: () => Promise<void>;
}

type TranslatorFactory = {
	create: (options: {
		sourceLanguage: string;
		targetLanguage: string;
		monitor?: (monitor: EventTarget) => void;
	}) => Promise<unknown>;
};

const primary = (tag: string) => (tag.split("-")[0] ?? tag).toLowerCase();

function browserTranslator(): TranslatorFactory | null {
	if (typeof window === "undefined") return null;
	return (window as { Translator?: TranslatorFactory }).Translator ?? null;
}

function isStatus(value: unknown): value is AppRuntimeTranslationStatus {
	return (
		typeof value === "object" &&
		value !== null &&
		[
			"downloading",
			"translating",
			"translated",
			"original",
			"unavailable",
		].includes((value as { state?: unknown }).state as string)
	);
}

export function useAppRuntimeTranslation(
	settings: Record<string, JsonValue>,
): AppRuntimeTranslation {
	const locale =
		typeof settings.locale === "string" && settings.locale
			? primary(settings.locale)
			: null;
	const [detected, setDetected] = useState<string | null>(null);
	const [status, setStatus] = useState<AppRuntimeTranslationStatus>({
		state: "original",
	});
	const port = useRef<((message: unknown) => void) | null>(null);
	const needsDetection = useRef(!locale);
	needsDetection.current = !locale;
	const target = primary(
		typeof navigator === "undefined" ? "en" : navigator.language,
	);
	const source = locale ?? detected;

	const channel = useMemo<AppRuntimeTranslationChannel>(
		() => ({
			attach: (post) => {
				port.current = post;
				setStatus({ state: "original" });
				if (post && needsDetection.current && "LanguageDetector" in window)
					post({ jsonrpc: "2.0", method: APP_RUNTIME_DETECT_LANGUAGE_METHOD });
			},
			receive: (method, params) => {
				if (method === APP_RUNTIME_LANGUAGE_METHOD) {
					const language = (params as { language?: unknown } | null)?.language;
					setDetected(typeof language === "string" ? primary(language) : null);
				} else if (
					method === APP_RUNTIME_TRANSLATION_METHOD &&
					isStatus(params)
				)
					setStatus(params);
			},
		}),
		[],
	);

	const toggle = useCallback(async () => {
		const send = (params: AppRuntimeTranslateParams) =>
			port.current?.({
				jsonrpc: "2.0",
				method: APP_RUNTIME_TRANSLATE_METHOD,
				params,
			});
		const translator = browserTranslator();
		if (!source || !translator) return;
		if (status.state !== "original" && status.state !== "unavailable") {
			send({ source, target: null });
			return;
		}
		setStatus({ state: "translating", language: target });
		// The browser fetches a language pack only from a click, and the click
		// lands here, not in the sandboxed app; the app then finds it ready.
		try {
			await translator.create({
				sourceLanguage: source,
				targetLanguage: target,
				monitor: (monitor) =>
					monitor.addEventListener("downloadprogress", (event) =>
						setStatus({
							state: "downloading",
							progress: (event as ProgressEvent).loaded,
						}),
					),
			});
		} catch {
			// The app's own attempt reports what this browser can do.
		}
		send({ source, target, glossary: appRuntimeGlossary(settings, target) });
	}, [settings, source, status.state, target]);

	return {
		channel,
		available: Boolean(browserTranslator() && source && source !== target),
		source,
		target,
		status,
		toggle,
	};
}
