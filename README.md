# Medication Reminder

Automated twice-daily phone calls reminding your grandmother to take her medication, built with Node.js + Twilio Programmable Voice, deployed on Railway.

Calls are placed at **9:20 AM and 9:20 PM US Central** by default (morning calls skipped on Sundays). If she doesn't answer, it tries again a few minutes later; if she still doesn't confirm, it escalates to a caregiver — a call, a text, or both, depending on how the schedule is configured. Attempt counts, retry gaps and escalation steps are columns on the schedule row, not constants.

Voicemail is not treated as an answer: Twilio's answering-machine detection hangs up without leaving a message, and the call is retried instead.

Call times, contacts, messages and escalation settings all live in **PostgreSQL** — edit them with `npm run db:studio` and the scheduler picks the change up within a minute, no redeploy. `npm run db:seed` creates a working setup from scratch; `npm run db:history` shows what actually happened.

`MOCK_MODE=true` simulates every branch interactively in your terminal — no Twilio account needed to try it locally.

---

## Architecture

```
app.js              Express server, /trigger, /health, /login, --test CLI, shutdown
public/
  login.html        Sign-in page
  signup.html       Registration page
railway.json        Railway build/deploy config (healthcheck, single replica)
prisma.config.js    Prisma CLI config — connection URL + .env loading (Prisma 7)
prisma/
  schema.prisma     Data model: accounts, contacts, messages, schedules, call_history
  migrations/       Version-controlled SQL, applied with `prisma migrate deploy`
  seed.js           Creates the account, contacts, message and schedules (idempotent)
scripts/
  history.js        `npm run db:history` — recent attempts, escalation chains indented
  set-password.js   `npm run set-password` — the only way an account gets one
src/
  session.js        Session cookie config, Postgres-backed store
  api/
    index.js        Mounts the routers; auth boundary lives here
    auth.js         /login /logout /me, plus the requireAuth guard
    validate.js     Input rules, mirroring the database's CHECK constraints
    errors.js       One error shape; Prisma failures → the right HTTP status
    contacts.js  messages.js  schedules.js  callHistory.js
  db.js             Shared PrismaClient (lazy; the app boots without a database)
  generated/prisma  Generated client — gitignored, rebuilt by `prisma generate`
  config.js         Env → config, resolves BASE_URL, validates at boot
  logger.js         Structured JSON to stdout (Railway captures it)
  scheduler.js      Ticks every minute, fires whatever the DB says is due
  scheduleMatch.js  Pure timezone/day matching — no DB, no clock, fully testable
  retrySweeper.js   Ticks every minute, does the retries/escalations the DB owes
  callManager.js    Routes to mock or real, owns retry + escalation logic
  twimlHandler.js   Express router: /webhook/initial /response /status /escalation
  security.js       Twilio signature validation + /trigger secret
  mockMode.js       Interactive terminal simulation (local only)
  smsAlert.js       Sends SMS via Twilio (or prints a box in mock mode)
  data/             Database access, the seam Phase 3's API sits on
    accounts.js     Account lookups
    schedules.js    Schedule reads + the atomic fire-claim
    callHistory.js  Per-attempt records (best-effort: never blocks a call)
```

### Call flow

```
Scheduler tick (every minute)
  └─ load enabled schedules → which are due in their own timezone + days?
       └─ claim the schedule (atomic UPDATE — only one caller can win)
            └─ initiateCall(dose, attempt=1, { schedule })
                 ├─ opens a call_history row (PENDING)
                 ├─ MOCK: interactive terminal
                 └─ REAL: Twilio REST → the schedule's contact
                            ├─ Answers → /webhook/initial → Gather TwiML
                            │    ├─ 1 / "yes" → goodbye + hangup      ✅ CONFIRMED
                            │    ├─ 2 / "no" ×4 → reprompts exhausted → escalate now
                            │    └─ hangs up → retry → escalate        ❌ NOT_CONFIRMED
                            └─ No answer → /webhook/status → retry → escalate 📲 NO_ANSWER
```

**Voicemail is handled differently for each call, on purpose.**

| | Reminder call → grandma | Escalation call → caregiver |
|---|---|---|
| Detection mode | `Enable` — verdict at answer | `DetectMessageEnd` — waits for the beep |
| On a machine | `<Hangup/>`, no message | **Leaves a message**, then hangs up |
| Then | retried like a no-answer | SMS still sent |

