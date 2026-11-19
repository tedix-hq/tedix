import escapeClient from "./app-runtime-escape-client.js?raw";
import starterClient from "../../../plugins/tedix/skills/tedix-build-app/assets/sheet-review/client.js?raw";
import starterManifest from "../../../plugins/tedix/skills/tedix-build-app/assets/sheet-review/manifest.json";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppRuntimeErrorBar } from "../src/components/app-runtime-errors";
import { AppRuntimeFrame } from "../src/components/app-runtime-frame";
import {
	addAppRuntimeError,
	EMPTY_APP_RUNTIME_ERROR_LOG,
} from "../src/lib/app-runtime-protocol";
import {
	buildAppRuntimeDocument,
	handleAppRuntimeCall,
} from "../src/lib/app-runtime-host";
import { createAppRuntimeServerCall } from "../src/lib/app-runtime-session";
import { osApi, osAppRuntimeCall } from "../src/lib/api";

const callServer = createAppRuntimeServerCall(
	{ open: osApi.osAppRuntime.open, call: osAppRuntimeCall },
	{
		workspaceId: "11111111-1111-4111-8111-111111111111",
		gadgetId: "22222222-2222-4222-8222-222222222222",
		revisionId: "33333333-3333-4333-8333-333333333333",
	},
);
const params = new URLSearchParams(location.search);
const starter = params.has("starter");
// Fails in the three ways the host hears about; the throw is on line 5.
const errorsClient = [
	"const root = document.getElementById('app');",
	"root.textContent = 'Broken on purpose';",
	"console.error('Could not load', { sheet: 'cards' });",
	"Promise.reject(new Error('not_permitted'));",
	"setTimeout(() => { throw new TypeError('rows is undefined'); }, 0);",
].join("\n");
const html = buildAppRuntimeDocument({
	"server.js": "",
	"client.js": params.has("errors")
		? errorsClient
		: params.has("escape")
			? `const destination = ${JSON.stringify(params.get("destination"))};\n${escapeClient}`
			: starter
				? starterClient
				: "",
});
function Host() {
	const [errors, setErrors] = useState(EMPTY_APP_RUNTIME_ERROR_LOG);
	return (
		<>
			<AppRuntimeErrorBar
				log={errors}
				onDismiss={() => setErrors(EMPTY_APP_RUNTIME_ERROR_LOG)}
			/>
			<output data-app-errors hidden>
				{JSON.stringify(errors.recent)}
			</output>
			<AppRuntimeFrame
				html={html}
				title="Rating app"
				onError={(error) => setErrors((log) => addAppRuntimeError(log, error))}
				onCall={(method, args) =>
					handleAppRuntimeCall(
						{
							context: {
								workspaceId: "11111111-1111-4111-8111-111111111111",
								gadget: {
									id: "22222222-2222-4222-8222-222222222222",
									name: "Rating app",
									revision: 1,
								},
								role: "use",
								settings: starter ? starterManifest.config.settings : {},
								grants: starter ? starterManifest.resourceGrants : [],
							},
							resources: [],
							readOutput: async () => {
								throw new Error("No Output grant");
							},
							callServer,
						},
						method,
						args,
					)
				}
			/>
		</>
	);
}
createRoot(document.getElementById("root")!).render(<Host />);
