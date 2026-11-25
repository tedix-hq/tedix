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

## Set it up

1. Open the downloaded file and move **Tedix** to your Applications folder.
2. Open Tedix and choose **Try a demo** to explore a sample on your Mac, or
   **Sign in** to use your Tedix account. Finish signing in in your browser
   and return to Tedix.
3. Choose **Open Tedix**, or choose **Connect an app** to add Tedix to an app
   you already use. Tedix opens a sign-in page when the app needs one.

You can connect an app later in **Settings → Agents**. To start over with an
app, switch off its **Use for tasks**, choose the trash icon on its row, then
**Connect**.
If you installed both the Mac app and a separate coding tool for the same
provider, Tedix uses the Mac app when its coding tool is ready.

- **ChatGPT Work and Claude Code.** Choose **Connect** to install the Tedix
  plugin supplied with the Mac app. For ChatGPT Work, review the hooks in
  **Settings → Hooks** in ChatGPT. In Claude Desktop, open the **Code** tab
  once and choose **Look again** in Tedix if Claude Code does not appear.
- **Claude (Cowork).** Choose **Copy marketplace** and **Open Claude**.
  In Claude, choose **Customize → Plugins → Add marketplace**, paste
  `tedix-hq/tedix-plugins` and install **Tedix**. Then open the plugin's
  **Connectors** tab and sign in. Claude keeps the plugin up to date. If your
  organization turns off marketplaces, choose **Save plugin file** and use
  **Add → Upload plugin** instead. For local hooks, use the **Claude Code**
  connection. Plugin availability depends on your Claude account settings.
- **Devin and OpenCode.** Choose **Connect** and finish browser sign-in.
  Tedix checks the connection after sign-in. Choose **Check connection** to
  check an app you already connected.

To let an agent run tasks on your Mac, use **Use for tasks** in Settings.
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
