---
sidebar:
  order: 15
title: "Desktop app (beta)"
topic: "Getting started"
resource_type: tutorial
description: "Download the Tedix app for Mac, sign in, and connect your agents without a terminal."
summary: "Download and set up the Tedix app for Mac"
read_when:
  - Installing Tedix on a Mac
  - Connecting Claude Code, Codex, Devin or OpenCode to Tedix
visibility: public
---

# Desktop app (beta)

The Tedix app brings your Tedix organization to your Mac and lets your agents
pick up Tedix tasks on this computer. You set everything up with clicks;
no terminal is needed.

## Download

- [Download for Mac with Apple chip](https://downloads.tedix.dev/desktop/latest/Tedix-darwin-arm64.zip)
- [Download for Mac with Intel chip](https://downloads.tedix.dev/desktop/latest/Tedix-darwin-x64.zip)

Not sure which one? Open the Apple menu, choose **About This Mac**, and look
at **Chip**.

**First-open warning:** this beta is not signed with an Apple Developer ID
or notarized by Apple. macOS blocks the first open because it cannot verify
Tedix is free of malware. You must explicitly allow Tedix in **System
Settings → Privacy & Security**. Only do this if you trust the download from
the links above; allowing it does not mean Apple has checked it for malware.

## Set it up

1. Open the downloaded file and move **Tedix** to your Applications folder.
2. Open **Tedix** from Applications. If macOS blocks it, dismiss the alert
   without moving Tedix to the Trash. Depending on your macOS version and
   security settings, the alert may say Apple could not verify Tedix is free
   of malware, the developer cannot be verified, or Tedix was not downloaded
   from the App Store.
3. Open **System Settings → Privacy & Security**, scroll down to **Security**,
   and choose **Open Anyway** beside the message about Tedix. Confirm
   **Open** in the next warning and enter your Mac administrator password
   when asked. If **Open Anyway** is missing, try opening Tedix again, then
   return to Privacy & Security. If your Mac is managed by your organization
   and does not allow this, ask its administrator.
4. In Tedix, choose **Try a demo** to explore a sample on your Mac, or
   **Sign in** to use your Tedix account. Finish signing in in your browser
   and return to Tedix.
5. Choose **Open Tedix**, or choose **Connect an app** to add Tedix to an app
   you already use. Tedix opens a sign-in page when the app needs one.

macOS remembers this exception for the app, so later opens do not normally
need these steps. Do not disable your Mac's security checks or override an
alert that says the app is damaged or will damage your computer. See
[Apple's guide to safely opening apps](https://support.apple.com/en-us/102445)
for more about these warnings.

You can connect an app later in **Settings → Agents**. To start over with an
app, choose **Remove Tedix** on its row, then **Connect**. Tedix asks first
and switches that app off for tasks. Removing Tedix ends only that install's
Tedix sign-in. Other agents, installs and CLI logins stay signed in. If
removal cannot reach the server, the connection stays so you can try again.
If you installed both the Mac app and a separate coding tool for the same
provider, Tedix uses the Mac app when its coding tool is ready.

- **Codex in ChatGPT and Claude Code.** Settings → Agents has a section for
  each app. Choose **Connect** to install the Tedix plugin supplied with the
  Mac app. For Codex, review the hooks in **Settings → Hooks** in ChatGPT. In
  Claude Desktop, open the **Code** tab once. Tedix looks for agents again
  when you come back to it; the round arrow next to **Agents** looks at once.
- **Chat and Cowork in Claude.** In the Claude section, choose **Copy
  marketplace** and **Open Claude**. In Claude, choose **Customize → Plugins
  → Add marketplace**, paste `tedix-hq/tedix-plugins` and install **Tedix**.
  Then open the plugin's **Connectors** tab and sign in. Claude keeps the
  plugin up to date. If your organization turns off marketplaces, choose
  **Save plugin file** and use **Add → Upload plugin** instead. For local
  hooks, use the **Claude Code** connection. Plugin availability depends on
  your Claude account settings.
- **Devin and OpenCode.** Choose **Connect** and finish browser sign-in.
  Tedix checks the connection after sign-in. Choose **Check connection** to
  check an app you already connected.

To let an agent work on your Tedix tasks from this Mac, switch it on in
**Settings → Agents**. Each app shows its own icon. Which agent takes which
kind of task, the rules file and the project folder are under **Advanced**.
Tasks run only while Tedix is open, so this also turns on **Open at login**
in **Settings → General**. Switching off the last agent turns it off again.

## Try the demo

Choose **Explore sample** to browse the demo project and files. It runs on
this Mac without an account. Tedix shows what it is getting ready while the
workspace opens.

- **Chat on this Mac** opens a separate chat with a model running in Ollama
  or LM Studio. Tedix looks for models automatically. Start either app with
  a chat model if Tedix cannot find one.
- **Connect Cloudflare** enables chat inside the demo workspace. Sign in to
  Cloudflare, pick an account with Workers AI access, and enter your AI
  Gateway name if you use one. Cloudflare may charge that account for demo
  chat requests. Prompts and content used for the reply go to Cloudflare.

Choose **Back to setup** or close the demo window to return to sign-in.

## Run setup again

Choose **Tedix → Set up this Mac…**. Replacing the app in Applications keeps
your saved setup, including the local demo. To test the first launch from
scratch, create a separate macOS user in **System Settings → Users & Groups**
and open Tedix there. Your current macOS user keeps its demo and sign-ins.

## Quitting and updating

If you quit Tedix while tasks are running on your Mac, they continue where
they stopped when you open Tedix again.

When a new version is available, **Update Tedix** appears in the app menu
and the menu bar menu. It installs only when you click it.

Tedix Cloud is open by invitation; see [Release status](./release-status.md).
