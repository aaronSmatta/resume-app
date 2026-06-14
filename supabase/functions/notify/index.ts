// Resume — reminder sender (Supabase Edge Function, Deno)
//
// Runs on a daily schedule, reads your contacts + notification preferences from
// the `resume_data` table, figures out which events / meetings / birthdays fall
// within your chosen lead time, and sends an email (Resend) and/or text (Twilio).
//
// Deploy + schedule instructions: see NOTIFICATIONS.md at the repo root.
//
// Required environment variables (set with `supabase secrets set ...`):
//   SUPABASE_URL                 - your project URL (usually injected automatically)
//   SUPABASE_SERVICE_ROLE_KEY    - service role key (injected automatically)
//   RESEND_API_KEY               - https://resend.com  (for email)
//   FROM_EMAIL                   - verified sender, e.g. "Resume <reminders@yourdomain.com>"
//   TWILIO_ACCOUNT_SID           - https://twilio.com  (for SMS)
//   TWILIO_AUTH_TOKEN
//   TWILIO_FROM                  - your Twilio number, e.g. "+14155550123"
//   REMINDER_TZ_OFFSET           - optional, hours offset from UTC for "today" (e.g. "-8")

const env = (k: string) => Deno.env.get(k) ?? "";

const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

// ── Date helpers ────────────────────────────────────────────────────────────
const tzOffset = parseInt(env("REMINDER_TZ_OFFSET") || "0", 10);
function todayLocal(): Date {
  const now = new Date(Date.now() + tzOffset * 3600_000);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
function parseYMD(s: string): Date | null {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}
function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}
function nextBirthday(bday: string, today: Date): { date: Date; days: number } | null {
  // Accepts "MM-DD" (current format) or legacy "YYYY-MM-DD"
  const parts = bday.split("-").map(Number);
  const mo = parts.length === 3 ? parts[1] : parts[0];
  const dy = parts.length === 3 ? parts[2] : parts[1];
  if (!mo || !dy) return null;
  let next = new Date(Date.UTC(today.getUTCFullYear(), mo - 1, dy));
  if (next < today) next = new Date(Date.UTC(today.getUTCFullYear() + 1, mo - 1, dy));
  return { date: next, days: daysBetween(today, next) };
}
const fmtDate = (d: Date) =>
  d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const relLabel = (n: number) => (n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`);

// ── Supabase read ───────────────────────────────────────────────────────────
async function readRows(): Promise<{ people: any[]; config: any }> {
  const url = `${SUPABASE_URL}/rest/v1/resume_data?id=in.(main,config)&select=id,data`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase read failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  const people = rows.find((r: any) => r.id === "main")?.data ?? [];
  const config = rows.find((r: any) => r.id === "config")?.data ?? {};
  return { people, config };
}

// ── Build the list of due reminders ─────────────────────────────────────────
type Item = { date: Date; days: number; line: string };

function collectDue(people: any[], notify: any): Item[] {
  const today = todayLocal();
  const lead = Math.max(0, Number(notify.leadDays ?? 2));
  const want = notify.types ?? { events: true, meetings: true, birthdays: true };
  const items: Item[] = [];
  const seenGroups = new Set<string>();

  for (const p of people) {
    const who = (ids?: string[]) => (ids?.length ? ids.join(", ") : p.name);

    if (want.events) {
      for (const ev of p.events ?? []) {
        const d = parseYMD(ev.date);
        if (!d) continue;
        if (ev.groupId) { if (seenGroups.has(ev.groupId)) continue; seenGroups.add(ev.groupId); }
        const days = daysBetween(today, d);
        if (days >= 0 && days <= lead) {
          const parts = [ev.time, ev.title || "Event"].filter(Boolean).join(" ");
          items.push({ date: d, days, line: `📅 ${parts} — ${ev.participants?.length ? ev.participants.join(", ") : p.name}${ev.location ? ` @ ${ev.location}` : ""} (${relLabel(days)})` });
        }
      }
    }

    if (want.meetings) {
      for (const c of p.conversations ?? []) {
        const d = parseYMD(c.nextMeeting);
        if (!d) continue;
        const days = daysBetween(today, d);
        if (days >= 0 && days <= lead) {
          items.push({ date: d, days, line: `🤝 ${c.nextMeetingNote || "Catch-up"} with ${p.name} (${relLabel(days)})` });
        }
      }
    }

    if (want.birthdays && p.birthday) {
      const nb = nextBirthday(p.birthday, today);
      if (nb && nb.days >= 0 && nb.days <= lead) {
        items.push({ date: nb.date, days: nb.days, line: `🎂 ${p.name}'s birthday (${relLabel(nb.days)})` });
      }
    }
  }
  return items.sort((a, b) => a.days - b.days);
}

// ── Senders ─────────────────────────────────────────────────────────────────
async function sendEmail(to: string, subject: string, items: Item[]) {
  const key = env("RESEND_API_KEY");
  const from = env("FROM_EMAIL");
  if (!key || !from || !to) return { skipped: "email: missing config" };
  const rows = items.map((i) => `<tr><td style="padding:6px 0;border-bottom:1px solid #eee">${i.line}</td></tr>`).join("");
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px">
    <h2 style="color:#DC5A1A">Your upcoming reminders</h2>
    <table style="width:100%;border-collapse:collapse">${rows}</table>
    <p style="color:#999;font-size:12px;margin-top:18px">Sent by Resume — Remember What Matters.</p></div>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html }),
  });
  return { status: res.status, body: await res.text() };
}

async function sendSms(to: string, items: Item[]) {
  const sid = env("TWILIO_ACCOUNT_SID");
  const token = env("TWILIO_AUTH_TOKEN");
  const from = env("TWILIO_FROM");
  if (!sid || !token || !from || !to) return { skipped: "sms: missing config" };
  const body = "Resume reminders:\n" + items.map((i) => "• " + i.line.replace(/[📅🤝🎂]/gu, "").trim()).join("\n");
  const form = new URLSearchParams({ To: to, From: from, Body: body.slice(0, 1500) });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${sid}:${token}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  return { status: res.status, body: await res.text() };
}

// ── Handler ─────────────────────────────────────────────────────────────────
Deno.serve(async () => {
  try {
    const { people, config } = await readRows();
    const notify = config?.notify ?? {};
    if (!notify.enabled) return Response.json({ ok: true, skipped: "reminders disabled" });

    const items = collectDue(people, notify);
    if (!items.length) return Response.json({ ok: true, sent: 0, message: "nothing due" });

    const subject = `Resume: ${items.length} reminder${items.length > 1 ? "s" : ""} coming up`;
    const out: Record<string, unknown> = { ok: true, due: items.length };
    if (notify.channels?.email && notify.email) out.email = await sendEmail(notify.email, subject, items);
    if (notify.channels?.sms && notify.phone) out.sms = await sendSms(notify.phone, items);
    return Response.json(out);
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
