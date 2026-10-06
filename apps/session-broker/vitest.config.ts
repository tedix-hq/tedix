import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig({
	plugins: [
		cloudflareTest({
			experimental: { newConfig: true },
			remoteBindings: false,
			miniflare: {
				// The config binds both classes by this Worker's name. The pool runs the
				// Worker under its own runner name, so bind them as local classes.
				durableObjects: {
					SESSION_ROTATION: {
						className: "SessionRotationOwner",
						useSQLite: true,
					},
					SESSION_INTENTS: { className: "SessionIntentOwner", useSQLite: true },
				},
				// Tests must not inherit private deployment values or export placeholders.
				bindings: {
					DESCOPE_BASE_URL: "https://auth.tedix.dev",
					DESCOPE_PROJECT_ID: "test-project",
					GIT_SHA: "test-release-sha",
				},
			},
		}),
	],
	test: {
		globals: true,
		include: ["src/**/*.test.ts"],
	},
});
