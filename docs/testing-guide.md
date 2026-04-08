# Testing Guide — temp-admin-access

> **Version:** v1.2.0  
> **Environment:** kitchman.iru.com  
> **Legend:** 🤖 Automatable · 👤 Manual · ⏱ Requires waiting

---

## Pre-flight Checklist

Before starting any test:
- [ ] Stack deployed (`aws cloudformation describe-stacks --stack-name temp-admin-access --query 'Stacks[0].StackStatus'` → `UPDATE_COMPLETE`)
- [ ] `self-service-request.sh` installed in Iru Self Service Library
- [ ] `self-service-end.sh` installed in Iru Self Service Library
- [ ] API key provisioned to test device via `provision-api-key.sh`
- [ ] Dashboard URL accessible in browser

---

## 1. Request Submission

| # | Test | Expected | Type |
|---|------|----------|------|
| 1.1 | Run Self Service script — complete the form | Slack IT channel receives approval message with Approve/Deny buttons, user/device/reason/duration shown correctly | 👤 |
| 1.2 | Submit with no API key in keychain | Script exits with "API key not found" error, no Slack message | 👤 |
| 1.3 | Submit while already admin | Alert shows remaining time from meta.json, no new request created | 👤 |
| 1.4 | Dashboard link in Slack approval message | Opens dashboard filtered to requesting user, single-use token works once | 👤 |
| 1.5 | Submit a second request while one is pending | New request creates a separate Slack thread | 👤 |

---

## 2. Approval Flow

| # | Test | Expected | Type |
|---|------|----------|------|
| 2.1 | Click Approve in Slack | Thread reply confirms approval; user receives DM; device receives `approved` on next poll | 👤 |
| 2.2 | Approve with duration override (different from requested) | Thread shows overridden duration; Iru tag matches approved duration | 👤 |
| 2.3 | Click Deny in Slack | Thread reply confirms denial; user DM received; device monitor shows "denied" alert | 👤 |
| 2.4 | Double-click Approve (race test) | Only one approval processed; second click shows already-processed message | 👤 |

---

## 3. Elevation

| # | Test | Expected | Type |
|---|------|----------|------|
| 3.1 | After approval, run `iru run` on device | User is added to admin group within ~60s | 👤 |
| 3.2 | `elevation-start.sh` POSTs to /start | Timer anchored to device confirmation, not approval time; thread reply shows timer started | 👤 |
| 3.3 | Check `/var/log/iru-elevation.log` | Approval monitor logs `elevation confirmed` | 👤 |

---

## 4. Approval Monitor — Adaptive Polling Phases

| # | Test | Expected | Type |
|---|------|----------|------|
| 4.1 | Submit request, watch log for first 15 min | Log shows polls every ~20s | 👤 ⏱ |
| 4.2 | Still pending at 15 min | Log shows "too soon to poll (phase interval 300s)" — skipping most daemon fires | 👤 ⏱ |
| 4.3 | Still pending at 1 hr | Log shows "too soon to poll (phase interval 3600s)" | 👤 ⏱ |
| 4.4 | State file location | `/var/root/.iru-elevation/approval-state.json` exists, owned by root, mode 600 | 👤 |

---

## 5. Natural Session Expiry

| # | Test | Expected | Type |
|---|------|----------|------|
| 5.1 | Let approved session run to 5 min before expiry | User receives "5 minutes remaining" Slack DM | 👤 ⏱ |
| 5.2 | Session timer expires | Iru elevation tag removed; log-collection tag assigned; user DM sent; Slack thread updated | 👤 ⏱ |
| 5.3 | Device calls `iru run` after expiry | Admin removed from group | 👤 ⏱ |

---

## 6. Sudo Log Collection & AI Risk Scoring

| # | Test | Expected | Type |
|---|------|----------|------|
| 6.1 | Run some `sudo` commands during session, wait for expiry | `collect-sudo-log.sh` runs, log POSTed to /log, log appears in Slack thread | 👤 ⏱ |
| 6.2 | Open dashboard after log arrives | Risk score updated for user; score, level, key factors, and summary visible | 👤 |
| 6.3 | Risk score on user detail page | Score shown with colored border matching level; factors listed | 👤 |
| 6.4 | Run `aws lambda invoke` on computeRiskScore manually | Score written to DynamoDB within 10s | 🤖 |

---

## 7. IT Early Revocation

| # | Test | Expected | Type |
|---|------|----------|------|
| 7.1 | Click Revoke in Slack thread during active session | Thread reply "access revoked"; elevation tag removed; log collection triggered; EventBridge schedules deleted | 👤 |
| 7.2 | Network monitor on device detects revocation via /status poll | Admin removed; log collection script runs | 👤 |

---

## 8. User Self-Cancel

| # | Test | Expected | Type |
|---|------|----------|------|
| 8.1 | Run `self-service-end.sh` during active session | Alert "Session Ended"; Slack thread shows "Session ended by user" with elapsed time; log collection triggered | 👤 |
| 8.2 | Run `self-service-end.sh` with no active session (no meta.json) | Alert "No Active Session" | 👤 |
| 8.3 | Run `self-service-end.sh` after session already expired | 409 response; alert "No Active Session" | 👤 |
| 8.4 | Dashboard shows `completed_by_user` status | "✅ Ended by user" badge in green | 👤 |

---

## 9. Network Loss Revocation

