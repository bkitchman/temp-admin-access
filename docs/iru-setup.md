# Iru Setup Guide

## 1. Create the Five Tags

In the Iru web console, go to **Devices → Tags** and create all five tags:

| Tag | SAM Parameter | Purpose |
|---|---|---|
| `temp-admin-elevation-5min` | `IruElevationTag5Min` | Assigned on 5-min approval — scopes SAP Privileges profile |
| `temp-admin-elevation-10min` | `IruElevationTag10Min` | Assigned on 10-min approval — scopes SAP Privileges profile |
| `temp-admin-elevation-15min` | `IruElevationTag15Min` | Assigned on 15-min approval — scopes SAP Privileges profile |
| `temp-admin-elevation-30min` | `IruElevationTag30Min` | Assigned on 30-min approval — scopes SAP Privileges profile |
| `temp-admin-log-collection` | `IruLogCollectionTag` | Assigned on expiration/revocation — triggers `collect-sudo-log.sh` |

The tag names must match the corresponding SAM parameter values exactly.

---

## 2. Add SAP Privileges to the Library

1. Go to **Library → Add Library Item → App**.
2. Add **Privileges** by SAP SE (available via the Iru App Catalog, or upload the `.pkg` from the [SAP GitHub release](https://github.com/SAP/macOS-enterprise-privileges/releases)).
3. Under **Assignment Rules**, scope to devices with the tag `temp-admin-elevation`.
4. Set install behavior to **Continuously Enforce** so it is removed when the tag is revoked.

---

## 3. Upload the SAP Privileges MDM Configuration Profiles

The system uses four duration-specific mobileconfig profiles — one per approved duration. Each profile sets `ExpirationInterval` to enforce SAP Privileges' built-in auto-demotion timer as a safety backstop if the Lambda expiration fails.

The profiles are pre-built and can be uploaded via the Iru API (see `scripts/` for the upload commands) or manually through the console:

1. Go to **Library → Add Library Item → Custom Profile**.
2. Upload each of the four profiles from `kst-repo/profiles/`:
   - `SAP Privileges - 5 min/` → scope to tag `temp-admin-elevation-5min`
   - `SAP Privileges - 10 min/` → scope to tag `temp-admin-elevation-10min`
   - `SAP Privileges - 15 min/` → scope to tag `temp-admin-elevation-15min`
   - `SAP Privileges - 30 min/` → scope to tag `temp-admin-elevation-30min`
3. For each profile, set **Assignment Rules** → scope to the matching duration tag only.
4. Set **Continuously Enforce** so the profile is removed when the elevation tag is revoked.

Each profile configures:
- `ExpirationInterval: <N>` — SAP Privileges auto-demotes after N minutes (safety backstop)
- `EnforcePrivileges: user` — default state is standard user
- `ReasonRequired: false` — user already provided a reason at request time

---

## 4. Upload the Shell Scripts

There are three scripts to add as Iru Library Items. Use [kst](https://github.com/iru-inc/kst) to manage them (recommended), or upload manually.

### Option A: kst (recommended)

```bash
# Install kst
brew tap iru-inc/kst https://github.com/iru-inc/kst.git && brew install kst

# Set credentials
export KST_TENANT="yourorg.iru.io"
export KST_TOKEN="your-iru-api-token"

# Initialize a local repo and pull all existing scripts
kst new kst-repo
cd kst-repo
kst script pull --all

# After editing scripts, push changes
cp ../scripts/self-service-request.sh  "scripts/SAP_ 2-Request Admin Access/audit"
cp ../scripts/elevation-start.sh       "scripts/SAP_ 3-elevation-start/audit"
cp ../scripts/collect-sudo-log.sh      "scripts/SAP_ 4-collect-sudo-log/audit"
kst script sync
```

### Option B: Manual upload

For each script, go to **Library → Add Library Item → Custom Script** and paste the script contents.

#### Script 1: `self-service-request.sh` — Self Service request script

| Setting | Value |
|---|---|
| Name | `SAP: 2-Request Admin Access` (or your preferred name) |
| Execution Frequency | Run on demand |
| Show in Self Service | ✅ Yes |
| Self Service name | `Request Temporary Admin Access` |
| Self Service description | `Request time-limited local admin access. Your request will be sent to IT for approval.` |

Before uploading, update the two hardcoded URLs at the top of the script:
```bash
API_ENDPOINT="https://YOUR_API_GATEWAY_URL/Prod/request"
STATUS_ENDPOINT="https://YOUR_API_GATEWAY_URL/Prod/status"
```

#### Script 2: `elevation-start.sh` — Elevation start

| Setting | Value |
|---|---|
| Name | `SAP: 3-elevation-start` |
| Execution Frequency | Every day (runs at install / tag assignment) |
| Assignment Rules | Scope to **any** of the four elevation tags (OR condition): `temp-admin-elevation-5min`, `temp-admin-elevation-10min`, `temp-admin-elevation-15min`, `temp-admin-elevation-30min` |

Before uploading, update the API endpoint:
```bash
API_ENDPOINT="https://YOUR_API_GATEWAY_URL/Prod/start"
```

#### Script 3: `collect-sudo-log.sh` — Sudo log collection

| Setting | Value |
|---|---|
| Name | `SAP: 4-collect-sudo-log` |
| Execution Frequency | Every day (runs at install / tag assignment) |
| Assignment Rules | Scope to tag `temp-admin-log-collection` |

Before uploading, update the API endpoint:
```bash
API_ENDPOINT="https://YOUR_API_GATEWAY_URL/Prod/log"
```

---

## 5. Provision the API Key on Devices

Run `scripts/provision-api-key.sh` on each managed device to store the shared API key in the macOS system keychain. The easiest way is to add it as a Iru Library Item scoped to all managed devices and run it once.

The script stores the key under:
- Account: `iru-temp-admin`
- Service: `iru-temp-admin-api`
- Keychain: `/Library/Keychains/System.keychain` (accessible by root without user interaction)

```bash
# The script requires one argument: the API key value
sudo ./scripts/provision-api-key.sh "your-self-service-api-key"
```

---

## 6. Iru API Token

1. Go to **Settings → Access → API Token**.
2. Create a token with:
   - `Devices: Read` — resolve serial number to device ID
   - `Devices: Write` — assign and remove tags
3. Copy the token — this is your `IRU_API_TOKEN` SAM parameter.

Your tenant API base URL is `https://<subdomain>.api.iru.io`. Find it at **Settings → Access → API URL**. This is your `IRU_BASE_URL` SAM parameter.

---

## 7. Verify the Flow

1. Assign `temp-admin-elevation-15min` to a test device manually in Iru.
2. Confirm `elevation-start.sh` runs and the user gains admin.
3. Remove the tag — confirm admin is revoked.
4. Assign `temp-admin-log-collection` — confirm `collect-sudo-log.sh` runs and a log appears in Slack.
5. Remove the tag.
6. Repeat step 1 with each of the other three duration tags to confirm all four profiles activate correctly.

Once this works manually, the Lambda functions will drive tag assignment automatically via the API, using the duration chosen by the user at request time.
