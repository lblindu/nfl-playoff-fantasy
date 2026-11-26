const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const crypto = require('crypto');
const { findNextGame } = require('../lib/rosters');
const { leagueAccess } = require('../lib/access');
const { recalcMemberScores } = require('../jobs/scoring');
const { draftWindowError } = require('../lib/draftEngine');

// 14 playoff teams → 7 players per league, always
const LEAGUE_SIZE = 7;
// Season new leagues are created for (admins may pick another, e.g. 2024 test data)
const CURRENT_SEASON = parseInt(process.env.CURRENT_SEASON || '2026');

async function memberCount(leagueId) {
  const { count } = await supabase
    .from('league_members').select('*', { count: 'exact', head: true }).eq('league_id', leagueId);
  return count || 0;
}

async function addMember(leagueId, user, displayName) {
  return supabase
    .from('league_members')
    .insert({
      league_id: leagueId,
      user_id: user.id,
      display_name: displayName || user.display_name || (user.email || '').split('@')[0],
    })
    .select()
    .single();
}

async function randomizeDraftOrder(leagueId) {
  const { data: members } = await supabase.from('league_members').select('id').eq('league_id', leagueId);
  const order = (members || []).map(m => m.id);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  await Promise.all(order.map((id, i) =>
    supabase.from('league_members').update({ draft_order: i + 1 }).eq('id', id).eq('league_id', leagueId)));
}

// GET /api/leagues — the leagues you run or play in (admins see all)
router.get('/', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  let query = supabase
    .from('leagues')
    .select(`
      id, name, season, status, draft_started_at, created_by,
      league_members(count)
    `)
    .order('created_at', { ascending: false });

  if (!req.isAdmin) {
    const { data: mine } = await supabase.from('league_members').select('league_id').eq('user_id', req.userId);
    const ids = (mine || []).map(m => m.league_id);
    query = query.or(`created_by.eq.${req.userId}${ids.length ? `,id.in.(${ids.join(',')})` : ''}`);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/leagues/invite/:code — public preview shown on the invite page
router.get('/invite/:code', async (req, res) => {
  const { data: league } = await supabase
    .from('leagues')
    .select('id, name, season, status, created_by')
    .eq('invite_code', String(req.params.code).toLowerCase())
    .maybeSingle();
  if (!league) return res.status(404).json({ error: 'This invite link is not valid' });

  const [{ data: creator }, members] = await Promise.all([
    supabase.from('users').select('display_name, email').eq('id', league.created_by).maybeSingle(),
    memberCount(league.id),
  ]);
  res.json({
    name: league.name,
    season: league.season,
    status: league.status,
    members,
    size: LEAGUE_SIZE,
    commissioner: creator?.display_name || (creator?.email || '').split('@')[0] || 'the commissioner',
  });
});

// POST /api/leagues/join — join a league with its invite code
router.post('/join', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Sign in to join a league' });

  const { data: league } = await supabase
    .from('leagues')
    .select('id, status')
    .eq('invite_code', String(req.body.code || '').trim().toLowerCase())
    .maybeSingle();
  if (!league) return res.status(404).json({ error: 'This invite link is not valid' });

  const { data: existing } = await supabase
    .from('league_members').select('id').eq('league_id', league.id).eq('user_id', req.userId).maybeSingle();
  if (existing) return res.json({ id: league.id, alreadyMember: true });

  if (league.status !== 'setup') return res.status(400).json({ error: 'This league has already started its draft' });
  if (await memberCount(league.id) >= LEAGUE_SIZE) return res.status(400).json({ error: `This league is full (${LEAGUE_SIZE} players)` });

  const { data: user } = await supabase.from('users').select('id, email, display_name').eq('id', req.userId).single();
  const { error } = await addMember(league.id, user);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ id: league.id });
});

// GET /api/leagues/:id — full league detail (members, commissioner and admins only)
router.get('/:id', async (req, res) => {
  const access = await leagueAccess(req, req.params.id);
  if (!access.league) return res.status(404).json({ error: 'League not found' });
  if (!access.canView) return res.status(403).json({ error: 'You are not in this league' });

  const { data, error } = await supabase
    .from('leagues')
    .select(`
      *,
      league_members(
        id, display_name, draft_order, total_score,
        user_id,
        member_round_scores(playoff_round, points)
      )
    `)
    .eq('id', req.params.id)
    .single();

  if (error) return res.status(404).json({ error: 'League not found' });

  // Sort members by total score descending
  if (data.league_members) {
    data.league_members.sort((a, b) => (b.total_score || 0) - (a.total_score || 0));
  }

  res.json(data);
});

