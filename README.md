# Medication Reminder

**An app that calls your loved one to remind them to take their medication — and alerts you if they don't.**

Built after my grandmother kept missing doses. Twice a day, the app places an automated phone call: *"Have you taken your medicine? Press 1 for yes."* If she confirms, that's it. If she doesn't answer or says no, the app retries — and if she still can't be reached, it calls and texts a caregiver so a real person knows a dose was missed.

## How it works

```
9:20 AM  →  📞 Call Grandma ── "Press 1 if you've taken your medicine"
                 │
                 ├─ Presses 1  →  ✅ Done. Logged as confirmed.
                 │
                 └─ No answer / says no
                      │
                      ├─ 🔁 Retry twice, 5 minutes apart
                      │
                      └─ Still nothing?  →  🚨 Call + text the caregiver
```

A few details it gets right:

- **Voicemail doesn't count.** If an answering machine picks up, the app hangs up and retries — it never marks a dose confirmed because a robot heard the message.
- **Retries survive crashes and redeploys.** Every pending retry and alert lives in the database, not in memory, so a restart can't silently swallow a missed-dose alert.
- **No duplicate calls.** Database-level locking guarantees each scheduled call fires exactly once, and each caregiver alert is sent exactly once.
- **Phone numbers are verified.** A contact doesn't exist until its number confirms a 6-digit code, so a typo can never get dialed.

## What's inside

| Piece | What it does |
|---|---|
| **Web dashboard** | Manage schedules, contacts, messages, and browse the full call history |
| **Scheduler** | Fires calls at each schedule's local time — timezone- and DST-aware |
| **Call engine** | Twilio voice calls with keypad/voice responses, retries, and escalation |
| **REST API** | Session-authenticated JSON API behind the dashboard |
| **Mock mode** | Simulate every call scenario in your terminal — no Twilio account needed |

**Stack:** Node.js · Express · PostgreSQL (Prisma) · Twilio Programmable Voice · deployed on Railway

## Try it in 2 minutes (no phone required)

```bash
git clone https://github.com/YOUR_USERNAME/medication-reminder.git
cd medication-reminder
npm install
cp .env.example .env        # MOCK_MODE=true is already set

npm run test:morning        # simulate a morning reminder call
```

The terminal plays the part of Grandma. Type `1` to confirm, `2` to say no, or just press Enter to not answer — and watch the retry and escalation logic play out.

## Running it for real

You'll need a [Twilio](https://www.twilio.com) account with a phone number (~$1/month) and a PostgreSQL database. It's built to deploy on [Railway](https://railway.com) in a few clicks:

1. Push this repo to GitHub (private) and create a Railway project from it
2. Add a Postgres database and set your Twilio credentials as environment variables
3. Seed the database: `npm run db:seed`
4. Place a test call to your own phone before pointing it at the real recipient

The full walkthrough — every environment variable, Twilio setup, verification steps, and troubleshooting — is in **[docs/DETAILS.md](docs/DETAILS.md)**.

## Useful commands

```bash
npm run db:history     # what actually happened — every call, retry, and alert
npm run db:studio      # edit schedules, contacts, and messages in a GUI
npm test               # run the test suites (needs a scratch database)
```

## Docs

Everything in this README is the short version. **[docs/DETAILS.md](docs/DETAILS.md)** has the complete documentation: architecture, call-flow edge cases, the escalation chain, deployment guide, API reference, security notes, and configuration reference.
