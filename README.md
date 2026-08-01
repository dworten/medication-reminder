# Medication Reminder

Automated twice-daily phone calls reminding your grandmother to take her medication, built with Node.js + Twilio Programmable Voice, deployed on Railway.

Calls are placed at **9:20 AM and 9:20 PM US Central** by default (morning calls skipped on Sundays). If she doesn't answer, it retries up to 2 more times, 5 minutes apart. If she never confirms, it texts the caregiver an SMS alert.

`MOCK_MODE=true` simulates every branch interactively in your terminal — no Twilio account needed to try it locally.

---

## Architecture

```
app.js              Express server, /trigger, /health, --test CLI, graceful shutdown
railway.json        Railway build/deploy config (healthcheck, single replica)
prisma.config.js    Prisma CLI config — connection URL + .env loading (Prisma 7)
prisma/
  schema.prisma     Data model: accounts, contacts, messages, schedules, call_history
  migrations/       Version-controlled SQL, applied with `prisma migrate deploy`
src/
  db.js             Shared PrismaClient (lazy; the app boots without a database)
  generated/prisma  Generated client — gitignored, rebuilt by `prisma generate`
  config.js         Env → config, resolves BASE_URL, validates at boot
  logger.js         Structured JSON to stdout (Railway captures it)
  scheduler.js      node-cron fires at 9:20 AM / 9:20 PM (Central)
  callManager.js    Routes to mock or real, owns retry + escalation logic
  twimlHandler.js   Express router: /webhook/initial /response /status
  security.js       Twilio signature validation + /trigger secret
  mockMode.js       Interactive terminal simulation (local only)
  smsAlert.js       Sends SMS via Twilio (or prints a box in mock mode)
```

### Call flow

```
Cron fires
  └─ initiateCall(dose, attempt=1)
       ├─ MOCK: interactive terminal
       └─ REAL: Twilio REST → grandma's phone
                  ├─ She answers → /webhook/initial → Gather TwiML
                  │    ├─ 1 / "yes"  → goodbye + hangup  ✅
                  │    └─ 2 / "no"   → reprompt (up to 3×) → SMS if unconfirmed  ❌
                  └─ No answer → /webhook/status → retry (×2, 5 min apart) → SMS  📲
```

Calls are scheduled in `TIMEZONE` (default `America/Chicago`). node-cron resolves this against the IANA database, so it self-adjusts for Daylight Saving Time — the Railway container runs in UTC and that's fine.

---

## Local development

```bash
npm install
cp .env.example .env     # MOCK_MODE=true by default; placeholder phone numbers are fine

npm run test:morning     # simulate a morning call
npm run test:evening     # simulate an evening call
```

At the prompt, enter:

| Input | Meaning |
|---|---|
| `1` or `yes` | She picks up and confirms |
| `2` or `no` | She picks up and says no (triggers the reprompt loop) |
| `[Enter]` or `no answer` | No pickup (triggers retry logic) |

Worth walking through all four scenarios — happy path, reprompt loop until SMS, three no-answers until SMS, and missed-then-answered-on-retry.

---

## Deploying to Railway

**You never paste secrets into code or into this repo.** Every credential goes into Railway's Variables tab, described in Step 4.

### Step 1 — Push to GitHub

```bash
git init
git add .
git commit -m "Medication reminder — cloud-ready"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/medication-reminder.git
git push -u origin main
```

Make the repo **private**. Confirm `.env` is not in the commit — `git status` should never list it (`.gitignore` covers it).

### Step 2 — Create the Railway project

