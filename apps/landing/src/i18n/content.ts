type Widen<T> = T extends string
	? string
	: T extends number
		? number
		: T extends boolean
			? boolean
			: T extends readonly (infer U)[]
				? readonly Widen<U>[]
				: T extends object
					? { [K in keyof T]: Widen<T[K]> }
					: T;

export const defaultLocale = "en" as const;

export const supportedLocales = {
	en: "English",
	de: "Deutsch",
	es: "Español",
} as const;

export type Locale = keyof typeof supportedLocales;

export const supportedLocaleCodes = Object.keys(supportedLocales) as Locale[];

const englishContent = {
	meta: {
		title: "Tedix — Persistent AI workers for your organization",
		description:
			"Draft a meeting agenda, revise it in the same conversation, or assign tool-based work to a tedi with scoped permissions and a record of its actions.",
	},
	layout: {
		skipToContent: "Skip to content",
	},
	nav: {
		product: "Product",
		useCases: "Use Cases",
		apps: "Apps",
		blog: "Blog",
		login: "Login",
		requestAccess: "Open Tedix Cloud",
		toggleTheme: "Toggle theme",
		openMenu: "Open menu",
		languageLabel: "Language",
	},
	footer: {
		tagline: "AI coworkers that show their work.",
		product: "Product",
		appStore: "App Store",
		howItWorks: "How It Works",
		whyTedix: "Why Tedix",
		company: "Company",
		blog: "Blog",
		contact: "Contact",
		legal: "Legal",
		imprint: "Imprint",
		terms: "Terms of Service",
		privacy: "Privacy Policy",
		cookies: "Cookie Policy",
		cookieSettings: "Cookie Settings",
		source: "Source on GitHub",
		license: "Product source licensed under AGPL-3.0.",
		rights: "All rights reserved.",
	},
	consent: {
		ariaLabel: "Cookie preferences",
		title: "Cookie preferences",
		description:
			"We use necessary storage for site preferences. Analytics runs only if you allow it.",
		policy: "Cookie Policy",
		reject: "Reject non-essential",
		manage: "Manage",
		accept: "Accept all",
		dialogTitle: "Manage cookie preferences",
		dialogDescription:
			"Choose which optional services can run on this site. You can change this anytime from the footer.",
		necessary: "Necessary",
		necessaryDescription:
			"Required for security, page rendering, and saved site preferences.",
		analytics: "Analytics",
		analyticsDescription:
			"Helps us understand site usage and AI crawler visits so we can improve Tedix.",
		cancel: "Cancel",
		saveNecessary: "Save necessary only",
		save: "Save preferences",
	},
	home: {
		hero: {
			line1: "Give your team",
			line2: "persistent",
			line3: "AI workers.",
			subtitleIntro:
				"Start with a brief. Inspect the result. Continue the work.",
			subtitleHighlight: "Invited beta.",
			description:
				"Draft a meeting agenda, revise it in the same conversation, or assign tool-based work to a tedi with scoped permissions and a record of its actions.",
			primaryCta: "Open Tedix Cloud",
			secondaryCta: "See how it works",
			trustSignals: [
				"Invited Cloud access",
				"Scoped permissions",
				"Inspectable runs",
				"Built on Cloudflare",
			],
			betaBadge: "Invited beta.",
		},
		challenge: {
			eyebrow: "The challenge",
			title: "The AI promise vs. reality",
			description:
				"Tired of hearing AI can do everything — but still don’t know how to leverage it?",
			cards: [
				{
					badge: "Complexity",
					title: "Months to deploy AI",
					description:
						"You’ve tried ChatGPT, Claude, etc. but going from “cool demo” to real business value feels impossible.",
					alt: "A business team overwhelmed by the complexity of turning AI demos into production systems",
				},
				{
					badge: "Risks",
					title: "AI experimentation is costly",
					description:
						"Updating your technology stack causes high costs and embeds risks because the technology is still early.",
					alt: "A visual metaphor for expensive and risky AI experimentation",
				},
				{
					badge: "Silos",
					title: "Chaotic information",
					description:
						"Data lives in 15 different tools. Nobody has the full picture. There are many knowledge sources. Decisions take weeks instead of hours.",
					alt: "A stressed worker surrounded by tangled app logos and scattered company data",
				},
			],
			closingPrefix: "You don’t need another AI tool.",
			closingAccent: "You need an AI Assistant that understands your business.",
		},
		useCases: {
			eyebrow: "Tasks and examples",
			titlePrefix: "Start small.",
			titleAccent: "Check the result.",
			description:
				"Choose a task to evaluate, then inspect its result. Customer accounts below describe particular projects, not guaranteed outcomes.",
			testimonialLabel: "What clients say",
			brandsLabel: "These brands already sell inside AI chats",
			whereCompany: "Where’s your company?",
			getYourTedi: "Get your Tedi",
			items: [
				{
					badge: "Agentic Commerce",
					title: "Commerce prototypes",
					description:
						"Prototype a product experience for an AI chat. Catalog access, supported protocols, payment setup and review depend on the integration.",
					quote:
						"Tedix impressed us by implementing our Agentic Products Protocol within days and bringing it to life in the ChatGPT ecosystem. Their platform approach to enabling agentic commerce, combined with exceptional execution, made partnering with them an easy decision.",
					attribution: "Head of Agentic Commerce (AI), Klarna",
					alt: "AI Integration Layer",
				},
				{
					badge: "System Integration",
					title: "Explore a system integration",
					description:
						"Ask a tedi to examine a bounded integration task. Confirm available access and test the result before relying on it in production.",
					alt: "AI Integration Layer",
				},
				{
					badge: "GEO & Content",
					title: "Draft content in your voice",
					description:
						"Supply a brief and approved references. Review accuracy and tone before publishing generated content.",
					quote:
						"The tedi assigned to us surprised us with deep expertise and research-style content perfectly aligned to our brand voice. It was like having a senior content strategist on the team.",
					attribution:
						"Enterprise client — Expert content delivered autonomously",
					alt: "GEO & Content Strategy",
				},
				{
					badge: "Solo Founder",
					title: "Draft and revise operational work",
					description:
						"Start with a meeting agenda or a short plan. Continue in the same conversation and verify that revisions preserve what matters.",
					alt: "Solo founder working with tedi AI",
				},
				{
					badge: "Rapid Deployment",
					title: "Test a bounded prototype",
					description:
						"Use a small prototype to evaluate an idea. Delivery time and production readiness depend on scope, tools and review.",
					quote:
						"Tedix brought MiMexTrade to life in a matter of days. What we thought would take over a year was deployed and ready. Now we’re securing the budget to scale it across all of Germany.",
					attribution: "SRE — Mexican Embassy in Germany",
					alt: "MiMexTrade platform built by tedi",
				},
			],
		},
		integrations: {
			eyebrow: "Integrations",
			title: "Connect selected tools",
			description:
				"Available integrations depend on your workspace, provider connection and permissions. Some workflows require setup or engineering.",
		},
		trust: {
			eyebrow: "Trust & Security",
			title: "Inspect the work and its boundaries.",
			cards: [
				{
					title: "Data boundaries",
					description:
						"Organization-scoped access and provider configuration govern data handling. Confirm hosting, retention and processing terms for your deployment.",
				},
				{
					title: "Inspect run records",
					description:
						"Read recorded outcomes, actions and rationale where available. A completed run does not certify correctness; check the result.",
				},
				{
					title: "Organization-owned context",
					description:
						"Conversation records, facts and skills have distinct lifecycles. Review what is retained and which export paths your deployment supports.",
				},
				{
					title: "Scoped authority",
					description:
						"Tools and protected actions follow configured permissions and approval rules. These controls reduce risk; they do not guarantee that every action is safe.",
				},
				{
					title: "Start with one integration",
					description:
						"Connect only what the first task needs. Provider access, configuration and workflow validation still take work.",
				},
			],
		},
		timeline: {
			eyebrow: "How it works",
			titleLine1: "Start with one task,",
			titleLine2: "then expand deliberately.",
			automationTitle: "Example workflows",
			activeLabel: "Example workflows",
			intelligenceTitle: "Illustrative outcomes",
			steps: [
				{
					number: "1",
					kicker: "First task",
					title: "Provide a short brief",
					copy: [
						"Use non-sensitive input to request a draft in Tedix OS or the CLI.",
						"Check that you can use the result before connecting company systems.",
					],
					accent: "violet",
				},
				{
					number: "2",
					kicker: "Revision",
					title: "Continue the same conversation",
					copy: [
						"Ask for a concrete change, such as shortening the agenda.",
						"Inspect both run records. Conversation continuity does not imply permanent learning.",
					],
					accent: "blue",
				},
				{
					number: "3",
					kicker: "One connection",
					title: "Add only the capability you need",
					copy: [
						"Confirm provider access and permissions before using an integration.",
						"Validate its result and any external changes. Protected actions follow their configured approval path.",
					],
					accent: "fuchsia",
				},
				{
					number: "4",
					kicker: "Repeat use",
					title: "Keep what works",
					copy: [
						"Review useful context and procedures for reuse.",
						"Report failures and measure whether the worker actually saves time.",
					],
					accent: "pink",
				},
			],
			automationRows: [
				"Updating systems",
				"Coordinating workflows",
				"Generating reports",
				"Invoice processing",
				"Customer follow-up",
			],
			intelligenceRows: [
				"Workflow gaps detected",
				"Operational patterns found",
				"Improvements suggested",
				"Performance improved",
			],
			badges: [
				"Natural language",
				"Operational memory",
				"Connected workflows",
				"Your preferred channels",
			],
		},
		economics: {
			eyebrow: "Learning and reuse",
			titlePrefix: "Build on",
			titleAccent: "previous work",
			description:
				"Retained context and reusable skills can reduce repeated work. Learning quality and cost savings must be measured.",
			cards: [
				{
					title: "Reusable procedures",
					description:
						"Successful procedures can become skills. Review their scope and behavior before reusing them.",
				},
				{
					title: "Workflow execution",
					description:
						"Some skills run as workflows. Execution can still incur compute, provider and model costs.",
				},
				{
					title: "Selected context",
					description:
						"Retrieval selects relevant stored context within a bounded budget. It can miss facts or select the wrong ones.",
				},
				{
					title: "Measure the outcome",
					description:
						"Compare result quality, corrections and actual usage across repeated tasks. Improvement is an objective, not a guarantee.",
				},
			],
		},
		stats: ["tools built", "apps live", "catalog entries", "AI platforms"],
		backedBy: {
			eyebrow: "Backed by",
			bmwk: "German Federal Ministry",
			aiNation: "Accelerator",
			munich: "Innovation Hub",
			reaktor: "Startup Hub",
			state: "U.S. State Dept.",
		},
		blog: {
			eyebrow: "Tedix Blog",
			title: "Check out our blog",
			description:
				"Learn about the latest AI trends, automation playbooks, agentic commerce, and the future of autonomous work.",
			cta: "Read the blog",
		},
		cta: {
			demoTitle: "Ready to deploy your first Autonomous AI worker?",
			demoDescription: "Join teams already operating smarter with tedix.",
			demoCta: "Watch a demo",
			demoUrl: "https://www.youtube.com/watch?v=RM5l4dbC_nc",
			badge: "Invited Beta",
			titleLine1: "This isn’t for",
			titleLine2: "everyone.",
			description:
				"Tedix Cloud is in invited beta. Already invited? Sign in with your invited account. Need access? Contact the person who introduced you to Tedix; signing in alone does not create a workspace. The source is public on GitHub, and local mode runs without an invitation.",
			signals: [
				"Invite-only access",
				"A workspace invitation is required",
				"Onboarding with the Tedix team",
			],
			primary: "Open Tedix Cloud",
			footnotes: ["Invited beta", "Access arranged individually"],
		},
	},
} as const;