// POST /api/leagues — create a league. The creator is its commissioner and may or may not play.
router.post('/', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Sign in to create a league' });

  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'League name required' });
  if (name.length > 60) return res.status(400).json({ error: 'League name is too long (60 characters max)' });

  const season = req.isAdmin && req.body.season ? parseInt(req.body.season) : CURRENT_SEASON;
  const play = req.body.play !== false;
  const pickSeconds = [30, 60, 90].includes(Number(req.body.pick_seconds)) ? Number(req.body.pick_seconds) : 60;

  let league, error;
  for (let attempt = 0; attempt < 3; attempt++) {
    ({ data: league, error } = await supabase
      .from('leagues')
      .insert({ name, season, pick_seconds: pickSeconds, created_by: req.userId, invite_code: crypto.randomBytes(5).toString('hex') })
      .select()
      .single());
    if (!error || error.code !== '23505') break; // retry only on an invite-code collision
  }
  if (error) return res.status(500).json({ error: error.message });

  if (play) {
    const { data: user } = await supabase.from('users').select('id, email, display_name').eq('id', req.userId).single();
    const { error: mErr } = await addMember(league.id, user);
    if (mErr) return res.status(500).json({ error: mErr.message });
  }
  res.json(league);
});

// PATCH /api/leagues/:id — rename or change status (commissioner; admins can set any status)
router.patch('/:id', async (req, res) => {
  const access = await leagueAccess(req, req.params.id);
  if (!access.league) return res.status(404).json({ error: 'League not found' });
  if (!access.canManage) return res.status(403).json({ error: 'Only the commissioner can do that' });

  const updates = {};
  if (req.body.name !== undefined) updates.name = String(req.body.name).trim().slice(0, 60);
  if (req.body.pick_seconds !== undefined) {
    if (![30, 60, 90].includes(Number(req.body.pick_seconds))) return res.status(400).json({ error: 'Pick timer must be 30, 60 or 90 seconds' });
    updates.pick_seconds = Number(req.body.pick_seconds);
  }
  if (req.body.status !== undefined) {
    // Commissioners can start the draft; any other status change is for admins
    if (!req.isAdmin && !(req.body.status === 'drafting' && access.league.status === 'setup')) {
      return res.status(403).json({ error: 'Only an admin can change the league status like that' });
    }
    updates.status = req.body.status;
  }

  // A real league needs exactly 7 members to draft; admins can force it for testing
  if (updates.status === 'drafting') {
    if (!req.isAdmin) {
      const closed = await draftWindowError(access.league.season);
      if (closed) return res.status(400).json({ error: closed });
    }
    const count = await memberCount(req.params.id);
    if (count !== LEAGUE_SIZE && !(req.isAdmin && req.body.force)) {
      return res.status(400).json({ error: `A league needs exactly ${LEAGUE_SIZE} members to start the draft (has ${count}).` });
    }
    // Nobody set the order yet → randomize it
    const { data: members } = await supabase.from('league_members').select('draft_order').eq('league_id', req.params.id);
    if ((members || []).some(m => m.draft_order == null)) await randomizeDraftOrder(req.params.id);
  }

  const { data, error } = await supabase
    .from('leagues')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/leagues/:id/members — add a member by email (commissioner; they need an account)
router.post('/:id/members', async (req, res) => {
  const access = await leagueAccess(req, req.params.id);
  if (!access.league) return res.status(404).json({ error: 'League not found' });
  if (!access.canManage) return res.status(403).json({ error: 'Only the commissioner can add members' });
  if (access.league.status !== 'setup' && !req.isAdmin) return res.status(400).json({ error: 'The draft has started — the roster of players is locked' });

  const { email, display_name } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  if (await memberCount(req.params.id) >= LEAGUE_SIZE) {
    return res.status(400).json({ error: `League is full (${LEAGUE_SIZE} members max).` });
  }

  const { data: user } = await supabase
    .from('users')
    .select('id, email, display_name')
    .eq('email', email.toLowerCase().trim())
    .maybeSingle();

  if (!user) return res.status(404).json({ error: 'No user with that email. They must create an account first — or send them the invite link.' });

  const { data, error } = await addMember(req.params.id, user, display_name);
  if (error) return res.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? 'Already in this league' : error.message });
  res.json(data);
});

