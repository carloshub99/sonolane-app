-- SonoLane — core backend schema (profiles + friends)
--
-- HOW TO RUN THIS:
--   1. Open your Supabase project → SQL Editor (left sidebar)
--   2. Click "New query", paste this entire file in, click "Run"
--   3. That's it — the tables, security rules, and triggers below are all
--      created in one shot.
--
-- SCOPE: this covers real accounts + profiles + friends, matching the
-- "core first" plan. Lanes chat, shared garages, routes/events, and
-- achievements/points stay on the app's existing simulated local data for
-- now and can be migrated the same way later.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. PROFILES
-- One row per signed-up user, keyed to Supabase's built-in auth.users table.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text not null default '',
  handle      text unique,                 -- lowercase, no spaces — e.g. "mia.drifts"
  bio         text not null default '',
  photo_url   text,                        -- data URL for now; swap for Supabase Storage later
  initials    text not null default '',
  color       text not null default '#f97316',
  created_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Anyone signed in can read basic profile info — needed so the Friends
-- page's "search people by name" can find other real users, the same way
-- it searched the old simulated directory.
create policy "Profiles are readable by any signed-in user"
  on public.profiles for select
  to authenticated
  using (true);

-- You can only ever edit or create your own profile row.
create policy "Users can insert their own profile"
  on public.profiles for insert
  to authenticated
  with check (auth.uid() = id);

create policy "Users can update their own profile"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Auto-create a blank profile row the moment someone signs up, so the app
-- never has to worry about a missing profiles row for a logged-in user.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, initials, color)
  values (
    new.id,
    upper(left(coalesce(new.email, 'U'), 2)),
    ('#' || substr(md5(new.id::text), 1, 6))
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─────────────────────────────────────────────────────────────────────────
-- 2. FRIENDS
-- One row = "owner_id added friend_id as a friend". The app reads the
-- first 3 rows (by created_at) as someone's "Top 3 Friends", exactly like
-- the old local array's first three slots.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.friends (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  friend_id   uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (owner_id, friend_id),
  check (owner_id <> friend_id)
);

alter table public.friends enable row level security;

-- You can only see, add to, and remove from your own friends list.
create policy "Users can read their own friends list"
  on public.friends for select
  to authenticated
  using (auth.uid() = owner_id);

create policy "Users can add their own friends"
  on public.friends for insert
  to authenticated
  with check (auth.uid() = owner_id);

create policy "Users can remove their own friends"
  on public.friends for delete
  to authenticated
  using (auth.uid() = owner_id);

-- Helpful index for "give me this user's friends, oldest first" (= Top 3).
create index if not exists friends_owner_created_idx
  on public.friends (owner_id, created_at);