type SiteContent = Widen<typeof englishContent>;
export type HomeContent = SiteContent["home"];
export type TimelineContent = HomeContent["timeline"];

const germanContent = {
	meta: {
		title: "Tedix — Dauerhafte KI-Worker für Ihre Organisation",
		description:
			"Erstellen Sie eine Besprechungsagenda, überarbeiten Sie sie im selben Gespräch oder delegieren Sie Aufgaben mit Tools an einen Tedi mit begrenzten Rechten und nachvollziehbaren Aktionen.",
	},
	layout: {
		skipToContent: "Zum Inhalt springen",
	},
	nav: {
		product: "Produkt",
		useCases: "Anwendungsfälle",
		apps: "Apps",
		blog: "Blog",
		login: "Anmelden",
		requestAccess: "Tedix Cloud öffnen",
		toggleTheme: "Design umschalten",
		openMenu: "Menü öffnen",
		languageLabel: "Sprache",
	},
	footer: {
		tagline: "KI-Kollegen, die ihre Arbeit zeigen.",
		product: "Produkt",
		appStore: "App Store",
		howItWorks: "So funktioniert es",
		whyTedix: "Warum Tedix",
		company: "Unternehmen",
		blog: "Blog",
		contact: "Kontakt",
		legal: "Rechtliches",
		imprint: "Impressum",
		terms: "Nutzungsbedingungen",
		privacy: "Datenschutz",
		cookies: "Cookie-Richtlinie",
		cookieSettings: "Cookie-Einstellungen",
		source: "Quellcode auf GitHub",
		license: "Produktquellcode unter AGPL-3.0 lizenziert.",
		rights: "Alle Rechte vorbehalten.",
	},
	consent: {
		ariaLabel: "Cookie-Einstellungen",
		title: "Cookie-Einstellungen",
		description:
			"Wir verwenden notwendigen Speicher für Website-Einstellungen. Analytics läuft nur, wenn Sie zustimmen.",
		policy: "Cookie-Richtlinie",
		reject: "Nicht notwendige ablehnen",
		manage: "Verwalten",
		accept: "Alle akzeptieren",
		dialogTitle: "Cookie-Einstellungen verwalten",
		dialogDescription:
			"Wählen Sie, welche optionalen Dienste auf dieser Website laufen dürfen. Sie können dies jederzeit im Footer ändern.",
		necessary: "Notwendig",
		necessaryDescription:
			"Erforderlich für Sicherheit, Seitendarstellung und gespeicherte Website-Einstellungen.",
		analytics: "Analytics",
		analyticsDescription:
			"Hilft uns, Website-Nutzung und KI-Crawler-Besuche zu verstehen, damit wir Tedix verbessern können.",
		cancel: "Abbrechen",
		saveNecessary: "Nur notwendige speichern",
		save: "Einstellungen speichern",
	},
	home: {
		hero: {
			line1: "Geben Sie Ihrem Team",
			line2: "dauerhafte",
			line3: "KI-Worker.",
			subtitleIntro:
				"Mit einem Briefing starten. Ergebnis prüfen. Weiterarbeiten.",
			subtitleHighlight: "Beta auf Einladung.",
			description:
				"Erstellen Sie eine Besprechungsagenda, überarbeiten Sie sie im selben Gespräch oder delegieren Sie Aufgaben mit Tools an einen Tedi mit begrenzten Rechten und nachvollziehbaren Aktionen.",
			primaryCta: "Tedix Cloud öffnen",
			secondaryCta: "So funktioniert es",
			trustSignals: [
				"Cloud-Zugang per Einladung",
				"Begrenzte Berechtigungen",
				"Einsehbare Runs",
				"Auf Cloudflare gebaut",
			],
			betaBadge: "Beta auf Einladung.",
		},
		challenge: {
			eyebrow: "Die Herausforderung",
			title: "Das KI-Versprechen vs. die Realität",
			description:
				"Sie hören ständig, KI könne alles — wissen aber noch nicht, wie Sie sie wirklich nutzen?",
			cards: [
				{
					badge: "Komplexität",
					title: "Monate bis zum KI-Einsatz",
					description:
						"Sie haben ChatGPT, Claude und andere Tools getestet, aber der Weg von der coolen Demo zu echtem Geschäftswert fühlt sich unmöglich an.",
					alt: "Ein Business-Team, das von der Komplexität produktiver KI-Systeme überfordert ist",
				},
				{
					badge: "Risiken",
					title: "KI-Experimente sind teuer",
					description:
						"Die Modernisierung Ihres Tech-Stacks verursacht hohe Kosten und bringt Risiken mit sich, weil die Technologie noch jung ist.",
					alt: "Eine visuelle Metapher für teure und riskante KI-Experimente",
				},
				{
					badge: "Silos",
					title: "Chaotische Informationen",
					description:
						"Daten liegen in 15 verschiedenen Tools. Niemand sieht das ganze Bild. Entscheidungen dauern Wochen statt Stunden.",
					alt: "Eine gestresste Person, umgeben von App-Logos und verstreuten Unternehmensdaten",
				},
			],
			closingPrefix: "Sie brauchen kein weiteres KI-Tool.",
			closingAccent:
				"Sie brauchen einen KI-Assistenten, der Ihr Unternehmen versteht.",
		},
		useCases: {
			eyebrow: "Aufgaben und Beispiele",
			titlePrefix: "Klein starten.",
			titleAccent: "Ergebnis prüfen.",
			description:
				"Wählen Sie eine Aufgabe und prüfen Sie das Ergebnis. Kundenberichte beschreiben einzelne Projekte, keine garantierten Ergebnisse.",
			testimonialLabel: "Was Kunden sagen",
			brandsLabel: "Diese Marken verkaufen bereits in KI-Chats",
			whereCompany: "Wo ist Ihr Unternehmen?",
			getYourTedi: "Tedi anfragen",
			items: [
				{
					badge: "Agentic Commerce",
					title: "Commerce-Prototypen",
					description:
						"Erproben Sie eine Produkterfahrung im KI-Chat. Katalogzugriff, unterstützte Protokolle, Zahlungsanbindung und Prüfung hängen von der Integration ab.",
					quote:
						"Tedix impressed us by implementing our Agentic Products Protocol within days and bringing it to life in the ChatGPT ecosystem. Their platform approach to enabling agentic commerce, combined with exceptional execution, made partnering with them an easy decision.",
					attribution: "Head of Agentic Commerce (AI), Klarna",
					alt: "KI-Integrationsschicht",
				},
				{
					badge: "Systemintegration",
					title: "Eine Systemintegration erkunden",
					description:
						"Lassen Sie einen Tedi eine begrenzte Integrationsaufgabe untersuchen. Prüfen Sie Zugang und Ergebnis vor dem Produktiveinsatz.",
					alt: "KI-Integrationsschicht",
				},
				{
					badge: "GEO & Content",
					title: "In Ihrem Stil entwerfen",
					description:
						"Geben Sie ein Briefing und freigegebene Quellen vor. Prüfen Sie Genauigkeit und Ton vor der Veröffentlichung.",
					quote:
						"The tedi assigned to us surprised us with deep expertise and research-style content perfectly aligned to our brand voice. It was like having a senior content strategist on the team.",
					attribution: "Enterprise-Kunde — Expertencontent autonom geliefert",
					alt: "GEO- und Content-Strategie",
				},
				{
					badge: "Solo-Founder",
					title: "Arbeit entwerfen und überarbeiten",
					description:
						"Starten Sie mit einer Agenda oder einem kurzen Plan. Arbeiten Sie im selben Gespräch weiter und prüfen Sie die Änderungen.",
					alt: "Solo-Gründer arbeitet mit Tedi KI",
				},
				{
					badge: "Schnelle Umsetzung",
					title: "Einen begrenzten Prototyp testen",
					description:
						"Prüfen Sie eine Idee mit einem kleinen Prototyp. Lieferzeit und Produktionsreife hängen von Umfang, Tools und Prüfung ab.",
					quote:
						"Tedix brought MiMexTrade to life in a matter of days. What we thought would take over a year was deployed and ready. Now we’re securing the budget to scale it across all of Germany.",
					attribution: "SRE — Mexikanische Botschaft in Deutschland",
					alt: "MiMexTrade-Plattform, gebaut von Tedi",
				},
			],
		},
		integrations: {
			eyebrow: "Integrationen",
			title: "Ausgewählte Tools verbinden",
			description:
				"Verfügbare Integrationen hängen von Workspace, Anbieterzugang und Berechtigungen ab. Manche Abläufe benötigen Einrichtung oder Entwicklungsarbeit.",
		},
		trust: {
			eyebrow: "Vertrauen & Sicherheit",
			title: "Arbeit und Grenzen nachvollziehen.",
			cards: [
				{
					title: "Datengrenzen",
					description:
						"Organisationsbezogener Zugriff und Anbieterkonfiguration bestimmen die Datenverarbeitung. Prüfen Sie Hosting, Aufbewahrung und Vertragsbedingungen Ihrer Installation.",
				},
				{
					title: "Runs prüfen",
					description:
						"Prüfen Sie erfasste Ergebnisse, Aktionen und Begründungen, soweit vorhanden. Ein abgeschlossener Run bestätigt keine inhaltliche Richtigkeit.",
				},
				{
					title: "Kontext der Organisation",
					description:
						"Gesprächsverläufe, Fakten und Skills haben unterschiedliche Lebenszyklen. Prüfen Sie Speicherung und verfügbare Exportwege Ihrer Installation.",
				},
				{
					title: "Begrenzte Befugnisse",
					description:
						"Tools und geschützte Aktionen unterliegen konfigurierten Rechten und Freigaben. Das reduziert Risiken, garantiert aber keine fehlerfreien Aktionen.",
				},
				{
					title: "Mit einer Integration starten",
					description:
						"Verbinden Sie nur, was die erste Aufgabe benötigt. Anbieterzugang, Einrichtung und Prüfung bleiben erforderlich.",
				},
			],
		},
		timeline: {
			eyebrow: "So funktioniert es",
			titleLine1: "Mit einer Aufgabe starten,",
			titleLine2: "gezielt erweitern.",
			automationTitle: "Beispiel-Workflows",
			activeLabel: "Beispiel-Workflows",
			intelligenceTitle: "Beispielhafte Ergebnisse",
			steps: [
				{
					number: "1",
					kicker: "Erste Aufgabe",
					title: "Ein kurzes Briefing geben",
					copy: [
						"Fordern Sie mit unkritischen Daten einen Entwurf in Tedix OS oder der CLI an.",
						"Prüfen Sie den Nutzen, bevor Sie Unternehmenssysteme verbinden.",
					],
					accent: "violet",
				},
				{
					number: "2",
					kicker: "Überarbeitung",
					title: "Im selben Gespräch weiterarbeiten",
					copy: [
						"Bitten Sie um eine konkrete Änderung, etwa eine kürzere Agenda.",
						"Prüfen Sie beide Runs. Gesprächskontinuität bedeutet kein dauerhaftes Lernen.",
					],
					accent: "blue",
				},
				{
					number: "3",
					kicker: "Eine Verbindung",
					title: "Nur benötigte Fähigkeiten ergänzen",
					copy: [
						"Prüfen Sie Anbieterzugang und Berechtigungen vor der Integration.",
						"Validieren Sie Ergebnisse und externe Änderungen. Geschützte Aktionen folgen den konfigurierten Freigaben.",
					],
					accent: "fuchsia",
				},
				{
					number: "4",
					kicker: "Wiederholte Nutzung",
					title: "Bewährtes behalten",
					copy: [
						"Prüfen Sie nützlichen Kontext und Verfahren für die Wiederverwendung.",
						"Melden Sie Fehler und messen Sie die tatsächliche Zeitersparnis.",
					],
					accent: "pink",
				},
			],
			automationRows: [
				"Systeme aktualisieren",
				"Workflows koordinieren",
				"Reports erstellen",
				"Rechnungen verarbeiten",
				"Kunden nachfassen",
			],
			intelligenceRows: [
				"Workflow-Lücken erkannt",
				"Operative Muster gefunden",
				"Verbesserungen vorgeschlagen",
				"Performance verbessert",
			],
			badges: [
				"Natürliche Sprache",
				"Operatives Gedächtnis",
				"Verbundene Workflows",
				"Ihre bevorzugten Kanäle",
			],
		},
		economics: {
			eyebrow: "Lernen und Wiederverwenden",
			titlePrefix: "Auf bisheriger",
			titleAccent: "Arbeit aufbauen",
			description:
				"Gespeicherter Kontext und Skills können wiederholte Arbeit reduzieren. Lernqualität und Einsparungen müssen gemessen werden.",
			cards: [
				{
					title: "Wiederverwendbare Verfahren",
					description:
						"Erfolgreiche Verfahren können zu Skills werden. Prüfen Sie ihren Umfang und ihr Verhalten vor der Wiederverwendung.",
				},
				{
					title: "Workflow-Ausführung",
					description:
						"Manche Skills laufen als Workflows. Dabei können weiterhin Rechen-, Anbieter- und Modellkosten entstehen.",
				},
				{
					title: "Ausgewählter Kontext",
					description:
						"Die Suche wählt gespeicherten Kontext innerhalb eines begrenzten Budgets. Sie kann Fakten übersehen oder falsch auswählen.",
				},
				{
					title: "Ergebnis messen",
					description:
						"Vergleichen Sie Qualität, Korrekturen und tatsächliche Nutzung bei wiederholten Aufgaben. Verbesserung ist ein Ziel, keine Garantie.",
				},
			],
		},
		stats: ["Tools gebaut", "Apps live", "Katalogeinträge", "KI-Plattformen"],
		backedBy: {
			eyebrow: "Unterstützt von",
			bmwk: "Bundesministerium",
			aiNation: "Accelerator",
			munich: "Innovation Hub",
			reaktor: "Startup Hub",
			state: "U.S. State Dept.",
		},
		blog: {
			eyebrow: "Tedix Blog",
			title: "Entdecken Sie unseren Blog",
			description:
				"Lesen Sie über die neuesten KI-Trends, Automatisierungs-Playbooks, Agentic Commerce und die Zukunft autonomer Arbeit.",
			cta: "Blog lesen",
		},
		cta: {
			demoTitle: "Bereit, Ihren ersten autonomen KI-Worker einzusetzen?",
			demoDescription:
				"Schließen Sie sich Teams an, die mit Tedix bereits smarter arbeiten.",
			demoCta: "Demo ansehen",
			demoUrl: "https://www.youtube.com/watch?v=RM5l4dbC_nc",
			badge: "Beta auf Einladung",
			titleLine1: "Das ist nicht",
			titleLine2: "für alle.",
			description:
				"Tedix Cloud ist in einer Beta auf Einladung. Schon eingeladen? Melden Sie sich mit Ihrem eingeladenen Konto an. Für Zugang wenden Sie sich an die Person, die Ihnen Tedix vorgestellt hat. Die Anmeldung allein erstellt keinen Workspace. Der Quellcode ist öffentlich auf GitHub, und der lokale Modus läuft ohne Einladung.",
			signals: [
				"Zugang nur per Einladung",
				"Einladung zum Workspace erforderlich",
				"Onboarding mit dem Tedix-Team",
			],
			primary: "Tedix Cloud öffnen",
			footnotes: ["Beta auf Einladung", "Zugang nach Vereinbarung"],
		},
	},
} satisfies SiteContent;

