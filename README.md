# PowerApps Solution Migrator

A local web tool that moves Power Apps / Dataverse **solutions** from one environment to another, either within the **same tenant** or **across tenants**.

| Requirement | Where it's handled |
|---|---|
| Same-tenant migration | Step 1 › **Same tenant**: one sign-in is used for both sides |
| Cross-tenant migration | Step 1 › **Cross tenant**: a separate sign-in (and account) for the target |
| Package only | Step 1 › **Package only**: export the filtered (and optionally renamed) solution for download, without importing it |
| PDF report | **Download report (PDF)** on Options & review, the summary and History |
| User registration | Organizations register (Supabase), verify the work email, and owners/admins approve colleagues before they can use the tool |
| Select tenant | A tenant drop-down per side, listing every tenant the account belongs to. Other tenants can be added by ID or domain |
| Select environment | An environment drop-down for the chosen tenant (Dataverse Global Discovery Service) |
| Select solution | Searchable list of the source environment's solutions. Managed ones are shown but can't be selected |
| Exclude components | Every component starts out selected. You can uncheck single components, subcomponents or whole component types |
| Different name at target | Options › **Use a different name**: set a new display name and unique name |
| Migration progress | Live overall % plus a status, progress bar and timing for each step, and an activity log |
| Summary | Result, counts, components by type, import warnings, next steps, and downloads for the package and import log |
| Error popup | A modal shows any error (API, sign-in, pre-flight or import), including the failed components |

## Start it (Windows)

1. Install **Node.js** (the LTS version) from https://nodejs.org, once.
2. Extract the zip, then double-click **`Start-Migrator.cmd`**.

The launcher installs or updates the required components when needed. They are included in the zip, so normally nothing is downloaded. It then starts the migrator in the background and opens it in your browser. The migrator has no window, and nothing for it appears in the taskbar.

On first start, enter your app registration's Client ID on the **Settings** page.

**Closing the migrator tab stops the migrator** (after any running migration finishes).

The server's messages go to `data\logs\migrator.log`. If it can't start, a message box says so. For troubleshooting, run `scripts\run-server.cmd` to see the messages in a window.

On the first start, the launcher also creates a **"PowerApps Solution Migrator"** shortcut with the Powercraft icon, in the folder and on your desktop. Use it from then on. If you delete the desktop shortcut it isn't recreated automatically; double-click `Create-Shortcuts.cmd` to get it back.

On macOS or Linux, run `./start-migrator.sh` instead.

## Quick start (demo mode, no Microsoft account needed)

```bash
npm install
npm run mock
```

Open http://localhost:3000. The demo has four tenants (Contoso, Contoso Labs, Fabrikam, Northwind) and several environments and solutions. Try these:

* **Contoso Sales Hub**: exclude a few components and rename the solution. The migration succeeds and the summary shows warnings.
* **Legacy Integration**: exclude the *plug-in assembly*. The import fails with a missing-dependency error popup.
* **Core Components** → *Fabrikam Production* as **Unmanaged**: the pre-flight check rejects it, because the target already has it as managed.

## Real use

### 1. App registration (Entra ID)

1. Go to Entra admin center › App registrations › **New registration**.
2. For **Supported account types**, choose *Accounts in any organizational directory (multitenant)*. Cross-tenant migration needs this.
3. Add the **Platform** *Mobile and desktop applications* with the redirect URI `http://localhost:3000/auth/callback`. Then, under Authentication, enable **Allow public client flows**.
   *Alternative:* use the *Web* platform with the same URI, create a client secret and set `CLIENT_SECRET`.
4. Add these delegated **API permissions**:
   * **Dynamics CRM › user_impersonation** (Dataverse and the Global Discovery Service)
   * **Azure Service Management › user_impersonation** (optional: lists your tenants. Without it, only the home tenant is listed and you can add others by ID or domain)
   * **PowerApps Service › User** (recommended). The tool uses it to list target connections on the Connections & variables step, and to verify that canvas apps are published. Without it, you can paste connection IDs by hand, and you must confirm the canvas apps are published yourself.
5. For the target tenant in a cross-tenant move, an admin there must consent to the app. The first sign-in prompts for this, or use `https://login.microsoftonline.com/<target-tenant>/adminconsent?client_id=<CLIENT_ID>`.

### 2. Configure and run

The easiest way is to run `npm start` and open http://localhost:3000. When no Client ID is set, the app opens on **Settings**. Enter the **Application (client) ID**, plus the client secret only if you use the Web platform, and click **Save**. The values are written to `.env` and apply straight away, with no restart. You can change them later under **Settings** in the top menu. Changing them signs out both connections.

Alternatively, edit `.env` by hand:

```bash
cp .env.example .env
```

Set `CLIENT_ID` in `.env`, then start the server:

```bash
npm start
```

The signed-in users need the **System Customizer** or **System Administrator** role in both environments.

## Hosting for your organization

To give colleagues a shared web address, run the migrator as **one continuously running Node.js server** with `HOSTED=true`, for example on Azure App Service or as a Docker container. See **[DEPLOYMENT.md](DEPLOYMENT.md)**.

