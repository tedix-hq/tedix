import { useEffect, useState } from "react";
import {
	descopeFlowErrorMessage,
	type DescopeByosContext,
	type DescopeFlowNext,
} from "./descope-byos-contract";

/**
 * The one interaction driver for Tedix BYOS screens (login, OTP): tracks
 * which interaction is pending, surfaces a human error when `next` throws,
 * and releases the pending state when the flow reports an error through
 * context instead — Descope's `next` resolves after handing control back to
 * the flow even when the resulting context carries an authentication error,
 * so without the release buttons would stay stuck disabled.
 */
export function useByosAdvance({
	context,
	errorMessage,
	logLabel,
	next,
}: {
	context?: DescopeByosContext;
	errorMessage: string;
	logLabel: string;
	next: DescopeFlowNext;
}) {
	const [pending, setPending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (!context?.error) return;
		setPending(null);
	}, [context?.error]);
	const advance = async (
		interactionId: string,
		form: Record<string, unknown> = {},
		options: { releaseOnResolve?: boolean } = {},
	) => {
		setPending(interactionId);
		setError(null);
		try {
			await next(interactionId, form);
			// Most interactions transition away or report a new context, which owns
			// release of the pending state. A successful same-screen interaction has
			// neither signal, so its caller must opt in to releasing on resolution.
			if (options.releaseOnResolve) setPending(null);
		} catch (cause) {
			console.error(logLabel, cause);
			setError(errorMessage);
			setPending(null);
		}
	};
	return { advance, error, pending };
}

/** The shared error line under every BYOS screen: local error first, then the flow's own. */
export function ByosFlowError({
	context,
	error,
}: {
	context?: DescopeByosContext;
	error: string | null;
}) {
	const message = error ?? descopeFlowErrorMessage(context?.error);
	if (!message) return null;
	return (
		<p role="alert" className="identity-flow-error">
			{message}
		</p>
	);
}
