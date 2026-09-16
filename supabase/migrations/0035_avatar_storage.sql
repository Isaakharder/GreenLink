-- ============================================================================
-- Member avatars: a private Supabase Storage bucket + the profiles/RPC
-- plumbing to reference it. Bundled as one migration (matching 0028's
-- precedent for a single cohesive feature) rather than several near-
-- simultaneous ones: storage bucket + policies, a profiles ownership
-- constraint, and the two RPC extensions that expose the new column all
-- ship together for this one feature.
--
-- Deterministic, single object per user: {user_id}/avatar.webp. Adding a
-- photo, replacing it, and the initial add all go through the same
-- `upload(..., { upsert: true })` call to this one path -- there is no
-- separate "old file" to clean up on replace, and removal is a single
-- `remove([path])` at that same fixed path. This is what "we should not
-- accumulate abandoned avatar files" actually resolves to structurally,
-- rather than needing a garbage-collection job.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) The bucket. Private (public = false) -- GreenLink is a private member
-- club; photos are read via short-lived signed URLs (see useAvatarUrl.ts),
-- never a public/plain URL. file_size_limit and allowed_mime_types are a
-- second layer of enforcement behind the client-side validation in
-- avatarImage.ts (which always re-encodes to webp before upload) -- a
-- client that skipped/tampered with that step still can't upload something
-- outside these bounds.
-- ----------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 5242880, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- 2) storage.objects RLS for this bucket.
--
-- Write policies (insert/update/delete): restricted to the caller's own
-- folder -- (storage.foldername(name))[1] is the first path segment of the
-- object's name, i.e. the {user_id} in "{user_id}/avatar.webp". This is
-- Supabase's standard per-user-folder storage pattern.
--
-- Read policy: this is the one genuinely narrow trade-off, spelled out
-- because it was explicitly asked to be inspected carefully. Supabase
-- Storage has exactly one RLS-governed read permission per bucket -- a
-- `select` policy on storage.objects -- and it backs THREE client
-- operations identically: fetching a specific object, generating a signed
-- URL for a specific object (createSignedUrl checks this same policy
-- before issuing a token), and *listing* a bucket/folder's contents. There
-- is no finer-grained "allow signed-URL issuance but not listing" lever in
-- Postgres RLS -- both are the same `select` grant. So the actual choice is
-- between (a) no authenticated member can ever see another member's avatar
-- at all, or (b) grant `select` on this bucket to the `authenticated` role,
-- which is technically sufficient for someone to also call
-- `storage.from('avatars').list()`.
--
-- (b) is what's implemented, scoped as narrowly as this mechanism allows:
--   - `anon` gets nothing at all -- the bucket is fully inaccessible
--     without a real GreenLink session.
--   - The grant is scoped to `bucket_id = 'avatars'` only, not blanket
--     access to storage.objects across every bucket.
--   - What a full bucket listing would actually reveal -- a set of user
--     UUIDs and the fixed filename "avatar.webp" -- is not new exposure:
--     list_members() already hands every authenticated client the full
--     set of profile ids today. Nothing about a member's identity, name,
--     username, or email is reachable through this policy; it only gates
--     access to the avatar bytes themselves, exactly as intended.
-- ----------------------------------------------------------------------------

create policy "avatars_select_authenticated"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'avatars');

create policy "avatars_insert_own"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "avatars_update_own"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "avatars_delete_own"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- ----------------------------------------------------------------------------
-- 3) profiles.photo_path ownership constraint. profiles updates go through
-- a direct client .update() (profiles_update_own RLS already restricts
-- *which row*, 0001) rather than a validating RPC, so without this a user
-- could point their own photo_path at another user's exact (already-
-- uploaded) object path as a cosmetic trick. Not a data-exposure issue --
-- avatars are visible to every authenticated member regardless -- but
-- cheap to close outright. Exact-match, not a prefix LIKE, since every
-- profile has at most one deterministic path.
-- ----------------------------------------------------------------------------

alter table public.profiles add constraint profiles_photo_path_owned
  check (photo_path is null or photo_path = id::text || '/avatar.webp');

-- ----------------------------------------------------------------------------
-- 4) list_members(): add photo_path. Column set changes, so drop-then-
-- create (per the 0019 postmortem this codebase already documents) rather
-- than create-or-replace. Not a new privacy exposure -- it's a storage
-- path, not a signed URL or any account/auth information -- the frontend
-- resolves it into a viewable image via useAvatarUrl, itself gated by the
-- storage policies above.
-- ----------------------------------------------------------------------------

drop function if exists public.list_members();

create function public.list_members()
returns table (
  id uuid,
  first_name text,
  last_name text,
  username text,
  photo_path text,
  completed_rounds_count integer,
  member_since timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select
    p.id,
    p.first_name,
    p.last_name,
    p.username,
    p.photo_path,
    coalesce(rc.completed_rounds_count, 0)::integer as completed_rounds_count,
    p.created_at as member_since
  from public.profiles p
  left join lateral (
    select count(distinct tp.tournament_id) as completed_rounds_count
    from public.tournament_players tp
    join public.tournaments t on t.id = tp.tournament_id
    where tp.user_id = p.id
      and tp.membership_status = 'accepted'
      and t.status = 'completed'
  ) rc on true
  order by p.first_name, p.last_name;
$$;

revoke execute on function public.list_members() from public;
grant execute on function public.list_members() to authenticated;

-- ----------------------------------------------------------------------------
-- 5) get_public_round_feed(): add player_id and player_photo_path, needed
-- for Community Feed avatars. Same drop-then-create reasoning as above.
-- ----------------------------------------------------------------------------

drop function if exists public.get_public_round_feed(integer);

create function public.get_public_round_feed(p_limit integer default 30)
returns table (
  tournament_id uuid,
  player_id uuid,
  player_first_name text,
  player_last_name text,
  player_photo_path text,
  course_name text,
  tee_name text,
  tournament_date date,
  completed_at timestamptz,
  hole_count integer,
  total_strokes bigint,
  relative_to_par bigint
)
language sql
security definer
set search_path = public
stable
as $$
  select
    t.id as tournament_id,
    p.id as player_id,
    p.first_name as player_first_name,
    p.last_name as player_last_name,
    p.photo_path as player_photo_path,
    t.course_name,
    gct.tee_name,
    t.tournament_date,
    t.completed_at,
    t.hole_count,
    coalesce(sum(s.strokes), 0) as total_strokes,
    coalesce(sum(s.strokes - h.par), 0) as relative_to_par
  from public.tournaments t
  join public.personal_rounds pr on pr.tournament_id = t.id
  join public.profiles p on p.id = t.organizer_user_id
  left join public.golf_course_tees gct on gct.id = t.golf_course_tee_id
  left join public.team_hole_scores s on s.tournament_id = t.id
  left join public.tournament_holes h on h.tournament_id = t.id and h.hole_number = s.hole_number
  where t.is_personal and t.status = 'completed' and pr.visibility = 'public'
  group by t.id, p.id, p.first_name, p.last_name, p.photo_path, t.course_name, gct.tee_name, t.tournament_date, t.completed_at, t.hole_count
  order by t.completed_at desc
  limit greatest(coalesce(p_limit, 30), 0);
$$;

grant execute on function public.get_public_round_feed(integer) to authenticated;
