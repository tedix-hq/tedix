import escapeClient from "./app-runtime-escape-client.js?raw";
import starterClient from "../../../plugins/tedix/skills/tedix-build-app/assets/sheet-review/client.js?raw";
import starterManifest from "../../../plugins/tedix/skills/tedix-build-app/assets/sheet-review/manifest.json";
import { createRoot } from "react-dom/client";
import { AppRuntimeFrame } from "../src/components/app-runtime-frame";
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
const starter = new URLSearchParams(location.search).has("starter");
const html = buildAppRuntimeDocument({
	"server.js": "",
	"client.js": new URLSearchParams(location.search).has("escape")
		? `const destination = ${JSON.stringify(new URLSearchParams(location.search).get("destination"))};\n${escapeClient}`
		: starter
			? starterClient
			: `
const root = document.getElementById('app');
const status = document.createElement('p');
status.setAttribute('role', 'status');
const button = document.createElement('button');
button.textContent = 'Hilfreich';
button.onclick = async () => {
  try {
    await tedix.call('app.call', { method: 'rate', args: [{ cardId: 'one', decision: 'Hilfreich' }] });
    status.textContent = JSON.stringify(await tedix.call('app.call', { method: 'ratings', args: [] }));
  } catch (error) { status.textContent = error.message; }
};
root.append(button, status);
`,
});
createRoot(document.getElementById("root")!).render(
	<AppRuntimeFrame
		html={html}
		title="Rating app"
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
	/>,
);
