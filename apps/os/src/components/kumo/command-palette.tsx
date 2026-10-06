import { CommandPalette as KumoCommandPalette } from "@cloudflare/kumo/components/command-palette";

/**
 * App-local entrypoint for Kumo's keyboard-first command surface. Product
 * route and resource ownership stays local; Kumo supplies accessible behavior.
 */
const CommandPalette = KumoCommandPalette;

export { CommandPalette };
