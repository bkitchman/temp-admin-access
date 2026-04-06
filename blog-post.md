# Building a Zero-Trust Temporary Admin Access Workflow on macOS

> How I replaced the "just make them a local admin" workaround with a Slack-approved, time-limited, fully audited elevation pipeline.

**Tags:** AWS Lambda · Iru MDM · SAP Privileges · Slack · DynamoDB · EventBridge · Node.js · macOS

---

## The Problem

Every IT team knows the conversation. A developer needs to install a dependency. An engineer needs to run a system-level diagnostic. A designer needs to update a font cache. The ask is always the same: *"Can you just make me a local admin for a bit?"*

The traditional answers are both bad. Option A: give them permanent local admin rights, accept the expanded attack surface, and hope they don't accidentally break their system or run a malicious installer. Option B: have IT remote in every single time, creating a bottleneck that interrupts both the user and the IT team.

I wanted a third path: **just-in-time admin access, approved in Slack, time-limited to 30 minutes, and fully audited**. No persistent privilege. No IT babysitting. A complete audit trail of every command run during the window.

> **Goal:** Users get self-service access in under 60 seconds. IT maintains approval control. Every session auto-expires. Every sudo command is logged and shipped to the Slack thread.

---

## How It Works

1. **User opens Iru Self Service and clicks "Request Admin Access"**
   A script prompts for a reason via osascript dialog, collects device identity (hostname, serial), and POSTs a signed request to an API Gateway endpoint.

2. **IT receives an interactive Slack approval message**
   The request includes user, hostname, serial, and reason. Approve/Deny buttons are shown with a confirmation dialog. The message is posted to a dedicated IT channel.

3. **IT clicks Approve — Iru tag assigned + background approval monitor detects approval**
   The elevation tag is added to the device. A background LaunchDaemon (installed by the Self Service script before it exits) polls the `/status` endpoint every 20 seconds. When it detects approval, it calls `iru run` directly on the device — the fastest path to processing Library Items without a full inventory collection. The user sees an "approved" alert within 20 seconds and is elevated shortly after.

4. **Device runs elevation-start.sh via Iru Library Item**
   The script calls `PrivilegesCLI --add` to grant admin, enables a sudoers drop-in for command logging, notifies the backend to start the 30-minute timer, and installs a network monitor LaunchDaemon.

5. **EventBridge sends a 5-minute warning DM, then fires expiration at T+30**
   Timers are anchored to when the device confirms elevation — not when IT clicks Approve — so the full 30 minutes is always available. EventBridge schedules auto-delete after firing.

6. **On expiration, Iru removes the tag and collects the sudo log**
   A second Iru tag triggers `collect-sudo-log.sh`, which reads the sudoers logfile, ships it to the backend, and the backend uploads it as a file attachment in the original Slack approval thread.

---

## Architecture

The backend is a fully serverless AWS SAM application. There's no always-on infrastructure — all compute is Lambda functions invoked by API Gateway or EventBridge Scheduler.

| Component | Role |
|---|---|
| **API Gateway + Lambda** | 9 Lambda functions handle request intake, Slack actions, device confirmations, log receipt, status polling, and expiration. All endpoints are behind API key authentication. |
| **DynamoDB** | Single-table design stores each request's full lifecycle: status, timestamps, Slack thread IDs, Iru device ID, and actor identity for every state transition. |
| **EventBridge Scheduler** | One-time schedules are created per session for the 5-minute warning (T+25) and expiration (T+30). Schedules auto-delete after firing via `ActionAfterCompletion: DELETE`. |
| **Iru MDM** | Two Iru tags act as a signal layer. Assigning the elevation tag triggers the Privileges profile. Assigning the log-collection tag triggers log shipping. Device-side `iru run` forces immediate Library Item processing. |
| **SAP Privileges** | Open-source macOS app from SAP that provides controlled, time-limited local admin elevation via a LaunchAgent. Scoped via a Iru configuration profile so it only activates on tagged devices. |
| **System Keychain** | The shared API key is stored in the system keychain (accessible by root) via a provisioning script run once at device setup. Scripts retrieve it at runtime — never hardcoded. |

