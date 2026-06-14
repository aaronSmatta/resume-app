# Email & SMS reminders — setup

The app stores your reminder preferences (recipient email, phone, lead time, and
which of events / meetings / birthdays to include) in Supabase. A small scheduled
**Supabase Edge Function** (`supabase/functions/notify`) reads those preferences
once a day and sends the reminders via **Resend** (email) and **Twilio** (SMS).

The app itself is a static page and cannot send email or texts on its own — that
is why this one-time backend setup is required. Your provider API keys live only
in Supabase as secrets; they are never in the web app.

> In the app: open **Settings** (gear in the sidebar), turn on **Email & text
> reminders**, and fill in your email, mobile number (with country code, e.g.
> `+14155551234`), lead time, and toggles. Those values are what this function reads.

---

## 1. Prerequisites

- A **Resend** account + API key, and a verified sender domain/address — https://resend.com
- A **Twilio** account (Account SID, Auth Token) and an SMS-capable phone number — https://twilio.com
- The **Supabase CLI** — https://supabase.com/docs/guides/cli  (`npm i -g supabase`)

## 2. Link the project

```bash
supabase login
supabase link --project-ref mjrlpysiunnuaqjryoxp   # your project ref
```

## 3. Set the secrets

```bash
supabase secrets set \
  RESEND_API_KEY=re_xxxxxxxx \
  FROM_EMAIL="Resume <reminders@yourdomain.com>" \
  TWILIO_ACCOUNT_SID=ACxxxxxxxx \
  TWILIO_AUTH_TOKEN=xxxxxxxx \
  TWILIO_FROM="+14155550123" \
  REMINDER_TZ_OFFSET="-8"        # optional: your hours-from-UTC, e.g. -8 for PST
```
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to the function automatically.

## 4. Deploy

```bash
supabase functions deploy notify
```

Send a test run (replace with your project ref + an anon or service key):

```bash
curl -X POST "https://mjrlpysiunnuaqjryoxp.functions.supabase.co/notify" \
  -H "Authorization: Bearer YOUR_ANON_KEY"
```
You should get JSON back like `{"ok":true,"due":2,"email":{...},"sms":{...}}`.

## 5. Schedule it daily

**Option A — Supabase Dashboard:** Edge Functions → `notify` → **Cron** → add a
schedule, e.g. `0 13 * * *` (13:00 UTC daily).

**Option B — SQL (pg_cron + pg_net):** run this in the SQL editor once:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'resume-daily-reminders',
  '0 13 * * *',  -- every day at 13:00 UTC; adjust to your morning
  $$
  select net.http_post(
    url     := 'https://mjrlpysiunnuaqjryoxp.functions.supabase.co/notify',
    headers := jsonb_build_object('Authorization', 'Bearer YOUR_ANON_KEY')
  );
  $$
);
```

To change the time later: `select cron.unschedule('resume-daily-reminders');` then re-add.

---

## How "due" is decided

For each contact the function looks at:

- **Events** (`events[]`) and **meetings** (`conversations[].nextMeeting`) whose
  date is between today and `today + leadDays`.
- **Birthdays** whose next occurrence is within `leadDays`.

Group events (shared `groupId`) are de-duplicated so they appear once. Only the
channels and categories you enabled in **Settings** are sent.

## Notes & limits

- Designed to run **once per day**. If your cron fires more often you may get
  duplicate messages within the lead window.
- SMS bodies are trimmed to ~1500 characters.
- Twilio trial accounts can only text **verified** numbers and prepend a trial
  notice — fine for personal use; upgrade to remove the limit.
