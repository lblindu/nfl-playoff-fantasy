const supabase = require('./supabase');
const { gameTime } = require('./rosters');

const ROSTER_SIZE = 14;
const PICK_SECONDS = [30, 60, 90];

const deadlineFrom = secs => new Date(Date.now() + secs * 1000).toISOString();

// Drafts open once the playoff field is set (regular season over) and close at the first playoff kickoff.
// Returns an error message when drafting isn't allowed right now, otherwise null.
async function draftWindowError(season) {
  const { data } = await supabase.from('games').select('game_date, kickoff_time, home_team_id, away_team_id').eq('season', season);
  const games = data || [];
  if (!games.some(g => g.home_team_id && g.away_team_id)) {
    return 'Drafts open when the regular season ends and the playoff teams are set.';
  }
  if (games.some(g => gameTime(g) <= Date.now())) {
    return 'The playoffs have started, so drafting is closed.';
  }
  return null;
}

// Roster rules: one player per NFL team, and exactly 2 quarterbacks.
// A pick is illegal if it would make the second QB impossible to get (not enough teams left that
// still have an undrafted QB), so a drafter is forced onto a QB before it is too late.
function rosterRuleError({ player, myTeams, myQbs, pool, takenIds }) {
  if (myTeams.has(player.nfl_team_id)) return 'You already drafted a player from that team';
  const isQb = player.position === 'QB';
  if (isQb && myQbs >= 2) return 'You already have 2 QBs';
  const need = 2 - (myQbs + (isQb ? 1 : 0));
  if (need > 0) {
    const capable = new Set(pool
      .filter(p => p.position === 'QB' && !takenIds.has(p.id) && p.id !== player.id
        && p.nfl_team_id !== player.nfl_team_id && !myTeams.has(p.nfl_team_id))
      .map(p => p.nfl_team_id));
    if (capable.size < need) {
      return isQb
        ? 'Drafting this QB would leave you unable to get your second QB'
        : `You still need ${need === 2 ? '2 QBs' : 'a second QB'} - draft a quarterback with this pick`;
    }
  }
  return null;
}

// Snake order: who is on the clock for the next pick (pickCount = picks made so far)
function memberOnClock(members, pickCount) {
  const n = members.length;
  if (!n) return null;
  const sorted = [...members].sort((a, b) => a.draft_order - b.draft_order);
  const round = Math.floor(pickCount / n);
  const slot = pickCount % n;
  return sorted[round % 2 === 0 ? slot : n - 1 - slot] || null;
}

// Applies every draft rule and inserts the pick. Returns { pick } or { status, error }.
// The caller has already decided WHO may pick; this decides whether the pick is legal.
async function attemptPick({ leagueId, memberId, playerId, auto = false }) {
  const [{ data: picks }, { data: members }, { data: league }] = await Promise.all([
    supabase.from('draft_picks').select('id, player_id, member_id').eq('league_id', leagueId),
    supabase.from('league_members').select('id, draft_order, user_id').eq('league_id', leagueId).order('draft_order'),
    supabase.from('leagues').select('id, status, pick_seconds, season').eq('id', leagueId).single(),
  ]);
  if (!league) return { status: 404, error: 'League not found' };

  const numTeams = members?.length || 0;
  const pickNum = picks?.length || 0;
  if (!numTeams) return { status: 400, error: 'League has no members' };
  if (pickNum >= numTeams * ROSTER_SIZE) return { status: 400, error: 'The draft is complete' };

  const expected = memberOnClock(members, pickNum);
  if (!expected || expected.id !== memberId) return { status: 403, error: 'Not your turn' };

  if ((picks || []).some(p => p.player_id === playerId)) return { status: 409, error: 'Player already drafted' };

  const { data: player } = await supabase.from('players').select('id, position, nfl_team_id').eq('id', playerId).single();
  if (!player) return { status: 404, error: 'Player not found' };

  const [{ data: memberPicks }, { data: pool }] = await Promise.all([
    supabase.from('draft_picks').select('players(position, nfl_team_id)').eq('league_id', leagueId).eq('member_id', memberId),
    supabase.from('players').select('id, position, nfl_team_id').eq('season', league.season).eq('confirmed', true),
  ]);
  const ruleErr = rosterRuleError({
    player,
    myTeams: new Set((memberPicks || []).map(p => p.players?.nfl_team_id)),
    myQbs: (memberPicks || []).filter(p => p.players?.position === 'QB').length,
    pool: pool || [],
    takenIds: new Set((picks || []).map(p => p.player_id)),
  });
  if (ruleErr) return { status: 400, error: ruleErr };

  const { data: pick, error } = await supabase
    .from('draft_picks')
    .insert({
      league_id: leagueId, member_id: memberId, player_id: playerId,
      pick_number: pickNum + 1, round: Math.floor(pickNum / numTeams) + 1,
      ...(auto ? { auto_picked: true } : {}),
    })
    .select().single();
  if (error) {
    // unique(league_id, pick_number): someone else picked at the same moment
    const dup = error.code === '23505';
    return { status: dup ? 409 : 500, error: dup ? 'That pick was just made' : error.message };
  }

  // Draft finished → lock rosters; otherwise restart the clock for the next drafter
  if (pickNum + 1 >= numTeams * ROSTER_SIZE) {
    await supabase.from('leagues').update({ status: 'active', pick_deadline: null }).eq('id', leagueId);
  } else {
    await supabase.from('leagues')
      .update({ pick_deadline: deadlineFrom(league.pick_seconds || 60) })
      .eq('id', leagueId).not('pick_deadline', 'is', null); // only while the clock is running
  }
  return { pick };
}

