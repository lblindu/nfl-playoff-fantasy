const { call, NFL_LEAGUE_ID, getGamePlayerStats, parseGroupedStats, computePoints } = require('./apiSports');

// One shared snapshot of every NFL game in progress. Users read this; only the server calls the API,
// so the number of people watching never changes our API usage.
const cache = { at: 0, games: [], inflight: null };

async function fetchLive() {
  const data = await call('/games', { live: 'all' });
  const rows = (data.response || []).filter(x => String(x.league?.id) === String(NFL_LEAGUE_ID));

  const games = [];
  for (const x of rows) {
    const id = x.game?.id;
    let raw = [];
    try { raw = await getGamePlayerStats(id); } catch (e) { console.error(`[live] stats ${id}:`, e.message); }
    const lines = raw.length ? parseGroupedStats(raw) : new Map();

    const players = new Map();
    for (const [apiPid, line] of lines.entries()) {
      players.set(apiPid, { apiPid, name: line.name, team: line.team, points: computePoints(line), line });
    }
    games.push({
      apiGameId: String(id),
      status: { short: x.game?.status?.short || '', long: x.game?.status?.long || '', timer: x.game?.status?.timer ?? null },
      stage: x.game?.stage || '', week: x.game?.week || '',
      home: { name: x.teams?.home?.name, logo: x.teams?.home?.logo, score: x.scores?.home?.total ?? 0 },
      away: { name: x.teams?.away?.name, logo: x.teams?.away?.logo, score: x.scores?.away?.total ?? 0 },
      players,
      raw,
    });
  }
  cache.games = games;
  cache.at = Date.now();
  return cache;
}

// Returns the snapshot, refreshing it if older than maxAgeMs (concurrent callers share one fetch)
async function getLive({ maxAgeMs = 20000 } = {}) {
  if (Date.now() - cache.at <= maxAgeMs && cache.at) return cache;
  if (!cache.inflight) cache.inflight = fetchLive().finally(() => { cache.inflight = null; });
  try {
    return await cache.inflight;
  } catch (e) {
    if (cache.at) return cache; // serve the last good snapshot if the API hiccups
    throw e;
  }
}

module.exports = { getLive };