const spanishContent = {
	meta: {
		title: "Tedix — Workers de IA persistentes para tu organización",
		description:
			"Crea una agenda, revísala en la misma conversación o asigna tareas con herramientas a un tedi con permisos limitados y un registro de sus acciones.",
	},
	layout: {
		skipToContent: "Saltar al contenido",
	},
	nav: {
		product: "Producto",
		useCases: "Casos de uso",
		apps: "Apps",
		blog: "Blog",
		login: "Iniciar sesión",
		requestAccess: "Abrir Tedix Cloud",
		toggleTheme: "Cambiar tema",
		openMenu: "Abrir menú",
		languageLabel: "Idioma",
	},
	footer: {
		tagline: "Compañeros de IA que muestran su trabajo.",
		product: "Producto",
		appStore: "App Store",
		howItWorks: "Cómo funciona",
		whyTedix: "Por qué Tedix",
		company: "Empresa",
		blog: "Blog",
		contact: "Contacto",
		legal: "Legal",
		imprint: "Aviso legal",
		terms: "Términos de servicio",
		privacy: "Política de privacidad",
		cookies: "Política de cookies",
		cookieSettings: "Configuración de cookies",
		source: "Código fuente en GitHub",
		license: "Código fuente del producto bajo licencia AGPL-3.0.",
		rights: "Todos los derechos reservados.",
	},
	consent: {
		ariaLabel: "Preferencias de cookies",
		title: "Preferencias de cookies",
		description:
			"Usamos almacenamiento necesario para las preferencias del sitio. Analytics solo se ejecuta si lo permites.",
		policy: "Política de cookies",
		reject: "Rechazar no esenciales",
		manage: "Gestionar",
		accept: "Aceptar todo",
		dialogTitle: "Gestionar preferencias de cookies",
		dialogDescription:
			"Elige qué servicios opcionales pueden ejecutarse en este sitio. Puedes cambiarlo en cualquier momento desde el pie de página.",
		necessary: "Necesarias",
		necessaryDescription:
			"Requeridas para seguridad, renderizado de páginas y preferencias guardadas del sitio.",
		analytics: "Analytics",
		analyticsDescription:
			"Nos ayuda a entender el uso del sitio y las visitas de crawlers de IA para mejorar Tedix.",
		cancel: "Cancelar",
		saveNecessary: "Guardar solo necesarias",
		save: "Guardar preferencias",
	},
	home: {
		hero: {
			line1: "Dale a tu equipo",
			line2: "workers de IA",
			line3: "persistentes.",
			subtitleIntro:
				"Empieza con un encargo. Revisa el resultado. Continúa el trabajo.",
			subtitleHighlight: "Beta por invitación.",
			description:
				"Crea una agenda, revísala en la misma conversación o asigna tareas con herramientas a un tedi con permisos limitados y un registro de sus acciones.",
			primaryCta: "Abrir Tedix Cloud",
			secondaryCta: "Ver cómo funciona",
			trustSignals: [
				"Cloud por invitación",
				"Permisos limitados",
				"Ejecuciones consultables",
				"Basado en Cloudflare",
			],
			betaBadge: "Beta por invitación.",
		},
		challenge: {
			eyebrow: "El reto",
			title: "La promesa de la IA vs. la realidad",
			description:
				"¿Cansado de oír que la IA puede hacerlo todo, pero sin saber cómo aprovecharla?",
			cards: [
				{
					badge: "Complejidad",
					title: "Meses para desplegar IA",
					description:
						"Has probado ChatGPT, Claude y otras herramientas, pero pasar de una demo interesante a valor real de negocio parece imposible.",
					alt: "Un equipo de negocio abrumado por la complejidad de convertir demos de IA en sistemas productivos",
				},
				{
					badge: "Riesgos",
					title: "Experimentar con IA es caro",
					description:
						"Actualizar tu stack tecnológico genera costes altos y añade riesgos porque la tecnología todavía es nueva.",
					alt: "Una metáfora visual de experimentación con IA costosa y arriesgada",
				},
				{
					badge: "Silos",
					title: "Información caótica",
					description:
						"Los datos viven en 15 herramientas diferentes. Nadie tiene la imagen completa. Las decisiones tardan semanas en vez de horas.",
					alt: "Una persona estresada rodeada de logos de apps y datos dispersos de la empresa",
				},
			],
			closingPrefix: "No necesitas otra herramienta de IA.",
			closingAccent: "Necesitas un asistente de IA que entienda tu negocio.",
		},
		useCases: {
			eyebrow: "Tareas y ejemplos",
			titlePrefix: "Empieza pequeño.",
			titleAccent: "Revisa el resultado.",
			description:
				"Elige una tarea y revisa su resultado. Los testimonios describen proyectos concretos, no resultados garantizados.",
			testimonialLabel: "Lo que dicen los clientes",
			brandsLabel: "Estas marcas ya venden dentro de chats de IA",
			whereCompany: "¿Dónde está tu empresa?",
			getYourTedi: "Consigue tu Tedi",
			items: [
				{
					badge: "Agentic Commerce",
					title: "Prototipos de comercio",
					description:
						"Prueba una experiencia de producto en un chat de IA. El catálogo, los protocolos, los pagos y la revisión dependen de la integración.",
					quote:
						"Tedix impressed us by implementing our Agentic Products Protocol within days and bringing it to life in the ChatGPT ecosystem. Their platform approach to enabling agentic commerce, combined with exceptional execution, made partnering with them an easy decision.",
					attribution: "Head of Agentic Commerce (AI), Klarna",
					alt: "Capa de integración de IA",
				},
				{
					badge: "Integración de sistemas",
					title: "Explora una integración",
					description:
						"Pide a un tedi que examine una integración acotada. Confirma el acceso y valida el resultado antes de usarlo en producción.",
					alt: "Capa de integración de IA",
				},
				{
					badge: "GEO & Contenido",
					title: "Redacta con tu voz",
					description:
						"Aporta un encargo y fuentes aprobadas. Revisa exactitud y tono antes de publicar contenido generado.",
					quote:
						"The tedi assigned to us surprised us with deep expertise and research-style content perfectly aligned to our brand voice. It was like having a senior content strategist on the team.",
					attribution:
						"Cliente enterprise — Contenido experto entregado de forma autónoma",
					alt: "Estrategia GEO y de contenido",
				},
				{
					badge: "Solo Founder",
					title: "Redacta y revisa trabajo operativo",
					description:
						"Empieza con una agenda o un plan breve. Continúa en la misma conversación y comprueba que las revisiones conservan lo importante.",
					alt: "Fundador trabajando con Tedi IA",
				},
				{
					badge: "Despliegue rápido",
					title: "Prueba un prototipo acotado",
					description:
						"Evalúa una idea con un prototipo pequeño. El plazo y la preparación para producción dependen del alcance, las herramientas y la revisión.",
					quote:
						"Tedix brought MiMexTrade to life in a matter of days. What we thought would take over a year was deployed and ready. Now we’re securing the budget to scale it across all of Germany.",
					attribution: "SRE — Embajada de México en Alemania",
					alt: "Plataforma MiMexTrade creada por Tedi",
				},
			],
		},
		integrations: {
			eyebrow: "Integraciones",
			title: "Conecta herramientas concretas",
			description:
				"Las integraciones disponibles dependen del espacio, la conexión al proveedor y los permisos. Algunos flujos requieren configuración o desarrollo.",
		},
		trust: {
			eyebrow: "Confianza & Seguridad",
			title: "Revisa el trabajo y sus límites.",
			cards: [
				{
					title: "Límites de datos",
					description:
						"El acceso por organización y la configuración de proveedores determinan el tratamiento de datos. Confirma alojamiento, retención y condiciones de tu instalación.",
				},
				{
					title: "Revisa las ejecuciones",
					description:
						"Consulta resultados, acciones y razones registradas cuando estén disponibles. Una ejecución completada no certifica que el resultado sea correcto.",
				},
				{
					title: "Contexto de la organización",
					description:
						"Conversaciones, hechos y skills tienen ciclos de vida distintos. Revisa qué se conserva y qué opciones de exportación admite tu instalación.",
				},
				{
					title: "Autoridad limitada",
					description:
						"Las herramientas y acciones protegidas siguen permisos y aprobaciones configurados. Reducen riesgos, pero no garantizan que toda acción sea segura.",
				},
				{
					title: "Empieza con una integración",
					description:
						"Conecta solo lo necesario para la primera tarea. El acceso al proveedor, la configuración y la validación siguen siendo necesarios.",
				},
			],
		},
		timeline: {
			eyebrow: "Cómo funciona",
			titleLine1: "Empieza con una tarea,",
			titleLine2: "amplía con intención.",
			automationTitle: "Workflows de ejemplo",
			activeLabel: "Workflows de ejemplo",
			intelligenceTitle: "Resultados ilustrativos",
			steps: [
				{
					number: "1",
					kicker: "Primera tarea",
					title: "Aporta un encargo breve",
					copy: [
						"Pide un borrador con datos no sensibles en Tedix OS o la CLI.",
						"Comprueba su utilidad antes de conectar sistemas de la empresa.",
					],
					accent: "violet",
				},
				{
					number: "2",
					kicker: "Revisión",
					title: "Continúa la misma conversación",
					copy: [
						"Pide un cambio concreto, como acortar la agenda.",
						"Revisa ambas ejecuciones. La continuidad no implica aprendizaje permanente.",
					],
					accent: "blue",
				},
				{
					number: "3",
					kicker: "Una conexión",
					title: "Añade solo la capacidad necesaria",
					copy: [
						"Confirma el acceso al proveedor y los permisos antes de usar una integración.",
						"Valida los resultados y los cambios externos. Las acciones protegidas siguen las aprobaciones configuradas.",
					],
					accent: "fuchsia",
				},
				{
					number: "4",
					kicker: "Uso repetido",
					title: "Conserva lo que funciona",
					copy: [
						"Revisa el contexto y los procedimientos útiles para reutilizarlos.",
						"Reporta fallos y mide si el worker realmente ahorra tiempo.",
					],
					accent: "pink",
				},
			],
			automationRows: [
				"Actualizar sistemas",
				"Coordinar flujos",
				"Generar reportes",
				"Procesar facturas",
				"Seguimiento a clientes",
			],
			intelligenceRows: [
				"Brechas de workflow detectadas",
				"Patrones operativos encontrados",
				"Mejoras sugeridas",
				"Rendimiento mejorado",
			],
			badges: [
				"Lenguaje natural",
				"Memoria operativa",
				"Workflows conectados",
				"Tus canales preferidos",
			],
		},
		economics: {
			eyebrow: "Aprendizaje y reutilización",
			titlePrefix: "Construye sobre",
			titleAccent: "el trabajo previo",
			description:
				"El contexto guardado y las skills pueden reducir trabajo repetido. La calidad del aprendizaje y el ahorro deben medirse.",
			cards: [
				{
					title: "Procedimientos reutilizables",
					description:
						"Los procedimientos útiles pueden convertirse en skills. Revisa su alcance y comportamiento antes de reutilizarlos.",
				},
				{
					title: "Ejecución de workflows",
					description:
						"Algunas skills se ejecutan como workflows. Pueden seguir generando costes de cómputo, proveedores y modelos.",
				},
				{
					title: "Contexto seleccionado",
					description:
						"La búsqueda selecciona contexto guardado dentro de un presupuesto limitado. Puede omitir hechos o elegir información incorrecta.",
				},
				{
					title: "Mide el resultado",
					description:
						"Compara calidad, correcciones y uso real en tareas repetidas. Mejorar es un objetivo, no una garantía.",
				},
			],
		},
		stats: [
			"tools creados",
			"apps en vivo",
			"entradas de catálogo",
			"plataformas de IA",
		],
		backedBy: {
			eyebrow: "Respaldado por",
			bmwk: "Ministerio Federal Alemán",
			aiNation: "Accelerator",
			munich: "Innovation Hub",
			reaktor: "Startup Hub",
			state: "U.S. State Dept.",
		},
		blog: {
			eyebrow: "Blog de Tedix",
			title: "Explora nuestro blog",
			description:
				"Aprende sobre las últimas tendencias de IA, playbooks de automatización, agentic commerce y el futuro del trabajo autónomo.",
			cta: "Leer el blog",
		},
		cta: {
			demoTitle: "¿Listo para desplegar tu primer worker autónomo de IA?",
			demoDescription:
				"Únete a los equipos que ya operan de forma más inteligente con Tedix.",
			demoCta: "Ver demo",
			demoUrl: "https://www.youtube.com/watch?v=RM5l4dbC_nc",
			badge: "Beta por invitación",
			titleLine1: "Esto no es",
			titleLine2: "para todos.",
			description:
				"Tedix Cloud está en beta por invitación. ¿Ya tienes invitación? Inicia sesión con la cuenta invitada. Para obtener acceso, contacta a quien te presentó Tedix; iniciar sesión no crea un espacio de trabajo. El código fuente es público en GitHub y el modo local funciona sin invitación.",
			signals: [
				"Acceso solo por invitación",
				"Se requiere invitación al espacio",
				"Incorporación con el equipo de Tedix",
			],
			primary: "Abrir Tedix Cloud",
			footnotes: ["Beta por invitación", "Acceso acordado individualmente"],
		},
	},
} satisfies SiteContent;