Hosted mode makes registration mandatory and gives every user their own Microsoft sign-ins and migrations. Profiles and history are shared within each organization.

Serverless platforms such as Vercel stop the server after each request, which cuts off long imports. The migrator detects them and refuses to start migrations there.

## User registration & organization profiles

With Supabase configured (see **[SUPABASE_SETUP.md](SUPABASE_SETUP.md)**), people must register before they can use the migrator.

1. A representative registers the organization and their own details:
   - **Organization:** name, domain, type and location.
   - **Representative:** full name, official work email, designation and an optional contact number.
2. They verify their work email through the emailed link.
3. The first person of a domain becomes the organization's **owner**. Colleagues with the same email domain join it as **pending** until an owner or admin approves them on **Account › Members**.

Supabase manages access to the migrator only. Microsoft sign-in for Power Platform is unchanged and still happens inside the tool.

- **Database:** `supabase/schema.sql` holds the tables, Row Level Security and the functions that enforce the rules.
- **Demo mode:** registration uses a built-in demo backend. Sign in as `admin@contoso.com` / `DemoPass2026`.

## Package only (export without importing)

Choose **Package only** on the first step to create the solution file without importing it anywhere. Use it for audits and backups, or when someone else deploys the solution, for example a client's admin or your release pipeline.

* Only a source is needed; there is no target sign-in.
* The Components step, the rename and the managed/unmanaged choice work as in a migration. The package contains only the selected components and carries the new name.
* The canvas app check and the required-component check run as usual. A component that comes from a managed solution doesn't stop the run: it is listed as a **prerequisite** that the target environment must already have.
* The Connections & variables step is not needed: whoever imports the package chooses the connections and values then.
* The summary shows **Package ready** with a **Download package** button and the **Import notes**: connection references, environment variables, flows, canvas apps and prerequisites. The package is kept in History, and the setup can be saved as a profile.

Steps: `validate → publish (source) → [copy] → dependencies → export → [cleanup] → package`. Nothing is written to any target.

## Download report (PDF)

**Download report (PDF)** is available on **Options & review** (a pre-migration review of the current selections and the latest checks), on every summary (also failed or stopped runs), and on runs opened from **History**. It works in all three modes.

The report contains:

* the migration type, source and target, the solution name and version, the name in the target or package, the package type and the options;
* the canvas app check and the target solution check;
* conflicts, warnings and required actions;
* component counts by type and the full component list (selected, excluded or added automatically);
* connection references and environment variables;
* for a run: every step, failures and the verification result.

The PDF is built in the browser with jsPDF and AutoTable, which are bundled in `public/vendor` (MIT licence), so it also works offline. Nothing is uploaded, and the tool does not store the report.

## Connections & variables (optional step)

After the Components step, the tool lists the solution's **connection references** and **environment variables**. Required connection references that aren't in the solution, but will be added automatically, are listed too.

* For each connection reference, pick a connection that exists in the target. Choose **Enter a connection ID…** to paste one, or **Create a connection in &lt;target&gt;** to open the maker portal.
* For each environment variable, enter the value the target should use. **Use source value** copies the source's value. If you leave a value empty, the target keeps its current value.
* **Skip this step** imports without changing any connections or values.
* Connection references are **grouped by connector**: each group shows its count and how many are connected or missing.
  * Three cards show **Assigned / Missing / Total**.
  * **Apply to all** sets one connection for a whole group, after you confirm.
  * Search and the filters (Missing, Assigned, Added automatically, one connector) help with long lists.
  * Grouping only changes the display: every reference keeps its own mapping and is migrated separately.
  * Demo mode has an **HR System** solution with 23 references to try it.

The values are passed to `ImportSolutionAsync` as `ComponentParameters`, and then applied again after the import. That also covers solutions that already existed in the target. Cloud flows that are still off are then turned on, and the summary shows what was applied, what was already set and what failed.

## Canvas app publish check (mandatory)

A solution export contains only the **published** version of a canvas app. Screens that were saved but never published would be missing in the target. Before every migration, the tool compares each canvas app's last-saved time with its last-published time, using the Power Apps service.

* **Unpublished changes:** the migration is blocked. Open the app in Power Apps Studio (a link is provided), publish it, then click **Check again**.
* **Can't verify** (for example, the PowerApps Service permission is missing): you must tick a confirmation that the apps are published before you can start.

The migration engine runs the same check again on the server, so it can't be bypassed.

## Saved profiles and history

* **Save as profile** on the Options & review step, or on the summary, stores:
  * source and target;
  * the solution and the components you excluded (by component ID);
  * the new name and the options;
  * connection mappings and variable values.

  Under **Profiles**, **Load & review** restores all of it and opens the Options & review step. You still need to be signed in to the right accounts first.
* **History** lists every run on this computer: status, duration, who ran it and with which profile. Open a run to see its summary, steps and log, and to download its package and import log.
* Data is stored in `data/` (`DATA_DIR`): `profiles.json`, `history.json`, plus the newest `KEEP_PACKAGES` (default 10) solution packages and the import logs. A run that was in progress when the server stopped is marked *interrupted*.

## How a migration works

