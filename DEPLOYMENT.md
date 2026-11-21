# Hosting the migrator for your organization

The migrator can run on your own computer (Start-Migrator.cmd) or on a server that many people use
through the browser. This guide covers the server.

## Why not Vercel (serverless functions)

A migration exports, imports and polls Dataverse for many minutes, and the migrator keeps each
user's Microsoft sign-ins and the progress of running migrations in the server's memory. Vercel
runs the app as **serverless functions**: many short-lived copies that share no memory and are
stopped right after they answer a request. On Vercel:

| Symptom | Cause |
|---|---|
| Step 4 asks the target account to sign in again | The request reached another copy of the server, which doesn't have the sign-in |
| Import stops at 15%; `/api/migrations/<id>` returns 404 | The function was stopped after replying, so the import stalled; the other copies never knew the migration |
| Error writing `/var/task/data/packages` | The application folder is read-only, so packages, history and profiles can't be saved |

The migrator now detects serverless hosting: it shows a warning and refuses to start a migration
there, instead of failing halfway. **Run it as one continuously running Node.js server** instead.

## What hosted mode does (`HOSTED=true`)

- **Registration is required** (Supabase, see SUPABASE_SETUP.md): only approved members of a registered organization get in.
- **Each user has their own workspace**: their own Microsoft source/target sign-ins, tenant lists and running migrations. Nobody can use or see another user's Microsoft sign-in.
- **Profiles, history and packages are shared within the organization** only. Colleagues can follow a running migration; only the person who started it can stop it.
- Settings are read-only in the page (they're environment variables on the server); HTTPS security headers; a health probe at `/healthz`; listens on `0.0.0.0:$PORT`.

## Option A (recommended): Azure App Service

Runs next to your tenants' Microsoft services and supports long-running Node.js apps.

1. **Create the Web App**: Azure portal › Create › Web App. Publish: *Code*; Runtime: **Node 22 LTS**; OS: **Linux**; plan **Basic B1 or higher** (needed for Always On).
2. **Configuration › General settings**: **Always On = On**, **HTTPS Only = On**, **Session affinity (ARR) = On**. Startup command: `node server.js`.
3. **Scale out: exactly 1 instance.** Sign-ins and running migrations are in memory; a second instance would not see them.
4. **Environment variables** (Settings › Environment variables):

   | Name | Value |
   |---|---|
   | `HOSTED` | `true` |
   | `APP_URL` | `https://<your-app>.azurewebsites.net` (or your custom domain) |
   | `CLIENT_ID` | the Entra app registration's Application (client) ID |
   | `CLIENT_SECRET` | a client secret of that app (better: a Key Vault reference) |
   | `SUPABASE_URL` / `SUPABASE_ANON_KEY` | your Supabase project (anon / publishable key) |
   | `DATA_DIR` | `/home/data` (persistent storage on App Service Linux) |
   | `SCM_DO_BUILD_DURING_DEPLOYMENT` | `true` |

5. **Deploy**: Deployment Center › Source **GitHub** › your repository and branch. App Service builds it (`npm install`) and starts `node server.js` on every push.
6. **Microsoft Entra ID** (app registration › Authentication): under the **Web** platform add `https://<your-app>.azurewebsites.net/auth/callback`. Keep the client secret (a hosted server is a confidential client; this was the AADSTS7000218 fix).
7. **Supabase** (Authentication › URL Configuration): set the Site URL and add the redirect URL `https://<your-app>.azurewebsites.net/`.
8. Open `https://<your-app>.azurewebsites.net/healthz`, it should answer `{"ok":true,"hosted":true}`. Then open the app, register your organization and run a small migration.

App Service ends a single HTTP request after 230 seconds; the migrator's requests are short (the
import runs in the background and the page polls for progress), so this limit doesn't apply.

## Option B: any container host (Docker)

The repository includes a `Dockerfile` (Node 22, runs as a non-root user, health check).

```bash
docker build -t powerapps-solution-migrator .
```

```bash
docker run -d --name migrator -p 8080:8080 -v migrator-data:/data \
  -e APP_URL=https://migrator.example.com -e CLIENT_ID=... -e CLIENT_SECRET=... \
  -e SUPABASE_URL=... -e SUPABASE_ANON_KEY=... powerapps-solution-migrator
```

Put HTTPS in front of it (the platform's front end or a reverse proxy). On Azure Container Apps,
Render, Railway, Fly.io and similar: set **minimum and maximum replicas to 1**, mount a persistent
volume at `/data`, and use the same environment variables as above.

## Keeping the address powerapps-solution-migrator.vercel.app (optional)

The app itself must run on the server above, but Vercel can forward its address to it:

1. In the Vercel project, replace the build with `deploy/vercel-proxy/vercel.json` (put it at the
   root of a small repository, or as the project's only file) and change the destination to your
   server's address.
2. On the server set `APP_URL=https://powerapps-solution-migrator.vercel.app`.
3. Use `https://powerapps-solution-migrator.vercel.app/auth/callback` as the Entra redirect URI
   and `https://powerapps-solution-migrator.vercel.app/` in Supabase.

A custom domain pointing straight at the server (for example `migrator.powercraft.co`) is simpler
and avoids an extra hop; prefer it if you can.

## After deploying: checklist

- [ ] `/healthz` answers `{"ok":true,"hosted":true}`
- [ ] Opening the app shows the sign-in page (registration on)
- [ ] Two people in different browsers each have to sign in to Microsoft themselves
- [ ] A migration runs to the end; Step 4 lists the target connections without asking to sign in again
- [ ] History and packages are still there after restarting the app
- [ ] Vercel's old deployment is removed or protected (it shared one sign-in between all visitors)