Reciting *"have you taken your medicine, press 1"* into an answering machine
helps nobody — it cannot answer. Worse, without detection the machine sits
silently through every reprompt, which lands on the reprompt-exhausted branch
and escalates *immediately*: the observable symptom was the caregiver being
called about a minute after she declined, instead of her being tried again.

A voicemail for the caregiver is the opposite case — it is a real alert, and
they may not read a text for hours. So that call waits for the beep before
speaking, otherwise the message would start over the outgoing greeting and be
half-recorded. The recording drops the "press 1" prompt, since a `<Gather>` into
voicemail would sit through its timeout and then record the prompt again on
every reprompt.

An inconclusive verdict (`unknown`) is deliberately treated as a person in both
cases. Detection that could not decide must never hang up on her.

**An answered call that confirms nothing is a missed dose.** If she picks up and
hangs up — or says no and hangs up — Twilio reports `completed`, which used to
close the record and stop there. That meant the one case where she has actually
*told* you the dose was missed alerted nobody, while simply not picking up
escalated normally. It now takes the same path as a no-answer: two retries five
minutes apart, then the caregiver.

Staying on the line and saying "no" is different, and still escalates
immediately — she is reachable and has answered, so redialling would only pester
her. Only the reprompt-exhausted branch does that.

The guard that makes this safe is `closeIfPending`. `/webhook/response` writes
`CONFIRMED` the moment she presses 1, and Twilio can only deliver `completed`
after receiving that TwiML, speaking the goodbye and hanging up — so the
conditional update finds a row that is no longer `PENDING` and does nothing. A
confirmed dose is never redialled.

### Escalation chain

When a dose can't be confirmed, the chain is whatever the schedule's
`escalate_with_call` / `escalate_with_sms` columns say, and every step is its own
`call_history` row linked to the one that caused it:

```
REMINDER_CALL  (never confirmed after max_attempts)
  │
  ├─ escalate_with_call = false   ── the default, and what this app always did
  │    └─ ESCALATION_SMS → the fallback contact                     📲
  │
  └─ escalate_with_call = true
       ├─ ESCALATION_CALL → the fallback contact, "press 1 to acknowledge"
       │    └─ pressed 1 → recorded, but does not stop the text  ✅ CONFIRMED
       └─ ESCALATION_SMS  → sent every time                       📲 SENT
```

**Both steps always run.** The caregiver gets a call and a text, every time.
Pressing 1 is recorded — it is the difference in the history between "we reached
them" and "we called and got nothing" — but it no longer suppresses the text: a
call picked up, half-heard and forgotten was cancelling the only written record
of a missed dose.

**The text is queued before the call is dialled, not after it fails.** Ordering
it this way is what makes the chain survive a crash — once the row exists, the
caregiver is alerted no matter what happens to the process that placed the call.
Sending it from the status callback instead loses the alert entirely whenever
that callback never arrives.

**Alerted exactly once.** `(parent_id, kind)` is UNIQUE, so a duplicate Twilio
status callback — which does happen — cannot produce a second call or a second
text. Checking for an existing step before inserting is a read followed by a
write and two callbacks arriving together can both pass it; Postgres cannot be
raced. An escalation call that is re-swept after a crash is skipped on its
`call_sid`, and an SMS row already marked `SENT` is re-checked before sending.

Both steps off means nobody is alerted; the app logs that loudly rather than
failing silently.

`npm run db:history` renders these chains, indented, with what is still queued.

**Scheduling.** Each schedule row holds a wall-clock `time_of_day`, a set of
`days_of_week`, and its own `timezone` — Android-clock semantics rather than a
cron string, so a UI can render and edit it directly. The tick resolves each
row's local time through the IANA database, so DST self-adjusts and the Railway
container running in UTC is irrelevant.

**No duplicate calls.** Before dialling, the tick stakes a claim with a single
conditional `UPDATE ... WHERE last_fired_at IS NULL OR last_fired_at < window`.
Postgres serialises that, so exactly one caller wins and every other sees zero
rows updated. Replicas stay at 1, but this holds even if a second process ever
appears. Claiming happens *before* the call, so a crash mid-dial cannot leave
the schedule unclaimed and trigger a second call on the next tick.

