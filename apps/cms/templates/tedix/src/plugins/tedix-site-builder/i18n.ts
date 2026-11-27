import { i18n, type Messages } from "@lingui/core";

// Compiled Lingui catalogs: native plugins do not run the host macro build.
const en: Messages = {
	"Back to Tedix": ["Back to Tedix"],
	"Code and deployments": ["Code and deployments"],
	"Open Sites": ["Open Sites"],
	"Generated search text": ["Generated search text"],
	"No search text yet.": ["No search text yet."],
	"This text is generated when page sections are saved. Edit the sections to update it.":
		[
			"This text is generated when page sections are saved. Edit the sections to update it.",
		],
	"Edit content, media, menus and site settings in EmDash. Use the content editor to preview and publish changes.":
		[
			"Edit content, media, menus and site settings in EmDash. Use the content editor to preview and publish changes.",
		],
	"For theme code, domains and deployments, open Sites in your Tedix workspace.":
		[
			"For theme code, domains and deployments, open Sites in your Tedix workspace.",
		],
	"Publish deliveries": ["Publish deliveries"],
	"Publishing is independent of memory sync and newsletter delivery. Failed deliveries retry automatically up to eight times. Sent means the provider accepted the request.":
		[
			"Publishing is independent of memory sync and newsletter delivery. Failed deliveries retry automatically up to eight times. Sent means the provider accepted the request.",
		],
	"Refresh deliveries": ["Refresh deliveries"],
	"Memory sync": ["Memory sync"],
	Newsletter: ["Newsletter"],
	"Retry delivery": ["Retry delivery"],
	"Loading delivery status…": ["Loading delivery status…"],
	"For plain webhooks, use the Webhook Notifier plugin.": [
		"For plain webhooks, use the Webhook Notifier plugin.",
	],
	"Delivery status unavailable. Administrator access is required.": [
		"Delivery status unavailable. Administrator access is required.",
	],
	"Delivery status unavailable.": ["Delivery status unavailable."],
	"Could not queue the retry. Refresh and try again.": [
		"Could not queue the retry. Refresh and try again.",
	],
	"Retry unavailable.": ["Retry unavailable."],
	"{pending} pending · {failed} failed": [
		["pending"],
		" pending · ",
		["failed"],
		" failed",
	],
	"{attempts} attempts": [["attempts"], " attempts"],
};

const de: Messages = {
	"Back to Tedix": ["Zurück zu Tedix"],
	"Code and deployments": ["Code und Bereitstellungen"],
	"Open Sites": ["Sites öffnen"],
	"Generated search text": ["Automatisch erzeugter Suchtext"],
	"No search text yet.": ["Noch kein Suchtext vorhanden."],
	"This text is generated when page sections are saved. Edit the sections to update it.":
		[
			"Dieser Text wird beim Speichern der Seitenabschnitte erzeugt. Bearbeite die Abschnitte, um ihn zu aktualisieren.",
		],
	"Edit content, media, menus and site settings in EmDash. Use the content editor to preview and publish changes.":
		[
			"Bearbeite Inhalte, Medien, Menüs und Website-Einstellungen in EmDash. Im Inhaltseditor kannst du Änderungen in der Vorschau ansehen und veröffentlichen.",
		],
	"For theme code, domains and deployments, open Sites in your Tedix workspace.":
		[
			"Öffne Sites in deinem Tedix-Arbeitsbereich, um Theme-Code, Domains und Bereitstellungen zu verwalten.",
		],
	"Publish deliveries": ["Zustellungen nach Veröffentlichung"],
	"Publishing is independent of memory sync and newsletter delivery. Failed deliveries retry automatically up to eight times. Sent means the provider accepted the request.":
		[
			"Die Veröffentlichung ist unabhängig vom Speicherabgleich und Newsletter-Versand. Fehlgeschlagene Zustellungen werden bis zu achtmal automatisch wiederholt. Gesendet bedeutet, dass der Anbieter die Anfrage angenommen hat.",
		],
	"Refresh deliveries": ["Zustellungen aktualisieren"],
	"Memory sync": ["Speicherabgleich"],
	Newsletter: ["Newsletter"],
	"Retry delivery": ["Zustellung erneut versuchen"],
	"Loading delivery status…": ["Zustellstatus wird geladen…"],
	"For plain webhooks, use the Webhook Notifier plugin.": [
		"Verwende für einfache Webhooks das Plugin Webhook Notifier.",
	],
	"Delivery status unavailable. Administrator access is required.": [
		"Zustellstatus nicht verfügbar. Administratorzugriff ist erforderlich.",
	],
	"Delivery status unavailable.": ["Zustellstatus nicht verfügbar."],
	"Could not queue the retry. Refresh and try again.": [
		"Der erneute Versuch konnte nicht vorgemerkt werden. Aktualisiere die Seite und versuche es erneut.",
	],
	"Retry unavailable.": ["Erneuter Versuch nicht verfügbar."],
	"{pending} pending · {failed} failed": [
		["pending"],
		" ausstehend · ",
		["failed"],
		" fehlgeschlagen",
	],
	"{attempts} attempts": [["attempts"], " Versuche"],
};