export const siteContent = {
	en: englishContent,
	de: germanContent,
	es: spanishContent,
} satisfies Record<Locale, SiteContent>;

export function isLocale(value: string | undefined): value is Locale {
	return Boolean(value && value in supportedLocales);
}

export function getLocaleContent(locale: string | undefined): SiteContent {
	return siteContent[isLocale(locale) ? locale : defaultLocale];
}

export function localizeHomePath(locale: Locale, hash = "") {
	const suffix = hash ? `#${hash.replace(/^#/, "")}` : "";
	return locale === defaultLocale ? `/${suffix}` : `/${locale}/${suffix}`;
}

export function switchLocalePath(pathname: string, targetLocale: Locale) {
	const cleanPath = pathname.replace(/^\/(de|es)(?=\/|$)/, "") || "/";
	if (cleanPath !== "/") return cleanPath;
	return localizeHomePath(targetLocale);
}

export function isLocalizedHomePath(pathname: string) {
	return (
		pathname === "/" ||
		pathname === "/de/" ||
		pathname === "/de" ||
		pathname === "/es/" ||
		pathname === "/es"
	);
}

export function getHomeAlternateLinks(site: URL | undefined) {
	if (!site) return [];
	return [
		...supportedLocaleCodes.map((locale) => ({
			hreflang: locale,
			href: new URL(localizeHomePath(locale), site).toString(),
		})),
		{
			hreflang: "x-default",
			href: new URL(localizeHomePath(defaultLocale), site).toString(),
		},
	];
}

export function getOgLocale(locale: Locale) {
	return {
		en: "en_US",
		de: "de_DE",
		es: "es_ES",
	}[locale];
}
