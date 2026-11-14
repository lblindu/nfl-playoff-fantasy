-- ============================================================
-- NFL Playoff Fantasy Football - Supabase Schema
-- Run this in the Supabase SQL editor
-- ============================================================

-- Users (mirrors auth.users, populated on first login)
create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  avatar_url text,
  is_admin boolean default false,
  created_at timestamptz default now()
);

-- Leagues
create table if not exists public.leagues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  season int not null,                    -- e.g. 2026
  status text not null default 'setup',  -- setup | drafting | active | complete
  draft_started_at timestamptz,
  created_by uuid references public.users(id),
  created_at timestamptz default now()
);

-- League members (participants)
create table if not exists public.league_members (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  display_name text,
  draft_order int,                        -- snake draft position
  total_score numeric default 0,
  created_at timestamptz default now(),
  unique(league_id, user_id)
);

-- NFL teams (per season, pulled from API)
create table if not exists public.nfl_teams (
  id uuid primary key default gen_random_uuid(),
  season int not null,
  api_team_id text not null,
  name text not null,
  abbr text,
  city text,
  logo_url text,
  primary_color text,
  secondary_color text,
  in_playoffs boolean default false,
  is_eliminated boolean default false,
  eliminated_round text,                  -- Wildcard | Divisional | Conference | Superbowl
  confirmed boolean default false,        -- admin confirmed this team is in playoffs
  created_at timestamptz default now(),
  unique(season, api_team_id)
);

-- Players pool (per season, pulled from API for playoff teams)
create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  season int not null,
  api_player_id text not null,
  name text not null,
  position text,                          -- QB | RB | WR | TE | FB
  jersey_number text,
  headshot_url text,
  nfl_team_id uuid references public.nfl_teams(id),
  is_available boolean default true,      -- false if eliminated or injured+no swap
  confirmed boolean default false,        -- admin reviewed
  created_at timestamptz default now(),
  unique(season, api_player_id)
);

-- Draft picks
create table if not exists public.draft_picks (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues(id) on delete cascade,
  member_id uuid not null references public.league_members(id),
  player_id uuid not null references public.players(id),
  pick_number int not null,               -- overall pick #
  round int not null,                     -- draft round
  picked_at timestamptz default now(),
  unique(league_id, player_id),
  unique(league_id, pick_number)
);

-- Games (from API — playoff games only)
create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  season int not null,
  api_game_id text not null unique,
  playoff_round text not null,            -- Wildcard | Divisional | Conference | Superbowl
  game_date date,
  kickoff_time text,
  status text,                            -- NS | 1Q | 2Q | HT | 3Q | 4Q | OT | FT
  home_team_id uuid references public.nfl_teams(id),
  away_team_id uuid references public.nfl_teams(id),
  home_score int,
  away_score int,
  winner_team_id uuid references public.nfl_teams(id),
  last_synced_at timestamptz,
  created_at timestamptz default now()
);

-- Per-game player scoring (upserted on each stats refresh)
create table if not exists public.game_player_scores (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  player_id uuid not null references public.players(id),
  api_player_id text not null,
  pass_yds numeric default 0,
  pass_td int default 0,
  interceptions int default 0,
  rush_yds numeric default 0,
  rush_td int default 0,
  receptions int default 0,
  rec_yds numeric default 0,
  rec_td int default 0,
  fumbles int default 0,
  two_pt int default 0,
  points numeric default 0,
  last_updated timestamptz default now(),
  unique(game_id, player_id)
);

-- Materialized per-member scores (updated after each game_player_scores upsert)
-- One row per member per round so standings queries are fast
create table if not exists public.member_round_scores (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues(id) on delete cascade,
  member_id uuid not null references public.league_members(id),
  playoff_round text not null,
  points numeric default 0,
  updated_at timestamptz default now(),
  unique(league_id, member_id, playoff_round)
);

-- ============================================================
-- Row Level Security
-- ============================================================

alter table public.users enable row level security;
alter table public.leagues enable row level security;
alter table public.league_members enable row level security;
alter table public.nfl_teams enable row level security;
alter table public.players enable row level security;
alter table public.draft_picks enable row level security;
alter table public.games enable row level security;
alter table public.game_player_scores enable row level security;
alter table public.member_round_scores enable row level security;

-- Users: anyone can read, only own row writable
create policy "users_read_all" on public.users for select using (true);
create policy "users_insert_own" on public.users for insert with check (auth.uid() = id);
create policy "users_update_own" on public.users for update using (auth.uid() = id);

-- Leagues: anyone authenticated can read
create policy "leagues_read" on public.leagues for select using (auth.role() = 'authenticated');
create policy "leagues_write_admin" on public.leagues for all using (
  exists (select 1 from public.users where id = auth.uid() and is_admin = true)
);

-- League members: members of the league can read; admins manage
create policy "members_read" on public.league_members for select using (auth.role() = 'authenticated');
create policy "members_write_admin" on public.league_members for all using (
  exists (select 1 from public.users where id = auth.uid() and is_admin = true)
);

-- NFL teams + players: public read
create policy "nfl_teams_read" on public.nfl_teams for select using (true);
create policy "nfl_teams_write_admin" on public.nfl_teams for all using (
  exists (select 1 from public.users where id = auth.uid() and is_admin = true)
);
create policy "players_read" on public.players for select using (true);
create policy "players_write_admin" on public.players for all using (
  exists (select 1 from public.users where id = auth.uid() and is_admin = true)
);

-- Draft picks: authenticated can read; inserts handled by server with service key
create policy "draft_picks_read" on public.draft_picks for select using (auth.role() = 'authenticated');

-- Games + scores: public read
create policy "games_read" on public.games for select using (true);
create policy "scores_read" on public.game_player_scores for select using (true);
create policy "member_scores_read" on public.member_round_scores for select using (true);

-- ============================================================
-- Function: upsert user profile on login
-- ============================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.users (id, email, display_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do update set
    email = excluded.email,
    display_name = coalesce(excluded.display_name, public.users.display_name),
    avatar_url = coalesce(excluded.avatar_url, public.users.avatar_url);
  return new;
end;
$$;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Live draft: broadcast new picks over Supabase Realtime
alter publication supabase_realtime add table public.draft_picks;
