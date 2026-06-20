# Medication Reminder

Automated twice-daily phone calls reminding your grandmother to take her medication, built with Node.js + Twilio Programmable Voice.

Calls are placed at **9:20 AM and 9:20 PM US Central time** by default. If she doesn't answer, it retries up to 2 more times (5 minutes apart). If she never confirms, it texts you (the caregiver) an SMS alert.

**No Twilio account required to run right now** — `MOCK_MODE=true` simulates every branch interactively in the terminal.

---

## Quick start — test in mock mode today

```bash
# 1. Clone / unzip the project, then:
cd medication-reminder
npm install

# 2. The .env file is already present with MOCK_MODE=true
#    (Edit GRANDMA_PHONE_NUMBER / CAREGIVER_PHONE_NUMBER — any placeholder is fine for mock testing)

# 3. Simulate a morning call right now:
npm run test:morning

# 4. Simulate an evening call:
npm run test:evening
```

When the simulation starts you'll see the call "ringing" and a prompt. Enter:

| Input | Meaning |
|---|---|
| `1` or `yes` | She picks up and confirms she took her medicine |
| `2` or `no` | She picks up and says no (triggers reprompt loop) |
| `[Enter]` or `no answer` | No pickup (triggers retry logic) |

Walk through a full scenario to see every branch — reprompts, retries, and the mock SMS alert box.

### What to test

**Happy path** — she picks up immediately and says yes:
```
> 1        ← picks up
> 1        ← says yes
→ "Great! Have a good rest of your day."  ✅  Call complete.
```

**Reprompt loop** — she picks up but keeps saying no (3 reprompts, then SMS):
```
> 2        ← picks up
Reprompt 1:  > 2
Reprompt 2:  > 2
Reprompt 3:  > 2
→ Goodbye message + 📲 MOCK SMS ALERT printed
```

**No-answer + retry + SMS** — never picks up:
```
Attempt 1:  > [Enter]
Attempt 2:  > [Enter]
Attempt 3:  > [Enter]
→ 📲 MOCK SMS ALERT printed
```

**Mixed** — misses first call, picks up on retry, says yes:
```
Attempt 1:  > [Enter]
Attempt 2:  > yes
→ "Great! Have a good rest of your day."  ✅
```

Logs are written to `logs/calls.log` (JSONL) after every run.

---

## Architecture

```
app.js              Express server + CLI --test flag
src/
  config.js         All settings from .env with defaults
  logger.js         Timestamps every event to logs/calls.log + stdout
  scheduler.js      node-cron fires at 9:20 AM / 9:20 PM (Central)
  callManager.js    Routes to mock or real, owns retry + escalation logic
  twimlHandler.js   Express router: /webhook/initial /response /status
  mockMode.js       Interactive terminal simulation (mock mode only)
  smsAlert.js       Sends SMS via Twilio (or prints box in mock mode)
```

### Call flow (both modes)

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

### Timezone

Calls are scheduled in `TIMEZONE=America/Chicago` (US Central). node-cron resolves this automatically against the IANA database, so it self-adjusts for Daylight Saving Time — no manual offset needed.

---

## Going live with Twilio

### Step 1 — Create a Twilio account

1. Go to [twilio.com](https://www.twilio.com) and sign up for a free trial.
2. Verify your own phone number (required for trial accounts).

### Step 2 — Get your credentials

In the Twilio Console dashboard:

- Copy **Account SID** (starts with `AC…`)
- Copy **Auth Token** (click the eye icon to reveal)

### Step 3 — Buy a phone number

1. Console → Phone Numbers → Buy a Number
2. Buy a US number with Voice capability (~$1/month)
3. Copy the number in E.164 format: `+1XXXXXXXXXX`

### Step 4 — Verify trial phone numbers

On a **trial account** Twilio can only call numbers you've verified:

1. Console → Phone Numbers → Verified Caller IDs → Add a New Caller ID
2. Verify **grandma's number** (she'll get a call with a code)
3. Verify **your caregiver number** (for SMS delivery)

