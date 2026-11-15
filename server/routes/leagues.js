const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { findNextGame } = require('../lib/rosters');
const { recalcMemberScores } = require('../jobs/scoring');

// 14 playoff teams → 7 players per league, always
const LEAGUE_SIZE = 7;

// GET /api/leagues — list all leagues (authenticated user sees theirs + public ones)
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('leagues')
    .select(`
      id, name, season, status, draft_started_at,
      league_members(count)
    `)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/leagues/:id — full league detail
router.get('/:id', async (req, res) => {
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

// POST /api/leagues — create league (admin only)
router.post('/', requireAdmin, async (req, res) => {
  const { name, season } = req.body;
  if (!name || !season) return res.status(400).json({ error: 'name and season required' });

  const { data, error } = await supabase
    .from('leagues')
    .insert({ name, season: parseInt(season), created_by: req.userId })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /api/leagues/:id — update status etc (admin only)
router.patch('/:id', requireAdmin, async (req, res) => {
  const allowed = ['name', 'status'];
  const updates = {};
  for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];

  // A real league needs exactly 7 members to draft; admins can force it for testing
  if (updates.status === 'drafting' && !req.body.force) {
    const { count } = await supabase
      .from('league_members').select('*', { count: 'exact', head: true }).eq('league_id', req.params.id);
    if (count !== LEAGUE_SIZE) {
      return res.status(400).json({ error: `A league needs exactly ${LEAGUE_SIZE} members to start the draft (has ${count}).` });
    }
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

// POST /api/leagues/:id/members — add member (admin only)
router.post('/:id/members', requireAdmin, async (req, res) => {
  const { email, display_name } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  const { count } = await supabase
    .from('league_members').select('*', { count: 'exact', head: true }).eq('league_id', req.params.id);
  if (count >= LEAGUE_SIZE) return res.status(400).json({ error: `League is full (${LEAGUE_SIZE} members max).` });

  // Find user by email
  const { data: user } = await supabase
    .from('users')
    .select('id, display_name')
    .eq('email', email.toLowerCase().trim())
    .single();

  if (!user) return res.status(404).json({ error: 'No user with that email. They must sign in first.' });

  const { data, error } = await supabase
    .from('league_members')
    .insert({
      league_id: req.params.id,
      user_id: user.id,
      display_name: display_name || user.display_name || email.split('@')[0],
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
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

// DELETE /api/leagues/:id/members/:memberId (admin only)
router.delete('/:id/members/:memberId', requireAdmin, async (req, res) => {
  const { error } = await supabase
    .from('league_members')
    .delete()
    .eq('id', req.params.memberId)
    .eq('league_id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// POST /api/leagues/:id/set-draft-order (admin only)
router.post('/:id/set-draft-order', requireAdmin, async (req, res) => {
  let order = req.body.order; // array of member IDs in draft order; omitted = randomize
  if (order === undefined) {
    const { data: members } = await supabase.from('league_members').select('id').eq('league_id', req.params.id);
    order = (members || []).map(m => m.id);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  }
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of member IDs' });

  const updates = order.map((memberId, i) =>
    supabase.from('league_members').update({ draft_order: i + 1 }).eq('id', memberId).eq('league_id', req.params.id)
  );
  await Promise.all(updates);
  res.json({ ok: true });
});

function requireAdmin(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });
  next();
}

module.exports = router;
