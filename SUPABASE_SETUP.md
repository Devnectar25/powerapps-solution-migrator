# User registration with Supabase: setup

The migrator can require every user to register their organization and be approved before they
can use it. Supabase stores the accounts, organizations and memberships; Microsoft Entra ID sign-in
for Power Platform is unchanged and still happens inside the tool.

## How it works

| Step | What happens |
|---|---|
| 1. Register | The representative enters the organization details (name, domain, type, location) and their own details (full name, official work email, designation, optional contact number) and a password. |
| 2. Verify | Supabase emails a verification link. Opening it returns to the migrator, signed in. |
| 3. Organization | The **first** person of a domain creates the organization and becomes its **owner**. Anyone who registers later with the same email domain joins that organization as **pending**: no duplicate organizations. |
| 4. Approval | Owners and admins approve, reject, suspend or reactivate members and set roles on **Account › Members**. |
| 5. Use the tool | Active members use the migrator. Each one connects their own Microsoft accounts on the first step, as before. |

Rules enforced by the database (`supabase/schema.sql`):

- The work email's domain must match the organization domain (sub-domains are allowed: `uk.powercraft.co` joins `powercraft.co`). Personal domains such as gmail.com or outlook.com are refused.
- Row Level Security: users see only their own profile and organization; owners and admins also see their organization's members. Nothing is readable without signing in, apart from "is this domain registered?".
- Rows are only created or changed through the provided functions, which check the rules above. Admins can't change owners; you can't change your own role; an organization keeps at least one owner.

## One-time setup

1. **Create a project** at [supabase.com](https://supabase.com) (choose a region close to your users).
2. **Create the database objects:** in the Supabase dashboard open **SQL Editor › New query**, paste the whole of `supabase/schema.sql` and click **Run**. It is safe to run again later.
3. **Authentication settings** (Authentication):
   - **Sign In / Providers › Email:** enabled, with **Confirm email** switched **on**.
   - **URL Configuration:** set **Site URL** to the migrator's address (for the local tool `http://localhost:3000`) and add the same address to **Redirect URLs**. Verification and password-reset links return there.
   - **Emails › SMTP:** for real use, configure your own SMTP server (Supabase's built-in sender is rate-limited and meant for testing). Optionally adjust the email templates.
4. **Copy the keys** from **Project Settings › API**: the **Project URL** and the **anon / publishable** key. Never use the **service_role / secret** key in the migrator: the tool refuses it.
5. **Connect the migrator:** open **Settings › User registration (Supabase)**, enter the URL and the anon key, and click **Save registration settings**. Or add to `.env`:

   ```
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_ANON_KEY=your-anon-key
   ```

6. Reload the migrator: the sign-in page appears. Register your organization first: you become its owner.

## Settings

| Variable | Meaning |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | anon / publishable key (public by design; RLS protects the data) |
| `REGISTRATION` | `auto` (default: on when Supabase is configured), `on`, or `off` |
| `APP_URL` | Address used in email links, if different from the one in the browser |
| `MOCK_REGISTRATION=off` | Demo mode only: switch the built-in demo registration off |

## Demo mode

`npm run mock` includes a built-in demo registration backend (no Supabase needed, nothing is sent):
sign in as `admin@contoso.com` / `DemoPass2026` (owner of *Contoso Ltd*, with one pending request from
Lee Chen to approve), or register new organizations. Instead of an email, the verification and
reset links are shown on screen.

## Security notes

- The browser only receives an HttpOnly, SameSite cookie with a random session id. Supabase tokens stay in the migrator's server.
- **Keep me signed in** stores the refresh token in `data/account-sessions.json` on this computer (readable only by the current user); without it, closing the tool signs you out.
- Sign-in, registration and password-reset attempts are rate limited.
- Account changes need the migrator page's request header, like all other changes, so other websites can't trigger them.