(Verified-number restriction is lifted once you upgrade to a paid account.)

### Step 5 — Expose your local server with ngrok

Twilio webhooks need a public HTTPS URL. On your Mac mini:

```bash
# Install ngrok
brew install ngrok/ngrok/ngrok

# Sign up free at https://ngrok.com, then add your auth token:
ngrok config add-authtoken <YOUR_NGROK_TOKEN>

# Grab a free static domain so the URL doesn't change between restarts:
# Dashboard → Cloud Edge → Domains → New Domain (1 free static domain on free tier)

# Start the tunnel (replace YOUR-STATIC-DOMAIN with your ngrok domain):
ngrok http --domain=YOUR-STATIC-DOMAIN.ngrok-free.app 3000
```

Your app is now reachable at `https://YOUR-STATIC-DOMAIN.ngrok-free.app`.

### Step 6 — Update .env

```ini
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_PHONE_NUMBER=+1XXXXXXXXXX        # the number you bought in Step 3

GRANDMA_PHONE_NUMBER=+1XXXXXXXXXX       # her real number
CAREGIVER_PHONE_NUMBER=+1XXXXXXXXXX     # your number

BASE_URL=https://YOUR-STATIC-DOMAIN.ngrok-free.app

MOCK_MODE=false
```

### Step 7 — Test a real call

```bash
# Start the app:
node app.js

# In another terminal, trigger an immediate call:
curl -X POST http://localhost:3000/trigger?dose=morning
```

Watch `logs/calls.log` and the Twilio Console call logs to verify everything works end-to-end.

---

## Running persistently with pm2

```bash
# Install pm2 globally (once):
npm install -g pm2

# Start the app:
pm2 start ecosystem.config.js

# Make it restart on system reboot:
pm2 startup
pm2 save

# Useful commands:
pm2 status                          # see process status
pm2 logs medication-reminder        # tail live logs
pm2 restart medication-reminder     # restart (e.g. after .env change)
pm2 stop medication-reminder        # stop without removing

# Watch structured call logs:
tail -f logs/calls.log | python3 -m json.tool
```

---

## Configuration reference

| Variable | Default | Description |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | — | Twilio account SID (real mode) |
| `TWILIO_AUTH_TOKEN` | — | Twilio auth token (real mode) |
| `TWILIO_PHONE_NUMBER` | — | Your Twilio number in E.164 format |
| `GRANDMA_PHONE_NUMBER` | — | Her number (E.164) |
| `CAREGIVER_PHONE_NUMBER` | — | Your number for SMS alerts (E.164) |
| `TIMEZONE` | `America/Chicago` | IANA timezone — calls follow this clock |
| `MORNING_CRON` | `20 9 * * *` | Cron expression for 9:20 AM |
| `EVENING_CRON` | `20 21 * * *` | Cron expression for 9:20 PM |
| `PORT` | `3000` | Express server port |
| `BASE_URL` | `http://localhost:3000` | Public URL Twilio uses for webhooks |
| `MOCK_MODE` | `true` | `true` = terminal simulation, `false` = real Twilio |
| `MAX_CALL_ATTEMPTS` | `3` | Total call attempts (1 initial + 2 retries) |
| `RETRY_DELAY_MINUTES` | `5` | Minutes between retries after no answer |
| `MAX_REPROMPTS` | `3` | Max re-asks within a single answered call |

---

## Logs

Every call attempt and outcome is recorded in `logs/calls.log` as newline-delimited JSON:

```jsonl
{"ts":"2025-06-08T14:20:00.000Z","level":"call","message":"Mock: no answer","dose":"morning","attempt":1}
{"ts":"2025-06-08T14:20:05.000Z","level":"call","message":"Mock: medication confirmed","dose":"morning","attempt":2,"repromptCount":1}
```

The `level` field is `info`, `warn`, `error`, or `call` (call-specific events).
