-- Profiles: one row per auth user, created automatically on sign-up.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null,
  first_name text not null,
  last_name text not null,
  photo_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Username uniqueness/search is case-insensitive; the column itself preserves
-- the casing the user chose at sign-up as the display version.
create unique index profiles_username_lower_idx on public.profiles (lower(username));

alter table public.profiles enable row level security;

create policy "profiles_select_own"
  on public.profiles for select
  to authenticated
  using (id = auth.uid());

create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Trigger to maintain updated_at.
create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row
  execute function public.set_updated_at();

-- Creates the profile row from sign-up metadata (first_name/last_name/username
-- passed via supabase.auth.signUp({ options: { data: {...} } })).
-- A unique_violation here (duplicate username) aborts the auth.users insert,
-- which surfaces as an error from the signUp() call on the client.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username, first_name, last_name)
  values (
    new.id,
    new.raw_user_meta_data ->> 'username',
    new.raw_user_meta_data ->> 'first_name',
    new.raw_user_meta_data ->> 'last_name'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- Lets the sign-up form pre-check availability without exposing other users'
-- profile rows to anonymous/authenticated callers.
create function public.is_username_available(p_username text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select not exists (
    select 1 from public.profiles where lower(username) = lower(p_username)
  );
$$;

grant execute on function public.is_username_available(text) to anon, authenticated;

-- Limited-field username search used when an organizer invites a player.
-- Only exposes id/username/first_name/last_name — never email or other data.
create function public.search_profile_by_username(p_username text)
returns table (id uuid, username text, first_name text, last_name text)
language sql
security definer
set search_path = public
stable
as $$
  select id, username, first_name, last_name
  from public.profiles
  where lower(username) = lower(p_username)
  limit 1;
$$;

grant execute on function public.search_profile_by_username(text) to authenticated;