### The Slack ↔ Lambda Handshake

Slack requires a 200 response within 3 seconds of an interactive action. But processing an approval — hitting Iru, writing to DynamoDB, creating EventBridge schedules — takes longer. The solution is a two-Lambda pattern:

1. `handleSlackAction` verifies the Slack HMAC-SHA256 signature, extracts the action, and immediately invokes `processSlackAction` asynchronously (`InvocationType: 'Event'`).
2. `handleSlackAction` returns 200 to Slack within milliseconds.
3. `processSlackAction` runs independently and handles all the heavy work.

Actor identity (Slack user ID and username of the IT admin who clicked) is forwarded in the async payload and stored in DynamoDB for the audit trail.

### Timer Anchoring

An early design mistake: the 30-minute timer was started at approval time. But there's latency between IT clicking Approve and the device actually being elevated — MDM check-in, Iru running the script, PrivilegesCLI executing. A user could lose 3–5 minutes of their window before they even had admin.

The fix: `elevation-start.sh` POSTs to a `/start` endpoint when elevation is confirmed on the device. The backend creates the EventBridge schedules from that timestamp. The user always gets a full 30 minutes from the moment they're actually elevated.

```bash
# elevation-start.sh — notify backend that elevation is confirmed
HTTP_STATUS=$(curl -s -o "$ELEVATION_RESPONSE_FILE" -w "%{http_code}" \
  -X POST "$API_ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  --max-time 15 \
  -d "{\"requestId\":\"$REQUEST_ID\",\"serial\":\"$SERIAL\"}")
```

---

## Security Features

After eleven rounds of security audits, the system incorporates defense-in-depth across every layer:

- **Slack Signature Verification** — Every webhook verified with HMAC-SHA256. Requests older than 5 minutes rejected. Timing-safe comparison via `crypto.timingSafeEqual`.
- **DynamoDB Conditional Writes** — All status transitions use `ConditionExpression` to enforce valid state machine transitions atomically. Two IT admins clicking Approve simultaneously results in exactly one approval.
- **Input Validation Everywhere** — UUID format validation on all device-facing endpoints. Field length limits. Serial validated as 8–14 uppercase alphanumeric before embedding in generated scripts.
- **Slack mrkdwn Injection Prevention** — All user-controlled fields passed through `escapeSlack()` before embedding in Block Kit messages.
- **Device Identity Binding** — Serial stored at request time is validated against every subsequent device call. A device can only interact with its own session.
- **Network Loss Revocation** — A LaunchDaemon polls every 60 seconds. If network is lost, PrivilegesCLI immediately removes admin. Auth errors (401/403) trigger fail-secure revocation rather than retrying.
- **IT Slash Command** — `/admin-status` restricted to a configured allowlist of Slack user IDs. Empty allowlist defaults to denying all access (fail closed).
- **Secrets Management** — API key in the macOS system keychain. Lambda secrets injected via AWS SSM Parameter Store at deploy time.
- **Atomic Metadata Writes** — `mktemp` + `mv` pattern so a process crash mid-write never leaves a partial file.
- **`iru run` Mutex Lock** — File lock at `/var/run/iru-run.lock` serializes all `iru run` invocations across three background daemons, eliminating agent contention.

---

## Key Design Decisions

### Why Iru Tags as Signals?

Iru Library Items can be scoped to specific device tags. By creating a Library Item scoped to the `temp-admin-elevation` tag, we get Iru's built-in delivery guarantees: retry on failure, run-at-install semantics, and immediate execution on `iru run`. We don't need to build our own device delivery mechanism — Iru handles it.

### Why SAP Privileges Instead of `dseditgroup`?

Direct `dseditgroup` calls add the user to the local admin group and require corresponding cleanup. SAP Privileges integrates with macOS's authorization model, provides a visible UI indicator to the user, supports an `ExpirationInterval` MDM key as a safety-net fallback, and is open-source with active maintenance. The MDM profile approach also means the app only functions on tagged devices.

