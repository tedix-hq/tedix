---
title: "Get support"
description: "Ask for help with Tedix, follow your request, and find the answer."
summary: "How to ask for help, what Support does next, and where to read the reply"
read_when:
  - Getting help with a Tedix workflow
  - Filing or following a support ticket from an agent
  - Understanding how Support replies
visibility: public
---

# Get support

If something in Tedix is stopping you from working, you can ask Support for
help and follow the answer in Tedix OS. Start by choosing **Get help**.

Tedix Cloud is an invited beta. See [Release status](./release-status.md)
for what is available today.

## Ask for help

1. Open **Get help** in Tedix OS.
2. Give the request a short title. Say what you were trying to do, what you
   expected, and what happened instead. Add the steps that caused the problem
   and how it affects your work.
3. Check the page and error details filled in by the form. Edit them if needed.
   Leave out passwords, access keys, private messages, customer records,
   screenshots, and full logs.
4. Preview the report. Approve sharing that report with your organization and
   Tedix Support, then choose **File support request**.

You receive a request number and a link to its Work item. Keep that link.
It confirms that your request was saved; Support still needs to review it.
People who can normally read your organization's Work can read that item.

## What happens next

The Support tedi checks the documentation, known problems, and previous
answers. It prepares a reply with sources and a next step. If the problem
needs investigation, it asks engineering to investigate.

A designated person reviews the draft before publishing the answer to you.
A tedi's draft does not go straight to you. Support aims to respond within
one hour and resolve the request or give a clear next step within two days.
These are targets, not a promise of a fix by a particular date.

## Find the answer

Open **Work → Feed → Apps → Office** in Tedix OS and look for **Support**. Your request
shows its status, who needs to act next, and when the next update is due.
The latest published reply appears there. Use the request's Work link to
open its history.

The reply appears in Tedix OS; publishing it does not send an email.
Try the suggested steps and tell Support whether you can work again. If the
problem remains, share what happened so the request can be followed up or
reopened. A code fix alone does not confirm that your problem is solved.

## Ask through your agent

A signed-in tedi, Codex session, or supported ChatGPT connector can file and
follow a request for you if it has permission to read and write your
organization's Work. Ask it to show you the report and who will receive it
before sending. It needs your approval for what it shares.

Your agent uses `file_support_request` to submit the report and
`get_support_status` to read replies. It must first discover those tools
through your connection, because their names can have different prefixes.
For follow-ups, it uses the same request number, checks the current version,
and asks you to approve any new report. These tools show your published
updates, not Support's private drafts or investigation notes.

## If you cannot sign in

Use the contact channel published by the person who runs your Tedix
installation. Email support works only if they have set up and verified a
support address. Installing Tedix does not create a public support inbox.

When that email option is configured, incoming mail first waits for a person
to check the sender, organization, and report before creating a support
request. The original message and attachments stay in the mailbox. A tedi
does not automatically read that message or reply to it, and an email address
alone does not prove that someone belongs to an organization.

If you run an installation, the [factory guide](./factory-agent-guide.md)
explains how to inspect and set up a factory. Support needs its own tedi and
a person responsible for reviewing replies. Give that tedi only the tools
needed to read requests, prepare answers, and ask for help with investigations.