const ar: Messages = {
	"Back to Tedix": ["العودة إلى Tedix"],
	"Code and deployments": ["البرمجة والنشر"],
	"Open Sites": ["فتح Sites"],
	"Generated search text": ["نص البحث المُنشأ تلقائيًا"],
	"No search text yet.": ["لا يوجد نص بحث بعد."],
	"This text is generated when page sections are saved. Edit the sections to update it.":
		["يُنشأ هذا النص عند حفظ أقسام الصفحة. عدّل الأقسام لتحديثه."],
	"Edit content, media, menus and site settings in EmDash. Use the content editor to preview and publish changes.":
		[
			"عدّل المحتوى والوسائط والقوائم وإعدادات الموقع في EmDash. استخدم محرر المحتوى لمعاينة التغييرات ونشرها.",
		],
	"For theme code, domains and deployments, open Sites in your Tedix workspace.":
		["لإدارة برمجة القالب والنطاقات والنشر، افتح Sites في مساحة عمل Tedix."],
	"Publish deliveries": ["عمليات الإرسال بعد النشر"],
	"Publishing is independent of memory sync and newsletter delivery. Failed deliveries retry automatically up to eight times. Sent means the provider accepted the request.":
		[
			"النشر مستقل عن مزامنة الذاكرة وإرسال النشرة البريدية. تُعاد محاولات الإرسال الفاشلة تلقائيًا حتى ثماني مرات. تعني حالة «تم الإرسال» أن مزود الخدمة قد قبل الطلب.",
		],
	"Refresh deliveries": ["تحديث عمليات الإرسال"],
	"Memory sync": ["مزامنة الذاكرة"],
	Newsletter: ["النشرة البريدية"],
	"Retry delivery": ["إعادة محاولة الإرسال"],
	"Loading delivery status…": ["جارٍ تحميل حالة الإرسال…"],
	"For plain webhooks, use the Webhook Notifier plugin.": [
		"لإرسال إشعارات Webhook، استخدم إضافة Webhook Notifier.",
	],
	"Delivery status unavailable. Administrator access is required.": [
		"حالة الإرسال غير متاحة. يلزم وصول المسؤول.",
	],
	"Delivery status unavailable.": ["حالة الإرسال غير متاحة."],
	"Could not queue the retry. Refresh and try again.": [
		"تعذّرت جدولة إعادة المحاولة. حدّث الصفحة وحاول مجددًا.",
	],
	"Retry unavailable.": ["إعادة المحاولة غير متاحة."],
	"{pending} pending · {failed} failed": [
		["pending"],
		" قيد الانتظار · ",
		["failed"],
		" فشلت",
	],
	"{attempts} attempts": [["attempts"], " محاولات"],
};

const catalogs: Record<string, Messages> = { en, de, ar };

// EmDash statically imports adminEntry before AdminApp initializes its shared
// Lingui instance. loadAndActivate replaces messages on boot and locale changes;
// restore plugin messages synchronously before the host renders navigation.
function loadPluginMessages() {
	if (!i18n.locale) return;
	const messages = catalogs[i18n.locale.split("-")[0]!] ?? en;
	if (
		Object.entries(messages).every(([id, value]) => i18n.messages[id] === value)
	)
		return;
	i18n.load(i18n.locale, messages);
}
const unsubscribe = i18n.on("change", loadPluginMessages);
loadPluginMessages();
if (import.meta.hot) import.meta.hot.dispose(unsubscribe);