// Best-ranked player this member can legally take right now
async function chooseAutoPick(leagueId, memberId, season) {
  const [{ data: players }, { data: picks }] = await Promise.all([
    supabase.from('players')
      .select('id, name, position, nfl_team_id, overall_rank, nfl_teams!inner(id)')
      .eq('season', season).eq('confirmed', true),
    supabase.from('draft_picks').select('member_id, player_id, players(position, nfl_team_id)').eq('league_id', leagueId),
  ]);
  const taken = new Set((picks || []).map(p => p.player_id));
  const mine = (picks || []).filter(p => p.member_id === memberId);
  const myTeams = new Set(mine.map(p => p.players?.nfl_team_id));
  const myQbs = mine.filter(p => p.players?.position === 'QB').length;
  const pool = players || [];

  return pool
    .filter(p => !taken.has(p.id))
    .sort((a, b) => (a.overall_rank ?? 1e9) - (b.overall_rank ?? 1e9) || a.name.localeCompare(b.name))
    .find(p => !rosterRuleError({ player: p, myTeams, myQbs, pool, takenIds: taken })) || null;
}

// Runs every couple of seconds: when a clock runs out, pick for the member who timed out
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const { data: due } = await supabase.from('leagues')
      .select('id, season, pick_seconds, pick_deadline')
      .eq('status', 'drafting').not('pick_deadline', 'is', null)
      .lte('pick_deadline', new Date().toISOString());

    for (const lg of due || []) {
      // Atomically claim this expiry; if a real pick/undo/pause changed the deadline first, skip
      const { data: claimed } = await supabase.from('leagues')
        .update({ pick_deadline: deadlineFrom(lg.pick_seconds || 60) })
        .eq('id', lg.id).eq('pick_deadline', lg.pick_deadline).select('id');
      if (!claimed?.length) continue;

      const [{ data: members }, { count }] = await Promise.all([
        supabase.from('league_members').select('id, draft_order').eq('league_id', lg.id),
        supabase.from('draft_picks').select('id', { count: 'exact', head: true }).eq('league_id', lg.id),
      ]);
      const member = memberOnClock(members || [], count || 0);
      if (!member) continue;
      const player = await chooseAutoPick(lg.id, member.id, lg.season);
      if (!player) { console.error(`[draft] no eligible auto-pick for league ${lg.id}`); continue; }
      const r = await attemptPick({ leagueId: lg.id, memberId: member.id, playerId: player.id, auto: true });
      if (r.error) console.error(`[draft] auto-pick failed (${lg.id}): ${r.error}`);
      else console.log(`[draft] auto-picked ${player.name} in league ${lg.id}`);
    }
  } catch (e) {
    console.error('[draft] clock tick failed:', e.message);
  } finally {
    ticking = false;
  }
}

function startDraftClock() {
  setInterval(tick, 2000);
}

module.exports = { rosterRuleError, draftWindowError, attemptPick, memberOnClock, startDraftClock, deadlineFrom, PICK_SECONDS, ROSTER_SIZE };