```
validate (+ canvas check) → publish (source) → [copy] → dependencies → export → [cleanup] → package → import → [connections & variables] → publish (target) → verify
```

1. **Validate** reads the solution and its components. It checks for a name conflict in the target, because managed and unmanaged solutions with the same name can't be imported over each other.
2. **Publish** runs `PublishAllXml` in the source. This step is optional.
3. **Filter** runs only when components are excluded. It creates a temporary unmanaged solution in the source with the same publisher and version, and adds just the selected components with `AddSolutionComponent`. The original solution isn't modified.
4. **Export** runs `ExportSolutionAsync` and then `DownloadSolutionExportData`, managed or unmanaged. Older environments fall back to the synchronous `ExportSolution`.
5. **Cleanup** deletes the temporary solution container. This only removes the container; the components themselves stay. It also runs when the migration fails.
6. **Package** sets the final unique name and display name in `solution.xml`. That is the original name, or the new one when you rename. It also takes an inventory of connection references, environment variables, flows and canvas apps.
7. **Import** runs `ImportSolutionAsync`. Progress comes from `importjobs.progress`, and the async operation is polled until it completes.
8. **Publish** runs in the target for unmanaged imports only. This step is optional.
9. **Verify** parses the import job results and confirms the solution now exists in the target. The full log can be downloaded with `RetrieveFormattedImportJobResults` (an Excel XML file).

### Cross-tenant notes

A solution carries no connections, users, security role assignments or data. After a cross-tenant move, the summary lists what to do next:

* create connections and bind the connection references
* review environment variable values
* turn on flows
* share canvas apps with users in the target tenant

## Project layout

```
server.js                    Express API and static UI
src/auth.js                  MSAL (auth code + PKCE); separate token caches for source and target
src/migration.js             Provider-agnostic migration engine and progress model
src/solutionPackage.js       solution.xml rename and package inspection
src/providers/dataverse.js   ARM tenants, Global Discovery environments, Dataverse Web API
src/providers/mock.js        In-memory simulation used by MOCK_MODE and the tests
public/                      Single-page UI (vanilla JS, no build step)
test/                        node:test suite (package helpers and end-to-end runs on the mock)
```

```bash
npm test
```

## Security

* The server listens on `127.0.0.1` only. It's built for one user on their own machine, and tokens are held in memory.
* Bearer tokens are only ever sent to Dataverse hosts that the Discovery Service returns and that match `DATAVERSE_HOST_SUFFIXES`.
* The package download is kept in memory for the session only.

## Troubleshooting

To check whether the server can reach Microsoft, run:

```bash
npm run diagnose
```

| Symptom | Fix |
|---|---|
| `AADSTS50011` redirect URI mismatch | Add `http://localhost:3000/auth/callback` under **Mobile and desktop applications** in the app registration |
| Sign-in fails with `network_error … fetch failed` | The browser reached Microsoft but the Node server couldn't, usually because of a company proxy. Set `PROXY_URL=http://proxy:port` in `.env` (`npm run diagnose` shows the Windows proxy address) |
| `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` / `SELF_SIGNED_CERT_IN_CHAIN` | Your network inspects HTTPS traffic. Use Node 22.19 or newer (the tool trusts the Windows certificate store by default), or set `NODE_EXTRA_CA_CERTS` to your company root certificate (.pem) |
| Connections step: "Consent is required for this app in this tenant" (AADSTS65001) | Click **Sign in to grant access** and accept. The tool keeps your selections and lists the connections again. An admin can also grant consent for the whole tenant |
| "Create a connection" opens "environment could not be found" | The maker portal uses your browser's own account. Sign in there with an account from the target tenant (for example in a private window), create the connection, then click **Refresh connections** |
| Flow shows **Needs connection** after migration | One of the flow's connection references has no connection in the target. Map it on the Connections & variables step, or bind it in the target, then turn the flow on |
| Flow fails with `GetTable … Unauthorized` | The flow's connection can't reach a SharePoint site or list. Point the site URL **and** the list / table environment variables to resources in the target tenant |
| Screens missing in a migrated canvas app | Check **Canvas apps in the migrated package** on the summary. It lists the screens and the saved time of the exported version. If screens are missing there, publish the app in the source and migrate again |

## Migration outcomes

The summary shows four cards that work as tabs: **Components migrated** (the default), **Action required**, **Failures** and **Total duration** (steps and activity log). The outcome is decided only after the solution has been found in the target at the expected version:

| Outcome | Meaning |
|---|---|
| **Migration successful** | Imported, verified, nothing failed and nothing left to configure |
| **Migration successful** + yellow "N items require configuration" note | Imported and verified, but connections, variable values or flows still need setting up in the target |
| **Migration completed with errors** | Imported, but some components or post-import steps failed (see Failures) |
| **Migration failed** | Not imported, or not found in the target afterwards |

## Opening Power Apps with the right account

Links to Power Apps go through a quick Microsoft sign-in with the matching account first: **Open in Power Apps Studio** uses the source account, while **Create a connection** and **Open solutions** use the target account. Power Apps then usually opens with that account. If your browser still picks another account, use **Copy link** and open it in a private window or in a separate browser profile.