**Missed-minute grace.** The old exact-minute cron silently dropped a dose if
the container happened to be restarting during that one minute. A schedule now
stays due for `SCHEDULE_GRACE_MINUTES` (default 5), turning "missed entirely"
into "a few minutes late".

**Retries survive restarts.** A retry used to be a `setTimeout` living only in
the process, so a Railway deploy inside the five-minute retry window took the
retry with it — and the missed-dose SMS that should have followed never
happened, silently. Now an unanswered call writes `next_retry_at` on its
`call_history` row and a sweeper picks it up a minute later. Escalations are
queued the same way rather than sent inline, so a crash between "attempts
exhausted" and "SMS sent" cannot lose the alert either; the sweeper is kicked
immediately after queueing, so in the normal case it still goes out at once.

The ordering is claim → do → complete. Completing is last on purpose: a process
that dies mid-flight leaves the item queued, so the failure mode is a repeat
rather than a loss — and repeats are suppressed by checking whether that attempt
already exists. A claim held by a process that died lapses after
`RETRY_STALE_CLAIM_MINUTES` and is picked up again. Work older than
`RETRY_GIVE_UP_HOURS` is abandoned: a reminder six hours late is a confusing
call at the wrong time of day, and without a ceiling a permanently failing item
would retry forever.

**Webhook compatibility.** `dose` and `attempt` remain in the webhook URLs
exactly as before; `sched`, `ch` and `mr` are appended and every one is
optional. A call already in flight during a deploy still completes on the new
code, and an unreachable database degrades to the built-in prompt rather than
failing the call.

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

`MORNING_CRON` and `EVENING_CRON` are **gone** — call times live in the `schedules` table now. If they are still set on your Railway service, delete them; nothing reads them and leaving them there suggests they still control something.

You also need `DATABASE_URL`, added in Step 3b below.

Optional overrides (defaults in parentheses): `MAX_CALL_ATTEMPTS` (3), `RETRY_DELAY_MINUTES` (5), `MAX_REPROMPTS` (3), `SCHEDULE_GRACE_MINUTES` (5), `RETRY_STALE_CLAIM_MINUTES` (10), `RETRY_GIVE_UP_HOURS` (6), `ESCALATE_WITH_CALL` (false), `ESCALATE_WITH_SMS` (true), `ESCALATION_ACK_MINUTES` (3). The last three, like the retry settings, are only fallbacks for an escalation with no schedule behind it — each schedule carries its own columns.

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

**The redirect holds for the whole sequence, retries included.** Each attempt records the number it actually dialled in `call_history.to_phone`, and the sweeper retries *that* number rather than rebuilding it from the schedule's contact. Without it a test call rang the test phone on the first attempt and the real contact on the retry — with nothing in the history to show it had happened, because `contact_id` records who a call was *about*, not where it went. `npm run db:history` now marks a redirected attempt explicitly:

```
XX  Aug 04, 04:46  CALL  morning  try 1  NOT_CONFIRMED  Grandma → +1512…9999 (redirected)
```

Escalation steps are unaffected: those always go to the schedule's escalation contact, so a test call that runs to exhaustion still alerts the **real** caregiver.

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
| `TIMEZONE` | `America/Chicago` | Default for new records and alert timestamps. Each schedule row carries its own |
| `DATABASE_URL` | — | Postgres connection. On Railway, add it as a **reference** to the Postgres service, not a pasted copy |
| `PORT` | `3000` | Assigned by Railway; don't set it there |
| `BASE_URL` | auto | Public URL for webhooks. Derived from `RAILWAY_PUBLIC_DOMAIN` when unset |
| `MOCK_MODE` | `true` | `true` = terminal simulation, `false` = real Twilio |
| `TRIGGER_SECRET` | — | Shared secret for `POST /trigger` |
| `VALIDATE_TWILIO_SIGNATURE` | `true` | Verify webhook signatures |
| `NODE_ENV` | `development` | `production` switches logs to JSON |
| `SCHEDULE_GRACE_MINUTES` | `5` | How late a schedule may still fire after its minute |
| `RETRY_STALE_CLAIM_MINUTES` | `10` | How long a sweeper's claim on queued work stays valid |
| `RETRY_GIVE_UP_HOURS` | `6` | Queued work older than this is abandoned |

