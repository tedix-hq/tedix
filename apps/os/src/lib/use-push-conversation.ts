import { useEffect, useRef } from "react";

/** A visible chat renews a short lease; closing or hiding it clears the lease. */
export function usePushConversation(conversationId: string | null) {
	const element = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (
			!conversationId ||
			!("serviceWorker" in navigator) ||
			!("Notification" in window) ||
			Notification.permission !== "granted"
		)
			return;
		const clientId = crypto.randomUUID();
		const publish = (id: string | null) => {
			void import("./api")
				.then(({ osApi }) =>
					osApi.webPush.setVisibility({ clientId, conversationId: id }),
				)
				.catch(() => undefined);
		};
		let inView = false;
		const visible = () => inView && document.visibilityState === "visible";
		const update = () => publish(visible() ? conversationId : null);
		const observer = new IntersectionObserver((entries) => {
			inView = entries.some((entry) => entry.isIntersecting);
			update();
		});
		if (element.current) observer.observe(element.current);
		const answer = (event: MessageEvent) => {
			if (
				event.data?.type === "tedix-push-visible" &&
				event.data.conversationId === conversationId &&
				visible()
			)
				event.ports[0]?.postMessage({ conversationId });
		};
		update();
		const timer = window.setInterval(update, 30_000);
		document.addEventListener("visibilitychange", update);
		navigator.serviceWorker.addEventListener("message", answer);
		return () => {
			window.clearInterval(timer);
			observer.disconnect();
			document.removeEventListener("visibilitychange", update);
			navigator.serviceWorker.removeEventListener("message", answer);
			publish(null);
		};
	}, [conversationId]);
	return element;
}
