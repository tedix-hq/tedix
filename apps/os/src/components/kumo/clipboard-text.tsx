import { ClipboardText as KumoClipboardText } from "@cloudflare/kumo/components/clipboard-text";
import type { ComponentProps } from "react";

/**
 * Console's copyable value. Prefer this over a hand-rolled
 * `navigator.clipboard.writeText` button so copy affordances share one
 * confirmation animation, one tooltip contract, and one accessible label set.
 */
const ClipboardText = KumoClipboardText;

export { ClipboardText };
