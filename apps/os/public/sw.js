// No offline cache: tenant data and authentication stay on the network.
self.addEventListener("activate", (event) =>
	event.waitUntil(self.clients.claim()),
);
self.addEventListener("push", (event) => {
	event.waitUntil(
		(async () => {
			let data;
			try {
				data = event.data?.json();
			} catch {
				return;
			}
			if (
				!data ||
				typeof data.title !== "string" ||
				typeof data.body !== "string"
			)
				return;
			const clients = await self.clients.matchAll({
				type: "window",
				includeUncontrolled: true,
			});
			const visible = await Promise.all(
				clients
					.filter((client) => client.visibilityState === "visible")
					.map(
						(client) =>
							new Promise((resolve) => {
								const channel = new MessageChannel();
								const timer = setTimeout(() => {
									channel.port1.close();
									resolve(false);
								}, 250);
								channel.port1.onmessage = (event) => {
									clearTimeout(timer);
									channel.port1.close();
									resolve(event.data?.conversationId === data.conversationId);
								};
								client.postMessage(
									{
										type: "tedix-push-visible",
										conversationId: data.conversationId,
									},
									[channel.port2],
								);
							}),
					),
			);
			if (visible.some(Boolean)) return;
			await self.registration.showNotification(data.title, {
				body: data.body,
				icon: "/icon-192.png",
				badge: "/icon-192.png",
				tag: data.tag,
				data: { url: "/work?view=deck" },
			});
		})(),
	);
});
self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	event.waitUntil(
		(async () => {
			const url = new URL("/work?view=deck", self.location.origin).href;
			const clients = await self.clients.matchAll({
				type: "window",
				includeUncontrolled: true,
			});
			const client = clients.find(
				(client) => new URL(client.url).origin === self.location.origin,
			);
			if (client) {
				await client.navigate(url);
				await client.focus();
			} else await self.clients.openWindow(url);
		})(),
	);
});