// POST /api/leagues/:id/swap — replace an OUT player with an undrafted player from the same NFL team
router.post('/:id/swap', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
  const leagueId = req.params.id;
  const { outPlayerId, inPlayerId, memberId, effectiveGameId } = req.body;
  if (!outPlayerId || !inPlayerId) return res.status(400).json({ error: 'outPlayerId and inPlayerId required' });

  const { data: members } = await supabase.from('league_members').select('id, user_id').eq('league_id', leagueId);
  const member = req.isAdmin && memberId
    ? members?.find(m => m.id === memberId)
    : members?.find(m => m.user_id === req.userId);
  if (!member) return res.status(403).json({ error: 'You are not a member of this league' });

  // The player being replaced must be active on this member's roster right now
  const [{ data: picks }, { data: swapRows }] = await Promise.all([
    supabase.from('draft_picks').select('player_id').eq('league_id', leagueId).eq('member_id', member.id),
    supabase.from('roster_swaps').select('out_player_id, in_player_id').eq('league_id', leagueId).eq('member_id', member.id),
  ]);
  const swaps = swapRows || [];
  const activeIds = (picks || []).map(p => {
    let cur = p.player_id;
    for (let s = swaps.find(x => x.out_player_id === cur); s; s = swaps.find(x => x.out_player_id === cur)) cur = s.in_player_id;
    return cur;
  });
  if (!activeIds.includes(outPlayerId)) return res.status(400).json({ error: 'That player is not on your active roster' });

  const { data: pair } = await supabase.from('players').select('*').in('id', [outPlayerId, inPlayerId]);
  const outP = pair?.find(p => p.id === outPlayerId);
  const inP = pair?.find(p => p.id === inPlayerId);
  if (!outP || !inP) return res.status(404).json({ error: 'Player not found' });

  if (outP.injury_status !== 'out') return res.status(400).json({ error: 'Only players marked OUT can be replaced' });
  if (inP.nfl_team_id !== outP.nfl_team_id) return res.status(400).json({ error: 'The replacement must be from the same NFL team' });
  if (inP.season !== outP.season || !inP.confirmed) return res.status(400).json({ error: 'That player is not in the draft pool' });

  // Replacement must be undrafted in this league (drafted, or already swapped in by anyone)
  const [{ data: drafted }, { data: swappedIn }] = await Promise.all([
    supabase.from('draft_picks').select('id').eq('league_id', leagueId).eq('player_id', inPlayerId),
    supabase.from('roster_swaps').select('id').eq('league_id', leagueId).eq('in_player_id', inPlayerId),
  ]);
  if (drafted?.length || swappedIn?.length) return res.status(409).json({ error: 'That player is already on a roster in this league' });

  // Position is free, but the roster still can't exceed 2 QBs
  if (inP.position === 'QB') {
    const { data: roster } = await supabase.from('players').select('id, position').in('id', activeIds);
    const qbs = (roster || []).filter(p => p.position === 'QB' && p.id !== outPlayerId).length;
    if (qbs >= 2) return res.status(400).json({ error: 'Maximum 2 QBs per roster' });
  }

  // The swap takes effect for the team's next game, and must be made before it kicks off
  let game;
  if (req.isAdmin && effectiveGameId) {
    const { data } = await supabase.from('games').select('id, home_team_id, away_team_id').eq('id', effectiveGameId).single();
    if (!data || ![data.home_team_id, data.away_team_id].includes(outP.nfl_team_id)) {
      return res.status(400).json({ error: 'That game does not involve this team' });
    }
    game = data;
  } else {
    game = await findNextGame(outP.nfl_team_id);
    if (!game) return res.status(400).json({ error: 'No upcoming game for this team — swaps close at kickoff' });
  }

  const { data: swap, error } = await supabase
    .from('roster_swaps')
    .insert({ league_id: leagueId, member_id: member.id, out_player_id: outPlayerId, in_player_id: inPlayerId, effective_game_id: game.id })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await recalcMemberScores();
  res.json(swap);
});

// DELETE /api/leagues/:id/members/:memberId — remove a player (commissioner, before the draft)
router.delete('/:id/members/:memberId', async (req, res) => {
  const access = await leagueAccess(req, req.params.id);
  if (!access.league) return res.status(404).json({ error: 'League not found' });
  if (!access.canManage) return res.status(403).json({ error: 'Only the commissioner can remove members' });
  if (access.league.status !== 'setup' && !req.isAdmin) return res.status(400).json({ error: 'The draft has started — players are locked' });

  const { error } = await supabase
    .from('league_members')
    .delete()
    .eq('id', req.params.memberId)
    .eq('league_id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// POST /api/leagues/:id/set-draft-order — set or randomize the draft order (commissioner, before the draft)
router.post('/:id/set-draft-order', async (req, res) => {
  const access = await leagueAccess(req, req.params.id);
  if (!access.league) return res.status(404).json({ error: 'League not found' });
  if (!access.canManage) return res.status(403).json({ error: 'Only the commissioner can set the draft order' });
  if (access.league.status !== 'setup' && !req.isAdmin) return res.status(400).json({ error: 'The draft has started — the order is locked' });

  const order = req.body.order; // array of member IDs in draft order; omitted = randomize
  if (order === undefined) {
    await randomizeDraftOrder(req.params.id);
    return res.json({ ok: true });
  }
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of member IDs' });

  await Promise.all(order.map((memberId, i) =>
    supabase.from('league_members').update({ draft_order: i + 1 }).eq('id', memberId).eq('league_id', req.params.id)));
  res.json({ ok: true });
});

module.exports = router;