### Why Two Iru Tags?

Separation of concerns. The elevation tag is removed on revocation or expiration. The log-collection tag is assigned on revocation or expiration. These events are often simultaneous but not always. Keeping them separate avoids race conditions and makes each Library Item's trigger unambiguous.

### Why EventBridge Scheduler Instead of SQS Delayed Messages?

EventBridge Scheduler supports named one-time schedules that can be deleted by name. This is critical for the revoke flow: if IT manually revokes at T+15, we need to cancel the T+25 warning and T+30 expiration schedules. SQS delayed messages can't be cancelled after enqueuing.

---

## Lessons Learned

**The real attack surface is the device, not the backend.**
Most of the interesting security findings were in the shell scripts — unvalidated data embedded in generated scripts, metadata files with wrong permissions, Python subprocesses without timeouts. The Lambda code is easy to reason about; the device-side bash is where subtle bugs hide. Treat shell scripts as first-class security artifacts.

**Race conditions require database-level guards, not application-level checks.**
The pattern of "fetch → check status → update" is a TOCTOU race. Two concurrent Lambda invocations can both pass the check and both apply the update. DynamoDB's `ConditionExpression` moves the check into the atomic write operation. This is non-negotiable for state machines where each transition should happen exactly once.

**Anchor timers to device confirmation, not approval.**
Any time you have an async pipeline (approve → MDM deliver → device run → confirm), the end user's experience is only as good as the last step. Anchoring timers to device confirmation cost one extra API call but resulted in users always getting the full 30-minute window they were promised.

**Iterative security auditing finds what point-in-time reviews miss.**
Running eleven rounds of security audits found meaningful issues in almost every round. Not because earlier rounds were bad — but because fixing issues and adding features creates new surface area. Build security review into your iteration cycle, not just your launch gate.

**Zero open findings is achievable — but accept risk explicitly, not by omission.**
The accepted-risk items (timing side-channels, async Lambda pattern, system keychain access) were each evaluated deliberately. Accepted risk with documented rationale is categorically different from unfixed risk with no explanation.

**Escape at the output boundary, not at ingestion.**
Early versions tried to sanitize user input at ingestion time. This leads to double-encoding bugs and false confidence. The correct approach: store raw data, escape at every output boundary (Slack mrkdwn, JSON, shell variables).

**Never call a process runner from within a script being run by that process runner.**
`elevation-start.sh` was calling `iru run` at the end of its own execution — but it runs *inside* a `iru run` triggered by the approval monitor. The Iru agent holds an internal lock during execution; the nested call deadlocked indefinitely. A nested `iru run` inside a Iru script is a deadlock by construction.

**Verify the check actually checks something.**
The UTF-8 validation in `receiveLog` was `Buffer.from(x).equals(Buffer.from(x))` — a tautology that always returns true. It passed code review because it *looked* correct. Always test security checks with an input that *should* fail. A check that never rejects is not a check.

---

## Stats

| Metric | Value |
|---|---|
| Lambda functions | 10 |
| Device shell scripts | 5 |
| Max elevation window | 30 minutes |
| Approval → elevated | < 60 seconds |
| Slack → approval latency | ~3 seconds |
| Security fixes applied | 88 |

---

## What's Next

- **Extended audit retention:** Export DynamoDB records to S3 before TTL expiration for long-term compliance storage.
- **Trend dashboard:** Surface reason categories and per-team request frequency in a simple read-only view for IT leadership.
- **Rotation-aware off-hours:** Pull the on-call rotation from PagerDuty or a schedule table rather than a static Slack user ID.

---

*Questions or want to discuss the architecture? This was built for a macOS-first environment using Iru as the MDM, but the core pattern — Slack-gated JIT access with EventBridge timers and MDM tag signaling — translates to other MDM platforms with an API.*

*The full source is on [GitHub](https://github.com/bkitchman/temp-admin-access).*
