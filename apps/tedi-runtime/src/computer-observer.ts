import type {
	WorkspaceAttributes,
	WorkspaceAttributeValue,
	WorkspaceObserver,
	WorkspaceSpan,
} from "@cloudflare/computer";

const SAFE_STRING_ATTRIBUTES = new Set([
	"error.name",
	"workspace.backend.id",
	"workspace.backend.type",
	"workspace.shell.encoding",
	"workspace.sync.backend",
]);

const SAFE_SPAN_NAME = /^workspace\.[a-zA-Z.]{1,54}$/;

/**
 * Cloudflare Computer can emit paths, grep patterns, symlink targets, cwd
 * values, and bounded error messages. Those values are useful while debugging
 * the substrate but can contain tenant data, source text, or credentials.
 *
 * Tedix records only operation shape and mechanical counts in platform traces.
 * Canonical, tenant-visible evidence stays in the Tedix runtime ledger and
 * Artifacts rather than leaking through infrastructure trace attributes.
 */
export function createPrivacySafeComputerObserver(
	inner: WorkspaceObserver,
): WorkspaceObserver {
	return {
		span(name, attributes, run) {
			const safeName = SAFE_SPAN_NAME.test(name) ? name : "workspace.operation";
			return inner.span(safeName, sanitizeAttributes(attributes), (span) =>
				run(createSanitizedSpan(span)),
			);
		},
	};
}

function createSanitizedSpan(inner: WorkspaceSpan): WorkspaceSpan {
	return {
		setAttribute(key, value) {
			const safe = sanitizeAttribute(key, value);
			if (safe !== undefined) inner.setAttribute(key, safe);
		},
	};
}

function sanitizeAttributes(
	attributes: WorkspaceAttributes,
): WorkspaceAttributes {
	return Object.fromEntries(
		Object.entries(attributes).flatMap(([key, value]) => {
			const safe = sanitizeAttribute(key, value);
			return safe === undefined ? [] : [[key, safe]];
		}),
	);
}

function sanitizeAttribute(
	key: string,
	value: WorkspaceAttributeValue | undefined,
): WorkspaceAttributeValue | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number" || typeof value === "boolean") return value;
	return SAFE_STRING_ATTRIBUTES.has(key) ? value.slice(0, 64) : undefined;
}
