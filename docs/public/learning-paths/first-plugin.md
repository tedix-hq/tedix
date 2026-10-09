---
sidebar:
  order: 7
title: "Use Tedix in ChatGPT, Codex and Claude"
topic: "Learning paths"
resource_type: tutorial
description: "Add Tedix to Claude, Claude Code, Codex or the ChatGPT desktop app, sign in to your organization, and ask for your first Work in five minutes."
summary: "A first Tedix plugin setup in each supported host with expected results and symptom-led recovery"
read_when:
  - Using Tedix from ChatGPT, Codex, Claude or Claude Code for the first time
  - Choosing which host to connect to Tedix
  - Recovering a plugin install or host sign-in that does not work
visibility: public
---

# Use Tedix in ChatGPT, Codex and Claude

You already talk to an AI assistant every day. This tutorial adds your Tedix
organization to that assistant, so it can find your team's Work, ask a tedi for
help, and save a result where your colleagues can see it. It takes about five
minutes and needs no terminal unless you use Claude Code or Codex.

Installing the plugin gives your assistant a connection, not power. It cannot
change or run anything in your organization until you sign in and choose what
it may do, and even then every action follows your organization's policy.

## Before you start

You need:

- Tedix Cloud beta access: membership in an organization. Tedix Cloud is an
  invited beta; to request access, use the
  [contact page](https://tedix.dev/contact/);
- a browser in which you can sign in and approve the requested access; and
- one of the hosts below.

Never paste a token or password into a chat. Sign-in always happens in your
browser, and the connection URL is the same for every host:

```text
https://connect.mcp.tedix.dev/mcp
```

## 1. Pick your host

### Claude chat and Cowork

Open Claude's connector settings, add a custom connector named **Tedix**, and
paste the URL above. This gives Claude the Tedix tools; the bundled skills are
not included. Cowork runs in its own environment, so it cannot reach anything
on your laptop, such as a local Tedix.

**Expected result:** Tedix appears in Claude's list of connectors and offers to
sign in.

### Claude Code

In a terminal, run:

```sh
claude plugin marketplace add tedix-hq/tedix-plugins
claude plugin install tedix@tedix-plugins --scope user
```

Then, inside Claude Code, open `/mcp`, select the Tedix server, and sign in.
Use a current Claude Code release (2.1.274 or later); older versions cannot
talk to the Tedix gateway.

**Expected result:** `/mcp` shows the Tedix server as connected.

### Codex and the ChatGPT desktop app

In a terminal, run:

```sh
codex features enable mcp_2026_07_28
codex plugin marketplace add tedix-hq/tedix-plugins
codex plugin add tedix@tedix-plugins
codex mcp login tedix
```

The first command turns on the MCP protocol version Tedix requires; restart
Codex after it. The last one opens your browser to sign in. In the ChatGPT
desktop app, open the Plugins Directory, enable **tedix**, and start a new
**Work** chat.

**Expected result:** `codex mcp list` shows `tedix`, and a new Work chat offers
the Tedix plugin.

### ChatGPT on the web

Not supported yet. The Tedix plugin is not in the ChatGPT plugin directory, and
a developer-mode custom connector is not a tested path. Use the ChatGPT desktop
app or Codex instead.

## 2. Sign in and choose your organization

When the host asks you to sign in, a browser window opens. Sign in to Tedix,
pick the organization you want to use, and review the consent screen. It starts
with read access selected; add more only if you need it. You can reconnect later
to change this.

**Expected result:** the browser confirms the connection and you return to the
host. Nothing has been changed in your organization.

## 3. Say hello

In a new chat, type:

> Connect my Tedix account

**Expected result:** the assistant names your account and the organization it
connected, and makes one small read to prove the connection works.

Then try one of these:

- "Find the Work relevant to this task in my organization."
- "Ask a tedi to help with this task."
- "Save this result as an Output in this Tedix Workspace."

**Expected result:** the assistant finds Work, hands the task to a tedi and
shows the run's progress, or saves a result that your colleagues can open in
Tedix OS. If it needs an organization or destination you did not name, it asks.

## Optional: local hooks with the CLI

If you already use the [Tedix CLI](../cli.md), `tedix setup agents` installs
the same plugin into Claude Code and Codex and adds opt-in local hooks that
bring your repository's Tedix context into each session. Every hook stays
silent until you turn it on; the
[CLI guide](../cli.md#set-up-codex-and-claude-code) lists each one. The CLI
login and the host's Tedix sign-in are separate; signing in to one does not
sign you in to the other.

## If it does not work

Start with the symptom you see.

### The assistant does not know Tedix

The plugin is not enabled in this chat. Enable it in the host, then start a new
chat; an open chat does not pick up a new plugin. In Claude chat and Cowork,
check that the Tedix connector is added and turned on.

### `Not logged in` or an authorization error

The host has no Tedix sign-in yet. Repeat the sign-in for that host: `/mcp` in
Claude Code, `codex mcp login tedix` in Codex, or the connector's sign-in in
Claude. Signing in to the CLI does not help here.

### Your organization is missing in the browser

Cloud access and organization membership are separate. Ask the person who
invited you to confirm your membership. If you have no Cloud access yet, request
it through the [contact page](https://tedix.dev/contact/) and wait for beta
admission. No one can fix this by sending you a token.

## Reference

- [Claude chat and Cowork guide](https://github.com/tedix-hq/tedix/blob/main/plugins/tedix/docs/claude.md)
- [Claude Code guide](https://github.com/tedix-hq/tedix/blob/main/plugins/tedix/docs/claude-code.md)
- [Codex and ChatGPT guide](https://github.com/tedix-hq/tedix/blob/main/plugins/tedix/docs/chatgpt-codex.md)
- [tedix-hq/tedix-plugins](https://github.com/tedix-hq/tedix-plugins), the
  published plugin and marketplace
- [Run a digital worker](./first-worker.md) for your first result with a tedi