1. Go to [railway.com](https://railway.com) and sign in with GitHub.
2. **New Project → Deploy from GitHub repo**.
3. Pick your `medication-reminder` repo and authorize Railway to access it.

Railway detects Node from `package.json`, runs `npm ci`, and starts it with `npm start`. The first deploy will **fail its healthcheck and crash-loop** — expected, because no environment variables are set yet. Continue to Step 3.

### Step 3 — Generate the public URL

1. Click your service → **Settings** → **Networking** → **Public Networking**.
2. Click **Generate Domain**. If prompted for a port, enter the port from the
   `Medication reminder started` deploy log line — **not** automatically `3000`.
   Railway injects `PORT` on most services, so the app often listens on
   something else (commonly `8080`). If the domain's target port and the
   listening port disagree, every request returns
   `502 Application failed to respond` even though the deploy is healthy.
3. You'll get something like `medication-reminder-production-a1b2.up.railway.app`.

This is your permanent replacement for ngrok. **You do not need to copy it into a variable** — Railway exposes it to the app as `RAILWAY_PUBLIC_DOMAIN`, and `src/config.js` builds `BASE_URL` from it automatically. Only set `BASE_URL` by hand if you later add a custom domain.

### Step 4 — Set environment variables

Service → **Variables** tab → **New Variable** for each (or use **Raw Editor** to paste them all as `KEY=value` lines).

| Variable | Value | Where to find it |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | `AC…` | Twilio Console dashboard |
| `TWILIO_AUTH_TOKEN` | your auth token | Twilio Console dashboard (click to reveal) |
| `TWILIO_API_KEY_SID` | `SK…` | Console → Account → API keys & tokens *(optional, preferred for placing calls)* |
| `TWILIO_API_KEY_SECRET` | the secret | Shown **once** when you create the API key *(optional)* |
| `TWILIO_PHONE_NUMBER` | `+1…` | The Twilio number you bought |
| `GRANDMA_PHONE_NUMBER` | `+1…` | Her number, E.164 |
| `CAREGIVER_PHONE_NUMBER` | `+1…` | Your number, for missed-dose SMS |
| `TEST_PHONE_NUMBER` | `+1…` | Optional — your phone, for test calls |
| `TIMEZONE` | `America/Chicago` | |
| `MOCK_MODE` | `false` | Must be `false` — mock mode needs a terminal and will refuse to start on Railway |
| `TRIGGER_SECRET` | a long random string | Generate: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"` |
| `NODE_ENV` | `production` | Switches logging to JSON |

Optional overrides (defaults in parentheses): `MAX_CALL_ATTEMPTS` (3), `RETRY_DELAY_MINUTES` (5), `MAX_REPROMPTS` (3), `MORNING_CRON` (`20 9 * * *`), `EVENING_CRON` (`20 21 * * *`).

**Do not set `PORT`** — Railway assigns it and the app reads `process.env.PORT`.

`TWILIO_AUTH_TOKEN` is required even if you use API key auth, because webhook signature validation can only be done with the account auth token. The app refuses to start if it's missing.

Saving variables triggers a redeploy.

### Step 5 — Verify the deploy

```bash
curl https://YOUR-APP.up.railway.app/health
```

Expected:

```json
{
  "status": "ok",
  "mode": "real",
  "timezone": "America/Chicago",
  "baseUrl": "https://YOUR-APP.up.railway.app",
  "uptime": 12
}
```

Check `baseUrl` matches your actual domain — that's the URL Twilio will be handed for webhooks. If the app crashed instead, the **Deploy Logs** will list exactly which variables are missing; it fails fast on purpose rather than discovering the problem at 9:20 PM.

### Step 6 — Place a real test call

```bash
curl -X POST "https://YOUR-APP.up.railway.app/trigger?dose=morning&target=test" \
  -H "X-Trigger-Secret: YOUR_TRIGGER_SECRET"
```

Use `target=test` to call `TEST_PHONE_NUMBER` (your own phone) instead of your grandmother. Drop `&target=test` when you're ready for the real thing.

Watch Railway's **Deploy Logs** and the Twilio Console call log to confirm the full flow: call placed → `/webhook/initial` → your keypad response → `/webhook/response` → goodbye.

### Railway settings to be aware of

- **Keep replicas at 1.** Two instances means two schedulers means duplicate calls. `railway.json` pins `numReplicas: 1`.
- **Leave App Sleeping off** (Settings → Deploy). A sleeping app runs no cron jobs and places no calls.
- Every push to `main` redeploys automatically.

---

## Twilio setup

### 1. Account and number

1. Sign up at [twilio.com](https://www.twilio.com).
2. Console → Phone Numbers → **Buy a Number**. Get a US number with Voice **and** SMS capability (~$1/month).
3. Copy it in E.164 format: `+1XXXXXXXXXX`.

### 2. Verify numbers (trial accounts only)

On a trial account Twilio only calls numbers you've verified:

1. Console → Phone Numbers → **Verified Caller IDs** → Add a New Caller ID.
2. Verify your grandmother's number (she gets a call with a code).
3. Verify your caregiver number, so SMS alerts can be delivered.

This restriction lifts once you upgrade to a paid account. For a medication reminder that actually matters, upgrade — trial calls also carry a spoken trial notice before your message.

### 3. API key (recommended)

Console → Account → **API keys & tokens** → Create API key (Standard). Copy the SID and secret immediately; the secret is shown only once. Using an API key means you can rotate it without touching your account auth token.

### Webhook configuration

There's nothing to configure in the Twilio Console for webhooks — the app passes its callback URLs with each outbound call, built from `BASE_URL`.

---

## Security

Once deployed, the app sits at a stable public URL, so both entry points are locked down:

- **`/webhook/*`** — verifies the `X-Twilio-Signature` header on every request against `TWILIO_AUTH_TOKEN`. Without this, anyone who found the URL could POST to `/webhook/status` and drive the retry and escalation logic, or hammer `/webhook/initial`. Set `VALIDATE_TWILIO_SIGNATURE=false` only for local curl testing, never in production.
- **`/trigger`** — requires the `X-Trigger-Secret` header to match `TRIGGER_SECRET`. This endpoint places real, billable calls; without a secret configured it returns 503 in live mode.

---

## Configuration reference

| Variable | Default | Description |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | — | Twilio account SID (live mode) |
| `TWILIO_AUTH_TOKEN` | — | Auth token; required for webhook signature validation |
| `TWILIO_API_KEY_SID` | — | API key SID (preferred auth for placing calls) |
| `TWILIO_API_KEY_SECRET` | — | API key secret |
| `TWILIO_PHONE_NUMBER` | — | Your Twilio number, E.164 |
| `GRANDMA_PHONE_NUMBER` | — | Her number, E.164 |
| `CAREGIVER_PHONE_NUMBER` | — | Your number for SMS alerts, E.164 |
| `TEST_PHONE_NUMBER` | — | Optional target for `/trigger?target=test` |
| `TIMEZONE` | `America/Chicago` | IANA timezone — calls follow this clock |
| `MORNING_CRON` | `20 9 * * *` | Cron expression for 9:20 AM |
| `EVENING_CRON` | `20 21 * * *` | Cron expression for 9:20 PM |
| `PORT` | `3000` | Assigned by Railway; don't set it there |
| `BASE_URL` | auto | Public URL for webhooks. Derived from `RAILWAY_PUBLIC_DOMAIN` when unset |
| `MOCK_MODE` | `true` | `true` = terminal simulation, `false` = real Twilio |
| `TRIGGER_SECRET` | — | Shared secret for `POST /trigger` |
| `VALIDATE_TWILIO_SIGNATURE` | `true` | Verify webhook signatures |
| `NODE_ENV` | `development` | `production` switches logs to JSON |
| `MAX_CALL_ATTEMPTS` | `3` | Total call attempts (1 initial + 2 retries) |
| `RETRY_DELAY_MINUTES` | `5` | Minutes between retries after no answer |
| `MAX_REPROMPTS` | `3` | Max re-asks within a single answered call |

---

## Logs

The app logs structured JSON to stdout; Railway captures and indexes it under the service's **Deploy Logs**. Nothing is written to disk — Railway's filesystem is ephemeral and wouldn't survive a redeploy.

```jsonl
{"ts":"2026-07-30T14:20:00.000Z","level":"call","message":"Placing call","dose":"morning","attempt":1}
{"ts":"2026-07-30T14:20:18.000Z","level":"call","message":"Confirmed via call","dose":"morning","attempt":1,"reprompts":0}
```

The `level` field is `info`, `warn`, `error`, or `call`.

Locally, logs are human-readable instead; set `LOG_FORMAT=json` to see production formatting.

---

## Known limitations (addressed in phase 2)

- **Schedules are cron strings in env vars**, and the Sunday-morning skip is hardcoded in `scheduler.js`. Moving to database-backed schedules with a days-of-week column.
- **Pending retries live in memory** (`setTimeout` in `callManager.js`). A redeploy inside the 5-minute retry window silently drops that retry and the missed-dose SMS that would follow. Moving to a `next_retry_at` column with a sweeper.
- **Call history is only in logs**, which are retention-limited. Moving to a `call_history` table.