These five are **fallbacks only**. A call placed from a schedule uses that schedule's own columns; these apply to a manual `/trigger` with nothing seeded, and to a webhook arriving without context (a call in flight across a deploy).

| Variable | Default | Description |
|---|---|---|
| `MAX_CALL_ATTEMPTS` | `3` | Total call attempts, counting the first |
| `RETRY_DELAY_MINUTES` | `5` | Minutes between retries after no answer |
| `MAX_REPROMPTS` | `3` | Max re-asks within a single answered call |
| `MACHINE_DETECTION` | `true` | Hang up on voicemail instead of leaving a message. Applies to every call, not just schedule-driven ones |
| `ESCALATE_WITH_CALL` | `false` | Call the fallback contact before texting them |
| `ESCALATE_WITH_SMS` | `true` | Text the fallback contact |
| `ESCALATION_ACK_MINUTES` | `3` | Grace period to press 1 on the escalation call before the text goes out |

Seed-only, read by `prisma/seed.js` and never by the running app:

| Variable | Default | Description |
|---|---|---|
| `SEED_ACCOUNT_EMAIL` | — | The account the seed creates |
| `SEED_RECIPIENT_NAME` | `Grandma` | Contact name for `GRANDMA_PHONE_NUMBER` |
| `SEED_CAREGIVER_NAME` | `Caregiver` | Contact name for `CAREGIVER_PHONE_NUMBER` |

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

## Seeding and verifying

```bash
npm run db:seed              # create anything missing, touch nothing existing
npm run db:seed -- --force   # also overwrite settings on rows that already exist
```

The seed reproduces exactly what the environment variables used to configure: your account, your grandmother as the recipient contact, you as the caregiver, a default TTS message whose wording is character-for-character what the app already speaks, and the two schedules.

It reads phone numbers from `GRANDMA_PHONE_NUMBER` / `CAREGIVER_PHONE_NUMBER`, so nothing personal lives in the repo, and it refuses to run if either is missing or not in E.164 format — a schedule with no reachable number looks configured and never calls anyone.

Re-running it is safe. The default is deliberately additive: once you've edited a schedule in Prisma Studio, a redeploy that re-runs the seed must not quietly put your changes back. `--force` is how you say you meant it, and even then `enabled` and `last_fired_at` are left alone — one is a deliberate on/off switch, the other is the double-call guard.

**The Sunday-morning gap is data now, not code.** The seed writes morning as `days_of_week = [1,2,3,4,5,6]` because the 9:20 AM call was interrupting her Sunday School class. That used to be a hardcoded special case in `scheduler.js`; it now lives in the column, which is the only place it can be changed. Evening is every day.

### Verifying end to end

```bash
# 1. Place a call that pulls contact, message and escalation settings from the DB
curl -X POST "https://YOUR-APP.up.railway.app/trigger?dose=morning&target=test" \
  -H "X-Trigger-Secret: YOUR_TRIGGER_SECRET"
```

The response tells you where the configuration came from — `"source": "database"` means the schedule was found, `"env fallback"` means nothing is seeded yet:

```json
{ "ok": true, "dose": "morning", "target": "test", "mode": "real",
  "source": "database",
  "schedule": { "id": "…", "name": "Morning meds", "contact": "Grandma" } }
```

```bash
# 2. See the attempt it recorded
npm run db:history            # last 20 attempts, escalation chains indented
npm run db:history -- 50      # last 50
npm run db:history -- --queue # only what the sweeper still owes
```

```
ok  Aug 02, 21:07  CALL      morning  try 1  CONFIRMED      Grandma +1512…
                     1 reprompts  |  CA…
XX  Aug 02, 23:42  CALL      evening  try 3  NO_ANSWER      Grandma +1512…
     └─ XX  Aug 02, 23:43  ESC CALL  evening  try 1  NO_ANSWER   Caregiver +1512…
              CA…  |  "no answer after all 3 attempts"
          └─ ok  Aug 02, 23:44  ESC SMS   evening  try 1  SENT   Caregiver +1512…
```

`npm run db:studio` opens the same data for editing.

---

## Tests

```bash
npm test
```