| # | Test | Expected | Type |
|---|------|----------|------|
| 9.1 | Disconnect from network during active session | Network monitor daemon detects loss; elevation revoked; `revokeNetworkLoss` POST sent when network returns | 👤 |
| 9.2 | Dashboard shows `revokedByNetworkLoss` flag | "⚠️ Network Loss" badge | 👤 |

---

## 10. Pending Request Nudges & Auto-Deny

| # | Test | Expected | Type |
|---|------|----------|------|
| 10.1 | Submit request, do NOT approve for 10 min | Slack thread receives first nudge reply at ~10 min | 👤 ⏱ |
| 10.2 | Second nudge at 20 min, third at 30 min etc. (phase 1) | Thread replies continue every 10 min for first hour | 👤 ⏱ |
| 10.3 | Approve request at any point | No more nudges; `nudge-{requestId}` schedule gone from EventBridge | 👤 |
| 10.4 | Deny request | Same — nudge schedule cancelled | 👤 |
| 10.5 | Auto-deny at 24 h | Status set to `expired_unanswered`; thread reply; user DM; NOT reflected in risk score | 👤 ⏱ |
| 10.6 | Check CloudWatch logs for handlePendingNudge | Logs show correct phase, nudge count, next scheduled time | 👤 |

> **Shortcut for 10.5:** Deploy temporarily with `PendingAutoDenyHours=1 PendingNudgeIntervalMinutes=5` to test auto-deny in 1 hour instead of 24.

---

## 11. Off-Hours Auto-Approval

| # | Test | Expected | Type |
|---|------|----------|------|
| 11.1 | Submit request outside business hours with `ON_CALL_SLACK_USER_ID` set | Thread reply shows "Off-hours auto-approval"; request approved automatically | 👤 ⏱ |
| 11.2 | Submit request inside business hours | Normal approval flow, no auto-approval | 👤 |

---

## 12. IT Admin Dashboard

| # | Test | Expected | Type |
|---|------|----------|------|
| 12.1 | Open dashboard URL from Slack approval link | Dashboard loads, filtered to correct user | 👤 |
| 12.2 | Open dashboard URL directly (no token) | Redirected to login or 401 | 👤 |
| 12.3 | Use same single-use token twice | Second use rejected | 👤 |
| 12.4 | User list shows risk levels | Colored badges (Low/Medium/High/Critical/Unscored) | 👤 |
| 12.5 | Click user to see detail | Request history table, risk score block, "No IT response" stat if applicable | 👤 |
| 12.6 | Expand sudo log for a session | Log renders in monospace, scrollable | 👤 |

---

## 13. /admin-status Slash Command

| # | Test | Expected | Type |
|---|------|----------|------|
| 13.1 | `/admin-status` with no argument | Lists all active (approved + pending) sessions | 👤 |
| 13.2 | `/admin-status <requestId>` | Shows detail for that request | 👤 |
| 13.3 | Called by non-IT user | "Not authorized" ephemeral reply | 👤 |
| 13.4 | `/admin-status <requestId>` for expired_unanswered request | Shows ⏰ emoji and status | 👤 |

---

## 14. Device Lock (Emergency)

| # | Test | Expected | Type |
|---|------|----------|------|
| 14.1 | Click Device Lock in Slack thread during active session | MDM lock command sent via Iru; thread reply confirms | 👤 |

---

## Automation Candidates

### Can be fully automated (unit/integration tests)

| Area | Framework | What to test |
|------|-----------|-------------|
| Lambda input validation | Jest | Missing fields, invalid serial format, bad JSON, oversized fields |
| `handleRequest` business logic | Jest + DynamoDB mock | Reason classification, off-hours detection, duplicate detection |
| `handlePendingNudge` phase logic | Jest | Phase 1→2 transition, auto-deny threshold, nudgeCount bounds, requestCreatedAt from DB |
| `handleUserEnd` ownership check | Jest | Serial mismatch → 403, wrong status → 409, happy path |
| `computeRiskScore` filtering | Jest | `expired_unanswered` excluded, extractCommands both formats |
| Slack signature verification | Jest | Valid/invalid/missing signatures |
| `scheduler.js` ARN allowlist | Jest | Blocked ARN throws, allowed ARN passes |
| Cost estimate chart math | Node script | Verify totals at 100/500/1000 req match expected values |
| Dashboard status badge logic | Jest (jsdom) | All status strings render correct label and CSS class |

### Partially automatable (needs real AWS or mocking)

| Area | Approach |
|------|----------|
| API Gateway → Lambda end-to-end | AWS SAM `sam local start-api` + Jest HTTP client |
| DynamoDB conditional writes (race conditions) | LocalStack or DynamoDB Local |
| EventBridge schedule creation/deletion | Mock `@aws-sdk/client-scheduler` |
| Bedrock risk scoring | Mock `invokeClaudeJson` with fixture responses |

### Must stay manual

| Area | Reason |
|------|--------|
| Iru tag assignment/removal | Requires live Iru tenant and enrolled device |
| Slack interactive buttons | Requires real Slack workspace and signed payloads |
| MDM device lock | Requires enrolled device, irreversible mid-test |
| Network loss detection | Requires physical network manipulation on device |
| Self Service script UX | Requires macOS + Iru Self Service app |
| CloudFront/S3 dashboard delivery | Requires live AWS stack |
| End-to-end elevation timing | Requires Iru check-in cycle (~15 min) |
| 24-hour auto-deny | Time-based; use reduced interval for testing |
