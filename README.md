# Off Duty — team time-off tracker with Slack notifications

A small web app for tracking who's out of office and automatically posting monthly
availability notices to Slack channels across **multiple Slack workspaces**
(e.g. nClouds and AppEvolve).

## What it does

- **Projects** — source of truth per project: Jira name, project name, unlimited
  points of contact, unlimited Slack channels (each tagged internal/external and
  tied to a workspace), org workspace, internal/external flag, and an **"Email"**
  marker for projects with no external channel (client notified manually).
- **Team Members** — company-wide roster with employment status
  (PH Employee / US Employee / Contractor).
- **Holidays** — per year, sectioned by location (PH / US). PH holidays apply
  automatically to PH Employees, US holidays to US Employees, none to Contractors.
- **Time-Off Entries** — the source of truth for requests. Members must exist in
  Team Members first; each entry can be tagged to multiple projects, has a date
  range, and a status (Pending approval / Approved). **Only approved entries are
  included in notifications.**
- **Project View** — per project: who's out this period, who's observing a
  holiday, a live Slack-style preview of exactly what each channel will receive,
  a **Send to Slack now** button, and **automatic schedules** ("every Monday at
  09:00"). A member who is both on leave *and* observing a holiday appears in
  both lists.
- **Settings** — Slack workspaces + bot tokens, internal/external message
  templates (with placeholders), and the scheduler timezone.

### The reporting window
Notifications always cover the **current month**. If today falls in the **last
7 days of the month**, the window automatically extends through the **first 7
days of the next month** (year rollover handled).

## Run locally

```bash
npm install
npm start           # http://localhost:3000
```

Data is stored in `data/db.json` (no database server needed). Set `DATA_DIR` to
change where it lives.

## Connect Slack (once per workspace)

Do this **twice** — once in nClouds, once in AppEvolve:

1. Go to https://api.slack.com/apps → **Create New App** → *From scratch* →
   pick the workspace.
2. **OAuth & Permissions** → *Bot Token Scopes* → add:
   - `chat:write`
   - `channels:read` (and `groups:read` if you'll post to private channels)
3. **Install to Workspace** and copy the **Bot User OAuth Token** (`xoxb-…`).
4. In the app → **Settings → Slack workspaces → Add workspace**, paste the token.
5. In Slack, invite the bot to every channel it should post to:
   `/invite @YourBotName`.

Channels in the Projects section are entered by name (e.g. `apollo-client`,
no `#`) or by channel ID.

## Automatic sending (optional)

Schedules on project cards fire while the app process is running. On **free
hosting the app sleeps when idle**, so scheduled sends are unreliable there —
use the per-channel **Send** buttons instead (the app is built around this).
On always-on hosting (e.g. Railway ~$5/mo) schedules work fully.

## Template placeholders

`{month}` `{project}` `{ooo_list}` `{holiday_list}` `{holiday_dates}` — Slack
formatting (`*bold*`, `:wave:`, `@here`) works.

## Deploy for FREE (Render + Neon)

Free hosts wipe their local disk on every restart, so the app supports storing
all data in a free Postgres database instead. Set `DATABASE_URL` and it
switches automatically.

1. Push this folder to a GitHub repo.
2. Create a free database at https://neon.tech → New Project → copy the
   **connection string** (starts with `postgresql://`).
3. On https://render.com → **New → Web Service** → connect the repo →
   Instance type: **Free**. Build command `npm install`, start command
   `npm start`.
4. Add environment variables:
   - `DATABASE_URL` = the Neon connection string
   - `APP_PASSWORD` = a strong password of your choosing
5. Deploy, open the URL (first load after idle takes ~30–50 s), log in with
   any username + your password.

## Deploy paid (Railway, ~$5/mo — enables automatic schedules)

New Project → Deploy from GitHub → add a Volume at `/data` → env vars
`DATA_DIR=/data` and `APP_PASSWORD=…` (or skip the volume and set
`DATABASE_URL` to a Neon string instead).

## Security notes

- Set `APP_PASSWORD` on any public deployment — Slack bot tokens are stored in
  the data file.
- Bot tokens are never sent back to the browser (only a last-4 hint).