Five suites. `scheduleMatch` is pure and needs nothing; the other four read and write a real database and **truncate every table between cases**.

They refuse to run the moment they see an account whose email is not a `@example.test` fixture — so once you have seeded your real account, `DATABASE_URL` must point at a **scratch database** before `npm test` will do anything.

The cheapest way is a second database on the same Postgres server, which already exists:

```bash
# one-off, if it is ever dropped
psql "$DATABASE_URL" -c 'CREATE DATABASE medication_reminder_test'

# then, per run — note the database name at the end of the URL
DATABASE_URL='postgresql://postgres:PASSWORD@HOST:PORT/medication_reminder_test' npx prisma migrate deploy
DATABASE_URL='postgresql://postgres:PASSWORD@HOST:PORT/medication_reminder_test' npm test
```

`?schema=` is **not** a substitute. The Prisma CLI honours it, so migrations land in the named schema, but the running client connects through a plain node-postgres adapter that ignores it and reads `public` — the isolation silently collapses and the suites truncate your real tables. The database name in the URL path is respected by every layer; the schema parameter is not. `src/db.js` warns at boot if it ever sees one.

---

## API

Session-authenticated JSON, everything scoped to the logged-in account.

```
POST   /api/signup                 { email, password, name? } → { account }  — signs you in
POST   /api/login                  { email, password } → { account }
POST   /api/logout
GET    /api/me                     → { account }   — how a frontend checks auth state

GET    /api/contacts               POST /api/contacts
GET    /api/contacts/:id           PATCH /api/contacts/:id     DELETE /api/contacts/:id
GET    /api/messages               POST /api/messages
GET    /api/messages/:id           PATCH /api/messages/:id     DELETE /api/messages/:id
GET    /api/schedules              POST /api/schedules
GET    /api/schedules/:id          PATCH /api/schedules/:id    DELETE /api/schedules/:id
POST   /api/schedules/:id/enabled  { enabled: true|false }

GET    /api/call-history?limit=&offset=&from=&to=&contactId=&dose=
```

`call_history` is **read-only** — there is no POST, PATCH or DELETE. It records calls placed to a real person about real medication, and an API that can rewrite it is an API that can hide a missed dose.

### Account scoping

Every write goes through `updateMany`/`deleteMany` filtered on `{ id, accountId }`, never `update({ where: { id } })`. A request carrying another account's row id therefore matches **zero rows and returns 404** rather than succeeding against data that isn't yours. That is the property that makes a second user an addition rather than an audit of every query, and the API suite proves it by asserting the other account's rows are unchanged afterwards — a 404 has to mean nothing happened, not merely that nothing was returned.

### Validation

Input rules mirror the database's CHECK constraints, so a bad payload is a 400 naming the field rather than a 500 from a constraint violation:

```json
{ "error": "Validation failed",
  "details": { "phone": "must be E.164 format — a plus, country code and number, e.g. +15125550123" } }
```

Phone numbers must be E.164, times `HH:MM`, `daysOfWeek` 1–7 unique days in 0–6, and timezones must resolve through `Intl.DateTimeFormat` — a plain string check would accept `US/Central-ish` and fail at 9:20. Prisma errors are translated too: `P2002` → 409, `P2003` → 409, `P2025` → 404, CHECK violations → 400.

Two rules exist only because the database cannot express them: a schedule may not have *both* escalation steps off (nobody would be told about a missed dose), and its contact and message must belong to the same account — a foreign key proves a row exists, not whose it is.

---

## Authentication

Session cookie, `httpOnly` + `SameSite=Lax` + `Secure` in production, signed with `SESSION_SECRET`. Sessions live in Postgres, not memory, so a redeploy does not sign you out — the same reasoning that moved retries out of `setTimeout`.

```bash
npm run set-password                  # the only account
npm run set-password -- you@mail.com  # a specific one
```

The password is typed, never passed as an argument — an argument lands in shell history and the process list. This is how you *change* a password, and the only way to give one to an account created by the seed: such an account has a `NULL` hash, and **an account with no hash cannot log in at all**.

Sign in at `/login`, register at `/signup`.

### Open registration

`/signup` is public. Anyone who reaches the URL can create an account, and **every call and text they schedule is placed on this deployment's Twilio credentials and billed to its owner.** That is a deliberate choice, not an oversight, and it is worth understanding what does and does not contain it:

- A new account starts **empty** — no contacts, no schedules, no history. It can only ring numbers it adds itself.
- Every query is account-scoped, so a new account cannot see or touch anyone else's rows. The API suite proves this by asserting the other account's data is unchanged afterwards.
- **`/trigger` is scoped too.** It previously resolved schedules across *all* accounts, which open registration would have turned into "any stranger can ring the owner's grandmother". A session now only reaches its own schedules, and a foreign schedule id is a 404.
- **`target=test` is admin-only.** It dials `TEST_PHONE_NUMBER` — a real handset belonging to whoever runs this. `ADMIN_EMAIL` names the one account allowed to use it; `/api/me` reports `isAdmin` so the interface hides those buttons from everyone else, and `/trigger` checks for itself regardless, because a client is free to ignore what it is told.
- Signup is rate-limited to 3 per IP per 15 minutes, tighter than login's 10 — a burst of registrations is never legitimate.

What is *not* contained: a registered user can add any phone number and schedule calls to it, on your Twilio balance. If that becomes a problem, set `SIGNUP_ENABLED=false` in Railway — it takes effect on the next request, no deploy — and consider a spend cap in the Twilio console.

`GRANDMA_PHONE_NUMBER`, `CAREGIVER_PHONE_NUMBER` and `TEST_PHONE_NUMBER` are **per-deployment, not per-account**. They belong to whoever runs this, and `accounts.isAdmin()` is what keeps other accounts away from them.

Leaving `ADMIN_EMAIL` unset falls back to the oldest account. That is the weaker rule — it is implicit, and would move to whoever registered next if the original account were ever deleted. Name the email.

**What stays public:** `/webhook/*` keeps its Twilio signature validation and never sees the session middleware at all — Twilio cannot log in, and a live call takes exactly the path it did before auth existed. `/trigger` now accepts **either** a session cookie or the `X-Trigger-Secret` header, so existing curl testing is unaffected.

Login is rate-limited to 10 attempts per IP per 15 minutes. That counter is in memory, so it resets on redeploy — it slows an attacker rather than locking them out, which is the right trade for a single-user app behind a long password.

---

## The interface

Sign in at `/login`, and the app is at `/app`. Five screens:

| | |
|---|---|
| **Today** | Next call and how far off, doses confirmed so far, anything the sweeper still owes, and buttons to place a call now |
| **Schedules** | Time, days, contact, message, and the whole escalation chain. Enable/disable per schedule |
| **Contacts** | Who can be called. Deleting one still used by a schedule is refused, naming the schedule |
| **Messages** | Spoken text or an audio file, and which is the default |
| **History** | Every attempt, escalation steps nested under the attempt that caused them, filterable by date, contact and dose |

**No build step.** Plain ES modules served straight from `public/app/`, matching the same stance `schema.prisma` takes about the Prisma generator: nothing that turns a deploy into a compile, because a build failure on this app means the calls stop. Railway still runs `npm ci` and nothing else.

**The whole thing is gated at the route,** not just by the API it calls — `/app` and every module under it redirect to `/login` without a session. The markup names contacts and schedules, so serving it to anyone who asks would leak who gets called even if every `fetch` came back 401.

**Times are shown in the account's timezone,** not the browser's. "Did she take her morning pills" is a question about her clock, and checking from another timezone should not silently shift every time by hours.

**`nextRunAt` is computed server-side** and returned by `GET /api/schedules`. Working it out in the browser would mean the same DST-sensitive arithmetic written twice, and the failure that invites is an interface confidently displaying a time the scheduler disagrees with. It is reported for disabled schedules too, so the UI can say *"would have been…"* rather than going blank on the state where nobody gets called.

Destructive things ask first, and say what they mean: disabling a schedule warns that no calls will be placed, and **Call now** names the number it is about to ring.

---

## Known limitations (Phase 3, later steps)

- **Single user.** The schema and every query are already account-scoped; what's missing is a way to create a second account, not the isolation.
- **No live updates.** Screens load on navigation; a call placed while you're watching needs a refresh to appear.
- **Escalation always goes to the real caregiver,** including from a `target=test` call. Only the reminder call's destination is redirected.
