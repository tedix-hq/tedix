/**
 * The line Google's consent screen shows for a scope, copied from Google's
 * OAuth 2.0 scope list (developers.google.com/identity/protocols/oauth2/scopes).
 * Telling someone to allow this exact line beats naming a Tedix group such as
 * "Identity", which Google never shows.
 */
const GOOGLE_CONSENT_WORDING: Record<string, string> = {
	openid: "Associate you with your personal info on Google",
	email: "See your primary Google Account email address",
	profile:
		"See your personal info, including any personal info you've made publicly available",
	"https://www.googleapis.com/auth/userinfo.email":
		"See your primary Google Account email address",
	"https://www.googleapis.com/auth/userinfo.profile":
		"See your personal info, including any personal info you've made publicly available",
	"https://mail.google.com/":
		"Read, compose, send, and permanently delete all your email from Gmail",
	"https://www.googleapis.com/auth/gmail.readonly":
		"View your email messages and settings",
	"https://www.googleapis.com/auth/gmail.send": "Send email on your behalf",
	"https://www.googleapis.com/auth/gmail.compose":
		"Manage drafts and send emails",
	"https://www.googleapis.com/auth/gmail.modify":
		"Read, compose, and send emails from your Gmail account",
	"https://www.googleapis.com/auth/gmail.labels":
		"See and edit your email labels",
	"https://www.googleapis.com/auth/gmail.metadata":
		"View your email message metadata such as labels and headers, but not the email body",
	"https://www.googleapis.com/auth/gmail.settings.basic":
		"See, edit, create, or change your email settings and filters in Gmail",
	"https://www.googleapis.com/auth/calendar":
		"See, edit, share, and permanently delete all the calendars you can access using Google Calendar",
	"https://www.googleapis.com/auth/calendar.readonly":
		"See and download any calendar you can access using your Google Calendar",
	"https://www.googleapis.com/auth/calendar.events":
		"View and edit events on all your calendars",
	"https://www.googleapis.com/auth/calendar.events.readonly":
		"View events on all your calendars",
	"https://www.googleapis.com/auth/drive":
		"See, edit, create, and delete all of your Google Drive files",
	"https://www.googleapis.com/auth/drive.readonly":
		"See and download all your Google Drive files",
	"https://www.googleapis.com/auth/drive.file":
		"See, edit, create, and delete only the specific Google Drive files you use with this app",
};

/** Google's consent lines for the scopes still missing, in a stable order. */
export function missingGoogleConsentLines(
	requiredScopes: readonly string[],
	grantedScopes: readonly string[],
): string[] {
	const granted = new Set(grantedScopes);
	const lines = requiredScopes
		.filter((scope) => !granted.has(scope))
		.map((scope) => GOOGLE_CONSENT_WORDING[scope])
		.filter((line): line is string => !!line);
	return [...new Set(lines)];
}
