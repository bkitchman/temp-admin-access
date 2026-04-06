# Kandji Setup Guide

## 1. Create the Two Tags

In the Kandji web console, go to **Devices → Tags** and create both tags:

| Tag | Purpose |
|---|---|
| `temp-admin-elevation` | Assigned on approval — scopes SAP Privileges and `elevation-start.sh` |
| `temp-admin-log-collection` | Assigned on expiration/revocation — triggers `collect-sudo-log.sh` |

The tag names must match the `KandjiElevationTag` and `KandjiLogCollectionTag` SAM parameters exactly.

---

## 2. Add SAP Privileges to the Library

1. Go to **Library → Add Library Item → App**.
2. Add **Privileges** by SAP SE (available via the Kandji App Catalog, or upload the `.pkg` from the [SAP GitHub release](https://github.com/SAP/macOS-enterprise-privileges/releases)).
3. Under **Assignment Rules**, scope to devices with the tag `temp-admin-elevation`.
4. Set install behavior to **Continuously Enforce** so it is removed when the tag is revoked.

---

## 3. Upload the Privileges MDM Configuration Profile

1. Go to **Library → Add Library Item → Custom Profile**.
2. Upload `infrastructure/privileges-config.mobileconfig` from this repository.
3. Before uploading, replace the placeholder UUID values — generate two UUIDs (e.g. with `uuidgen` on macOS) and substitute them for the `<!-- generate a UUID -->` comments.
4. Under **Assignment Rules**, scope to devices with the tag `temp-admin-elevation`.

The profile configures:
- `EnforcePrivileges: user` — default state is standard user
- `DockToggleTimeout: 30` — backstop auto-demotion after 30 min (safety net if Lambda fails)
- `ReasonRequired: false` — user already provided a reason at request time

---

## 4. Upload the Shell Scripts

There are three scripts to add as Kandji Library Items. Use [kst](https://github.com/kandji-inc/kst) to manage them (recommended), or upload manually.

### Option A: kst (recommended)

```bash
# Install kst
brew tap kandji-inc/kst https://github.com/kandji-inc/kst.git && brew install kst

# Set credentials
export KST_TENANT="yourorg.kandji.io"
export KST_TOKEN="your-kandji-api-token"

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
| Assignment Rules | Scope to tag `temp-admin-elevation` |

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

Run `scripts/provision-api-key.sh` on each managed device to store the shared API key in the macOS system keychain. The easiest way is to add it as a Kandji Library Item scoped to all managed devices and run it once.

The script stores the key under:
- Account: `kandji-temp-admin`
- Service: `kandji-temp-admin-api`
- Keychain: `/Library/Keychains/System.keychain` (accessible by root without user interaction)

```bash
# The script requires one argument: the API key value
sudo ./scripts/provision-api-key.sh "your-self-service-api-key"
```

---

## 6. Kandji API Token

1. Go to **Settings → Access → API Token**.
2. Create a token with:
   - `Devices: Read` — resolve serial number to device ID
   - `Devices: Write` — assign and remove tags
3. Copy the token — this is your `KANDJI_API_TOKEN` SAM parameter.

Your tenant API base URL is `https://<subdomain>.api.kandji.io`. Find it at **Settings → Access → API URL**. This is your `KANDJI_BASE_URL` SAM parameter.

---

## 7. Verify the Flow

1. Assign the `temp-admin-elevation` tag to a test device manually in Kandji.
2. Confirm `elevation-start.sh` runs and the user gains admin.
3. Remove the tag — confirm admin is revoked.
4. Assign `temp-admin-log-collection` — confirm `collect-sudo-log.sh` runs and a log appears in Slack.
5. Remove the tag.

Once this works manually, the Lambda functions will drive tag assignment automatically via the API.
