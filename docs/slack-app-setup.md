# Slack App Setup Guide

## 1. Create the App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App → From scratch**.
2. Name it something like **IT Admin Access** and select your workspace.

---

## 2. OAuth Scopes

Under **OAuth & Permissions → Scopes → Bot Token Scopes**, add:

| Scope | Purpose |
|---|---|
| `chat:write` | Post approval messages and thread replies |
| `im:write` | Open DM channels with users |
| `files:write` | Upload sudo log as attachment |
| `users:read` | Read user info |
| `users:read.email` | Look up users by email to resolve Slack IDs from macOS usernames |

---

## 3. Install the App

1. Under **OAuth & Permissions**, click **Install to Workspace**.
2. Copy the **Bot User OAuth Token** (starts with `xoxb-`). This is your `SLACK_BOT_TOKEN`.

---

## 4. Enable Interactivity

1. Go to **Interactivity & Shortcuts**.
2. Toggle **Interactivity** on.
3. Set the **Request URL** to your API Gateway `/slack/actions` endpoint:
   ```
   https://<your-api-id>.execute-api.<region>.amazonaws.com/Prod/slack/actions
   ```
4. Save changes.

---

## 5. Signing Secret

1. Under **Basic Information → App Credentials**, copy the **Signing Secret**.
2. This is your `SLACK_SIGNING_SECRET` — used to verify that Slack requests are genuine.

---

## 6. IT Channel ID

1. Right-click the IT admin channel in Slack → **View channel details**.
2. Scroll to the bottom — the Channel ID looks like `C012AB3CD`.
3. This is your `SLACK_IT_CHANNEL_ID`.
4. **Invite the bot to the channel**: `/invite @IT Admin Access`

---

## 7. Email Domain (for DMs)

The `handleRequest` Lambda attempts to resolve macOS usernames to Slack user IDs via `users.lookupByEmail`. Set `EMAIL_DOMAIN` to your company's email domain (e.g. `company.com`) so it can construct `jdoe@company.com`. If the lookup fails, DMs are silently skipped.
