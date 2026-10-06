import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { errorMessage, isNotFoundError } from "@/lib/orpc-error";

/**
 * The failure state of a detail route whose identity read produced no resource.
 *
 * Detail routes used to await their identity read inside the loader, so a
 * missing resource surfaced as the route ERROR boundary and a SLOW read parked
 * the navigation on the pending screen past the stall watchdog. Both now land
 * on the page and let the component's own query decide, which makes this the
 * single place the two outcomes are told apart:
 *
 * - `NOT_FOUND` from the server is evidence of absence. Say so plainly, and
 *   without the destructive styling of an outage — a deleted resource is a
 *   normal state, not a fault.
 * - Anything else — a timeout, an aborted request, an authorization refusal, a
 *   500 — is silence about existence. It must NEVER be reported as "not found";
 *   the resource may be perfectly intact behind a cold isolate.
 *
 * A read that is merely still in flight never reaches here: the component
 * renders its pending skeleton until the read actually settles.
 */
export function DetailUnavailable({
	resource,
	error,
}: {
	/** Capitalized singular noun for the addressed resource, e.g. "Output". */
	resource: string;
	error: unknown;
}) {
	if (isNotFoundError(error)) {
		return (
			<Alert>
				<AlertTitle>{resource} not found</AlertTitle>
				<AlertDescription>
					No {resource.toLowerCase()} exists at this address. It may have been
					deleted, or the link may be wrong.
				</AlertDescription>
			</Alert>
		);
	}
	return (
		<Alert variant="destructive">
			<AlertTitle>{resource} is unavailable</AlertTitle>
			<AlertDescription>{errorMessage(error)}</AlertDescription>
		</Alert>
	);
}
