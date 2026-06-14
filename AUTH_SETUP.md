# Sign-in setup (Supabase Auth + row-level security)

The app now requires a real sign-in (Supabase Auth) instead of the old shared
passcode. After the one-time steps below, you can sign in on your phone and your
computer with the same email/password and see the same, always-up-to-date data —
and nobody who simply has the URL can read it.

These steps are done in your **Supabase dashboard** for project
`mjrlpysiunnuaqjryoxp` — I can't do them for you because they change your project's
security settings.

---

## 1. Enable email sign-in

Dashboard → **Authentication → Providers → Email** → make sure **Email** is
enabled.

- For the smoothest experience on a personal app, you can turn **"Confirm email"
  OFF** (Authentication → Providers → Email). Then creating an account logs you
  straight in.
- If you leave confirmation ON, you'll get a confirmation link by email the first
  time, then you can sign in.

## 2. Create your account

Two options:

- **In the app:** open it, choose **"Create an account"**, enter your email +
  password (6+ characters). With email confirmation off you're signed in
  immediately.
- **Or in the dashboard:** Authentication → **Users → Add user** → enter email +
  password.

> Want to let your spouse use it too? Add them as another user the same way —
> everyone signs in to the same shared data.

## 3. Lock the database to signed-in users (RLS)

This is the step that actually stops anyone-with-the-URL from reading your data.
Dashboard → **SQL Editor**, paste and run:

```sql
alter table public.resume_data enable row level security;

-- Remove any older permissive policies if present
drop policy if exists "public read"  on public.resume_data;
drop policy if exists "public write" on public.resume_data;

-- Only signed-in users can read/write
create policy "authenticated read"
  on public.resume_data for select
  to authenticated using (true);

create policy "authenticated insert"
  on public.resume_data for insert
  to authenticated with check (true);

create policy "authenticated update"
  on public.resume_data for update
  to authenticated using (true) with check (true);
```

That's it. With RLS on and these policies, the public anon key can no longer read
the table — requests must carry a valid signed-in session, which the app attaches
automatically after you log in.

## 4. (Optional) keep realtime sync working

Realtime is already used for cross-device updates and works for authenticated
users. If you ever stop seeing live updates, check Database → **Replication** and
make sure the `resume_data` table is included in the `supabase_realtime`
publication.

---

## Notes

- The **reminder edge function** (see `NOTIFICATIONS.md`) uses the *service role*
  key, so it keeps working regardless of RLS.
- Password reset uses the email link flow (the "Forgot password?" link on the
  sign-in screen). Configure the redirect/site URL under Authentication → URL
  Configuration if needed.
- This replaces the previous client-side passcode; the old passcode is no longer
  used.
