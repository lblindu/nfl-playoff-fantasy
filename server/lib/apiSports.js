const BASE = 'https://v1.american-football.api-sports.io';
const NFL_LEAGUE_ID = '1';

async function call(path, params = {}) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const url = `${BASE}${path}${qs ? '?' + qs : ''}`;

  const res = await fetch(url, {
    headers: { 'x-apisports-key': process.env.APISPORTS_KEY }
  });

  if (!res.ok) throw new Error(`API Sports ${path} → ${res.status}`);
  return res.json();
}

// Pull all NFL playoff teams for a season
async function getPlayoffTeams(season) {
  const data = await call('/teams', { league: NFL_LEAGUE_ID, season });
  return (data.response || []).map(t => ({
    api_team_id: String(t.id || t.team?.id),
    name: t.name || t.team?.name,
    abbr: t.code || t.team?.code || t.abbreviation || '',
    city: t.city || '',
    logo_url: t.logo || t.team?.logo || null,
  }));
}

// Pull offense-skill players for a team
async function getTeamPlayers(teamId, season) {
  const data = await call('/players', { team: teamId, season });
  const ALLOWED_POS = new Set(['QB', 'RB', 'WR', 'TE', 'FB']);
  return (data.response || [])
    .filter(p => {
      const grp = String(p.group || '').toLowerCase();
      const pos = String(p.position || '').toUpperCase();
      return grp === 'offense' && ALLOWED_POS.has(pos);
    })
    .map(p => ({
      api_player_id: String(p.id),
      name: p.name || '',
      position: String(p.position || '').toUpperCase(),
      jersey_number: String(p.number || ''),
    }));
}

// Pull NFL postseason games for a date range
async function getPostseasonGames(season, startDate, endDate) {
  const results = [];
  const start = new Date(startDate);
  const end = new Date(endDate);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().slice(0, 10);
    try {
      const data = await call('/games', { date: dateStr, league: NFL_LEAGUE_ID, season });
      for (const g of (data.response || [])) {
        const gameObj = g.game || g;
        const stage = String(gameObj.stage || g.stage || '').toLowerCase();
        if (!stage.includes('post')) continue;

        results.push({
          api_game_id: String(gameObj.id),
          game_date: dateStr,
          status: String(gameObj.status?.short || gameObj.status || ''),
          home_api_team_id: String(g.teams?.home?.id || ''),
          away_api_team_id: String(g.teams?.away?.id || ''),
          home_score: g.scores?.home?.total ?? null,
          away_score: g.scores?.away?.total ?? null,
          round: String(gameObj.round || gameObj.week || ''),
        });
      }
      await sleep(300);
    } catch (e) {
      console.error(`getPostseasonGames ${dateStr}:`, e.message);
    }
  }
  return results;
}

// Pull player stats for a single game
async function getGamePlayerStats(gameId) {
  const data = await call('/games/statistics/players', { id: gameId });
  return data.response || [];
}

// Parse grouped stats response into a Map(apiPlayerId -> statLine)
function parseGroupedStats(responseArr) {
  const acc = new Map();

  const norm = s => String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
  const toNum = v => {
    if (v === null || v === undefined) return 0;
    const s = String(v).trim();
    if (!s) return 0;
    if (s.includes('/')) return Number(s.split('/')[0]) || 0;
    return Number(s) || 0;
  };

  for (const teamBlock of responseArr) {
    for (const grp of (teamBlock.groups || [])) {
      const gname = norm(grp.name);
      for (const pw of (grp.players || [])) {
        const pid = String(pw.player?.id || '').trim();
        const pname = pw.player?.name || '';
        if (!pid) continue;

        if (!acc.has(pid)) {
          acc.set(pid, { id: pid, name: pname, team: teamBlock.team?.name || '', passYds: 0, passTD: 0, int: 0, rushYds: 0, rushTD: 0, rec: 0, recYds: 0, recTD: 0, fumbles: 0, fumblesLost: false, twoPt: 0 });
        }
        const row = acc.get(pid);

        for (const st of (pw.statistics || [])) {
          const k = norm(st.name);
          const v = toNum(st.value);

          if (gname === 'passing') {
            if (k === 'yards') row.passYds = v;
            else if (k.includes('touch down') || k === 'touchdowns') row.passTD = v;
            else if (k === 'interceptions') row.int = v;
            else if (k.includes('two pt') || k.includes('two point')) row.twoPt += v;
          }
          if (gname === 'rushing') {
            if (k === 'yards') row.rushYds = v;
            else if (k.includes('touch down') || k === 'touchdowns') row.rushTD = v;
            else if (k.includes('two pt') || k.includes('two point')) row.twoPt += v;
          }
          if (gname === 'receiving') {
            if (k === 'total receptions' || k === 'receptions') row.rec = v;
            else if (k === 'yards') row.recYds = v;
            else if (k.includes('touch down') || k === 'touchdowns') row.recTD = v;
            else if (k.includes('two pt') || k.includes('two point')) row.twoPt += v;
          }
          if (gname.includes('fumble')) {
            if (k === 'lost') { row.fumbles = v; row.fumblesLost = true; }
            else if (k === 'total' && !row.fumblesLost) row.fumbles = v;
          }
        }
      }
    }
  }

  return acc;
}

// Compute fantasy points from a stat line
function computePoints(statLine) {
  const n = v => Number(v) || 0;
  let pts = 0;
  pts += n(statLine.passYds) / 25;
  pts += n(statLine.passTD) * 4;
  pts += n(statLine.int) * -2;
  pts += n(statLine.rushYds) * 0.1;
  pts += n(statLine.rushTD) * 6;
  pts += n(statLine.rec) * 1;
  pts += n(statLine.recYds) * 0.1;
  pts += n(statLine.recTD) * 6;
  pts += n(statLine.fumbles) * -2;
  pts += n(statLine.twoPt) * 2;
  return Math.round(pts * 100) / 100;
}

// One game's current status and score (used to settle a game after it leaves the live feed)
async function getGame(gameId) {
  const data = await call('/games', { id: gameId });
  const g = (data.response || [])[0];
  if (!g) return null;
  return { status: String(g.game?.status?.short || ''), homeScore: g.scores?.home?.total ?? null, awayScore: g.scores?.away?.total ?? null };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { getGame, call, getPlayoffTeams, getTeamPlayers, getPostseasonGames, getGamePlayerStats, parseGroupedStats, computePoints, NFL_LEAGUE_ID };
