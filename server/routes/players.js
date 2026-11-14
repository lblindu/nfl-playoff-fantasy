const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { getPlayoffTeams, getTeamPlayers } = require('../lib/apiSports');

// GET /api/players?season=2026&leagueId=xxx — available players (undrafted in this league)
router.get('/', async (req, res) => {
  const { season, leagueId, teamId, position } = req.query;
  if (!season) return res.status(400).json({ error: 'season required' });

  let query = supabase
    .from('players')
    .select(`
      id, name, position, jersey_number, headshot_url, api_player_id,
      nfl_teams!inner(id, name, abbr, primary_color, secondary_color, logo_url, is_eliminated)
    `)
    .eq('season', season)
    .eq('confirmed', true);

  if (teamId) query = query.eq('nfl_team_id', teamId);
  if (position) query = query.eq('position', position);

  const { data: players, error } = await query.order('position').order('name');
  if (error) return res.status(500).json({ error: error.message });

  // If leagueId provided, mark which are drafted
  let draftedIds = new Set();
  if (leagueId) {
    const { data: picks } = await supabase
      .from('draft_picks')
      .select('player_id')
      .eq('league_id', leagueId);
    draftedIds = new Set((picks || []).map(p => p.player_id));
  }

  const result = players.map(p => ({ ...p, drafted: draftedIds.has(p.id) }));
  res.json(result);
});

// GET /api/players/teams?season=2026 — playoff teams
router.get('/teams', async (req, res) => {
  const { season } = req.query;
  if (!season) return res.status(400).json({ error: 'season required' });

  const { data, error } = await supabase
    .from('nfl_teams')
    .select('*')
    .eq('season', season)
    .eq('in_playoffs', true)
    .order('name');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/players/pull-teams — admin: pull playoff teams from API
router.post('/pull-teams', requireAdmin, async (req, res) => {
  const { season } = req.body;
  if (!season) return res.status(400).json({ error: 'season required' });

  try {
    const teams = await getPlayoffTeams(season);

    const rows = teams.map(t => ({
      season: parseInt(season),
      api_team_id: t.api_team_id,
      name: t.name,
      abbr: t.abbr,
      city: t.city,
      logo_url: t.logo_url,
      in_playoffs: false,  // admin must confirm which 14 are in playoffs
      confirmed: false,
    }));

    const { data, error } = await supabase
      .from('nfl_teams')
      .upsert(rows, { onConflict: 'season,api_team_id' })
      .select();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ imported: data.length, teams: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/players/teams/:id — admin: update team (confirm, set color, etc.)
router.patch('/teams/:id', requireAdmin, async (req, res) => {
  const allowed = ['in_playoffs', 'confirmed', 'primary_color', 'secondary_color', 'is_eliminated', 'eliminated_round'];
  const updates = {};
  for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];

  const { data, error } = await supabase
    .from('nfl_teams')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/players/pull-players — admin: pull players for all confirmed playoff teams
router.post('/pull-players', requireAdmin, async (req, res) => {
  const { season } = req.body;
  if (!season) return res.status(400).json({ error: 'season required' });

  const { data: teams, error: teamErr } = await supabase
    .from('nfl_teams')
    .select('id, api_team_id, name')
    .eq('season', season)
    .eq('in_playoffs', true);

  if (teamErr || !teams?.length) return res.status(400).json({ error: 'No confirmed playoff teams found' });

  let totalImported = 0;
  for (const team of teams) {
    try {
      const players = await getTeamPlayers(team.api_team_id, season);
      const rows = players.map(p => ({
        season: parseInt(season),
        api_player_id: p.api_player_id,
        name: p.name,
        position: p.position,
        jersey_number: p.jersey_number,
        nfl_team_id: team.id,
        confirmed: false,
      }));

      if (rows.length) {
        await supabase.from('players').upsert(rows, { onConflict: 'season,api_player_id' });
        totalImported += rows.length;
      }
      await new Promise(r => setTimeout(r, 300)); // rate limit
    } catch (e) {
      console.error(`pull-players team ${team.name}:`, e.message);
    }
  }

  res.json({ imported: totalImported });
});

// PATCH /api/players/:id — admin: confirm/update a player
router.patch('/:id', requireAdmin, async (req, res) => {
  const allowed = ['confirmed', 'is_available', 'headshot_url'];
  const updates = {};
  for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];

  const { data, error } = await supabase
    .from('players')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/players/confirm-all — admin: confirm all players for a season at once
router.post('/confirm-all', requireAdmin, async (req, res) => {
  const { season } = req.body;
  const { error } = await supabase
    .from('players')
    .update({ confirmed: true })
    .eq('season', season);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

function requireAdmin(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });
  next();
}

module.exports = router;
