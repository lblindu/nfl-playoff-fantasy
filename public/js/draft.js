/* ============================================================
   NFL Playoff Fantasy — Draft Room
   Real-time snake draft via Supabase Realtime
   ============================================================ */

import { getSupabase, api, getSession, getMe, loadMe, isAdmin, toast, navigate, fmt } from './app.js';

// Identify the user from the login session so a failed /api/me can't turn a member into a spectator
function myUserId() {
  return getMe()?.id || getSession()?.user?.id;
}

// The league's commissioner (or a site admin) runs the draft: undo, reset, pick for a no-show
function isManager() {
  return isAdmin() || (!!draftState && draftState.league?.created_by === myUserId());
}

let leagueId = null;
let draftState = null;
let channel = null;
let playerList = [];
let filterPos = 'ALL';
let filterTeam = '';
let filterSearch = '';

// ── Entry point ──
export async function initDraft(params) {
  leagueId = params.leagueId;
  if (!getMe()) await loadMe();
  document.getElementById('app').innerHTML = renderShell();
  await loadDraft();
  subscribeRealtime();
  bindEvents();
}

// ── Load draft state ──
async function loadDraft() {
  try {
    draftState = await api('GET', `/draft/${leagueId}`);
    const [season] = [draftState.league.season];
    playerList = await api('GET', `/players?season=${season}&leagueId=${leagueId}`);
    renderAll();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ── Supabase Realtime ──
function subscribeRealtime() {
  if (channel) channel.unsubscribe();

  channel = getSupabase()
    .channel(`draft:${leagueId}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'draft_picks',
      filter: `league_id=eq.${leagueId}`,
    }, async () => {
      await loadDraft();
    })
    .subscribe();
}

// ── Make a pick ──
async function makePick(playerId) {
  const myMemberId = draftState.members.find(m => m.user_id === myUserId())?.id;
  if (!myMemberId && !isManager()) return;
  if (draftState.onTheClock?.id !== myMemberId && !isManager()) {
    toast('Not your turn', 'error');
    return;
  }

  const memberId = isManager() && draftState.onTheClock
    ? draftState.onTheClock.id
    : myMemberId;

  try {
    await api('POST', `/draft/${leagueId}/pick`, { playerId, memberId });
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ── Who can pick right now, and for whom ──
function getPickingState() {
  const myMember = draftState.members.find(m => m.user_id === myUserId());
  const onClock = draftState.onTheClock;
  const canPick = !draftState.isDone && !!onClock && ((myMember && onClock.id === myMember.id) || isManager());
  // Roster rules (one per team, QB cap) apply to whoever the pick is for
  return { myMember, canPick, member: canPick ? onClock : myMember };
}

function teamIdsOf(member) {
  return new Set(
    draftState.picks
      .filter(p => p.member_id === member?.id)
      .map(p => p.players?.nfl_teams?.id)
      .filter(Boolean)
  );
}

async function resetDraft() {
  if (!confirm('Delete ALL picks in this league and start the draft over?')) return;
  try {
    await api('DELETE', `/draft/${leagueId}/reset`);
    toast('Draft reset');
    await loadDraft();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ── Undo last pick (admin) ──
async function undoPick() {
  if (!confirm('Undo the last pick?')) return;
  try {
    await api('DELETE', `/draft/${leagueId}/undo`);
    toast('Pick undone');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ── Render ──
function renderShell() {
  return `
    <nav class="navbar">
      <a class="navbar-brand" href="/" data-link>
        <div class="navbar-logo">🏈</div>
        <span class="navbar-title">Playoff <span>Fantasy</span></span>
      </a>
      <div class="navbar-right">
        <span id="draft-status-pill"></span>
        <span class="nav-link" id="nav-user">${(getMe()?.email || getSession()?.user?.email || '').split('@')[0]}</span>
        <button class="btn btn-ghost btn-sm" onclick="app.signOut()">Sign out</button>
      </div>
    </nav>

    <div style="display:grid;grid-template-columns:1fr 340px;height:calc(100vh - 56px);overflow:hidden;" id="draft-layout">
      <!-- Left: players + pick board -->
      <div style="display:flex;flex-direction:column;overflow:hidden;border-right:1px solid var(--border);">
        <!-- Clock + filter bar -->
        <div style="padding:1rem 1.25rem;border-bottom:1px solid var(--border);flex-shrink:0;">
          <div id="on-clock-banner"></div>
          <div class="flex items-center gap-2 mt-2" style="flex-wrap:wrap;">
            <input type="text" id="search-player" placeholder="Search players…" style="max-width:200px;height:32px;" />
            <div class="flex gap-1" id="pos-filters"></div>
            <select id="team-filter" style="height:32px;width:auto;">
              <option value="">All teams</option>
            </select>
            <span id="manager-btns" class="flex gap-2"></span>
          </div>
          <div id="teams-left" style="margin-top:10px;"></div>
        </div>
        <!-- Player list -->
        <div id="player-list" style="overflow-y:auto;flex:1;padding:0.75rem;"></div>
      </div>

      <!-- Right: draft board -->
      <div style="overflow-y:auto;padding:1rem;">
        <h3 class="mb-2">Draft Board</h3>
        <div id="draft-board"></div>
      </div>
    </div>
  `;
}

function renderAll() {
  renderClock();
  renderPlayerList();
  renderDraftBoard();
  renderPosFilters();
  renderTeamFilter();
  renderTeamsLeft();
  updateStatusPill();
  const mb = document.getElementById('manager-btns');
  if (mb) {
    mb.innerHTML = isManager()
      ? `<button class="btn btn-danger btn-sm" id="undo-btn">↩ Undo pick</button><button class="btn btn-danger btn-sm" id="reset-btn">Reset draft</button>`
      : '';
  }
}

function renderTeamsLeft() {
  const el = document.getElementById('teams-left');
  if (!el) return;
  const { member } = getPickingState();
  if (!member || draftState.isDone) { el.innerHTML = ''; return; }

  const teams = [...new Map(playerList.map(p => [p.nfl_teams?.id, p.nfl_teams])).values()].filter(Boolean);
  teams.sort((a, b) => a.abbr.localeCompare(b.abbr));
  const taken = teamIdsOf(member);
  const left = teams.filter(t => !taken.has(t.id));

  el.innerHTML = `
    <div style="font-size:11px;color:var(--text-3);margin-bottom:4px;">
      Teams left for <b style="color:var(--text-2)">${member.display_name}</b>: ${left.length} of ${teams.length}
      ${filterTeam ? ' · <a href="#" data-clear-team style="color:var(--gold);">show all</a>' : ''}
    </div>
    <div class="flex gap-1" style="flex-wrap:wrap;">
      ${teams.map(t => {
        const done = taken.has(t.id);
        const active = filterTeam === t.id;
        return `<button class="btn btn-sm ${active ? 'btn-primary' : 'btn-ghost'}" data-team-chip="${t.id}" ${done ? 'disabled' : ''}
          style="height:24px;padding:0 8px;font-size:11px;${done ? 'opacity:.35;text-decoration:line-through;' : ''}">${t.abbr}</button>`;
      }).join('')}
    </div>`;
}

function renderClock() {
  const el = document.getElementById('on-clock-banner');
  if (!el) return;
  const { onTheClock, isDone, picks, totalPicks } = draftState;
  const myMember = draftState.members.find(m => m.user_id === myUserId());
  const pickNum = picks.length + 1;

  if (isDone) {
    el.innerHTML = `<div class="flex items-center gap-2"><span class="pill pill-complete">Draft Complete</span><span style="color:var(--text-2);font-size:13px;">${picks.length}/${totalPicks} picks made</span></div>`;
    return;
  }

  const isMyTurn = onTheClock && myMember && onTheClock.id === myMember.id;
  const name = onTheClock?.display_name || '?';
  const round = Math.ceil(pickNum / draftState.members.length);

  // How many picks until my next turn (snake order)
  let upIn = '';
  if (myMember && !isMyTurn) {
    const n = draftState.members.length;
    const order = [...draftState.members].sort((a, b) => a.draft_order - b.draft_order);
    for (let k = picks.length; k < totalPicks; k++) {
      const idx = Math.floor(k / n) % 2 === 0 ? k % n : n - 1 - (k % n);
      if (order[idx]?.id === myMember.id) {
        const d = k - picks.length;
        upIn = `You're up in ${d} pick${d === 1 ? '' : 's'}`;
        break;
      }
    }
  }

  el.innerHTML = `
    <div class="flex items-center gap-2" style="flex-wrap:wrap;">
      <span class="pill pill-live"><span class="pill-dot pulse"></span>Pick ${pickNum} · Round ${round}</span>
      <span style="font-size:14px;font-weight:600;color:${isMyTurn ? 'var(--gold)' : 'var(--text)'}">
        ${isMyTurn ? '⭐ Your pick!' : `On the clock: ${name}`}
      </span>
      ${upIn ? `<span style="font-size:12px;color:var(--text-2);">${upIn}</span>` : ''}
      ${!isMyTurn && isManager() ? `<span style="font-size:12px;color:var(--gold);">Commissioner: you're drafting for ${name}</span>` : ''}
      <span style="font-size:12px;color:var(--text-3)">${picks.length}/${totalPicks}</span>
    </div>
  `;
}

function renderPosFilters() {
  const el = document.getElementById('pos-filters');
  if (!el) return;
  const positions = ['ALL', 'QB', 'RB', 'WR', 'TE'];
  el.innerHTML = positions.map(p => `
    <button class="btn btn-sm ${filterPos === p ? 'btn-primary' : 'btn-ghost'}" data-pos="${p}">${p}</button>
  `).join('');
}

function renderTeamFilter() {
  const el = document.getElementById('team-filter');
  if (!el) return;
  const teams = [...new Map(playerList.map(p => [p.nfl_teams?.id, p.nfl_teams])).values()].filter(Boolean);
  teams.sort((a, b) => a.abbr.localeCompare(b.abbr));
  el.innerHTML = `<option value="">All teams</option>` +
    teams.map(t => `<option value="${t.id}">${t.abbr}</option>`).join('');
  if (filterTeam) el.value = filterTeam;
}

function renderPlayerList() {
  const el = document.getElementById('player-list');
  if (!el) return;

  const { canPick, member, myMember } = getPickingState();

  if (draftState.isDone) {
    const mine = draftState.picks.filter(p => p.member_id === myMember?.id);
    const pts = mine.reduce((sum, p) => sum + Number(playerList.find(x => x.id === p.players?.id)?.reg_season_points || 0), 0);
    el.innerHTML = `
      <div class="empty-state" style="padding:3rem 1rem;">
        <div class="icon">🏆</div>
        <h2 style="margin:8px 0 4px;">${myMember ? 'Your roster is locked in!' : 'The draft is complete!'}</h2>
        <p style="max-width:420px;margin:0 auto;">
          ${myMember
            ? `You drafted ${mine.length} players, one from every playoff team${pts ? `, worth ${fmt(pts)} regular-season points` : ''}. Scoring starts with the first playoff game.`
            : 'Every roster is set. Scoring starts with the first playoff game.'}
        </p>
        <a href="/league/${leagueId}" data-link class="btn btn-primary" style="margin-top:1.25rem;">View league standings →</a>
      </div>`;
    return;
  }

  const takenTeams = teamIdsOf(member);

  // QBs already on the roster the pick is for
  const myQbCount = draftState.picks
    .filter(p => p.member_id === member?.id && p.players?.position === 'QB').length;

  // Drafted players are gone for everyone; teams already on this roster are hidden
  let filtered = playerList.filter(p => !p.drafted && !takenTeams.has(p.nfl_teams?.id));
  if (filterPos !== 'ALL') filtered = filtered.filter(p => p.position === filterPos);
  if (filterTeam) filtered = filtered.filter(p => p.nfl_teams?.id === filterTeam);
  if (filterSearch) {
    const q = filterSearch.toLowerCase();
    filtered = filtered.filter(p => p.name.toLowerCase().includes(q));
  }

  if (!filtered.length) {
    el.innerHTML = `<div class="empty-state"><div class="icon">🔍</div><p>No players match your filter</p></div>`;
    return;
  }

  el.innerHTML = filtered.map(p => {
    const team = p.nfl_teams;
    const isQbLimit = p.position === 'QB' && myQbCount >= 2;
    const disabled = !canPick || isQbLimit;
    const color = team?.primary_color || '#555';
    return `
      <div class="draft-pick" style="margin-bottom:6px;">
        <div style="width:4px;height:40px;background:${color};border-radius:2px;flex-shrink:0;"></div>
        <div class="player-avatar player-avatar-sm">${p.name[0]}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.name}</div>
          <div class="flex items-center gap-1" style="margin-top:2px;">
            <span class="${posClass(p.position)}">${p.position}</span>
            ${team ? `<span style="font-size:11px;color:var(--text-3);">${team.abbr}</span>` : ''}
            ${team?.is_eliminated ? '<span style="font-size:10px;color:var(--red);">ELIM</span>' : ''}
            ${p.overall_rank ? `<span style="font-size:11px;color:var(--text-3);">#${p.overall_rank} overall · ${p.position}${p.pos_rank}</span>` : ''}
          </div>
        </div>
        ${p.reg_season_points != null ? `<div style="text-align:right;min-width:44px;"><div style="font-size:13px;font-weight:600;color:var(--text);">${fmt(p.reg_season_points)}</div><div style="font-size:9px;color:var(--text-3);">REG PTS</div></div>` : ''}
        <button class="btn btn-sm ${canPick ? 'btn-primary' : 'btn-ghost'}" ${disabled ? 'disabled' : ''} data-pick="${p.id}" title="${!canPick ? 'Wait for your turn' : isQbLimit ? 'QB limit reached (2 max)' : ''}">
          ${!canPick ? 'Wait' : isQbLimit ? 'QB max' : 'Draft'}
        </button>
      </div>
    `;
  }).join('');
}

function renderDraftBoard() {
  const el = document.getElementById('draft-board');
  if (!el) return;
  const { picks, members, totalPicks } = draftState;
  if (!members.length) { el.innerHTML = '<p style="color:var(--text-3);font-size:13px;">No members yet</p>'; return; }

  const sortedMembers = [...members].sort((a, b) => a.draft_order - b.draft_order);
  const numTeams = sortedMembers.length;
  const picksByNum = new Map(picks.map(p => [p.pick_number, p]));

  el.innerHTML = sortedMembers.map(m => {
    const myPicks = picks.filter(p => p.member_id === m.id).sort((a, b) => a.pick_number - b.pick_number);
    const isMe = m.user_id === myUserId();
    return `
      <div style="margin-bottom:1rem;">
        <div class="flex items-center gap-2 mb-1">
          <span style="font-size:12px;font-weight:600;color:${isMe ? 'var(--gold)' : 'var(--text)'}">${m.display_name}${isMe ? ' (you)' : ''}</span>
          <span style="font-size:11px;color:var(--text-3);">${myPicks.length}/14</span>
        </div>
        ${myPicks.map(p => {
          const player = p.players;
          const team = player?.nfl_teams;
          return `
            <div style="display:flex;align-items:center;gap:8px;padding:5px 8px;background:var(--bg-raised);border-radius:var(--radius-sm);margin-bottom:4px;border:1px solid var(--border);">
              <span style="font-size:10px;color:var(--text-3);font-family:var(--font-mono);min-width:24px;">#${p.pick_number}</span>
              ${team ? `<span style="font-size:10px;font-weight:600;color:var(--text-2);">${team.abbr}</span>` : ''}
              <span class="pos pos-${player?.position}" style="font-size:9px;">${player?.position}</span>
              <span style="font-size:12px;color:var(--text);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${player?.name}</span>
            </div>
          `;
        }).join('')}
        ${myPicks.length < 14 && draftState.onTheClock?.id === m.id
          ? `<div style="padding:5px 8px;border:1px dashed var(--gold-border);border-radius:var(--radius-sm);font-size:11px;color:var(--gold);">On the clock…</div>`
          : ''}
      </div>
    `;
  }).join('');
}

function updateStatusPill() {
  const el = document.getElementById('draft-status-pill');
  if (!el) return;
  const { isDone } = draftState;
  el.innerHTML = isDone
    ? '<span class="pill pill-complete">Complete</span>'
    : '<span class="pill pill-live"><span class="pill-dot pulse"></span>Live Draft</span>';
}

function posClass(pos) {
  return `pos pos-${pos}`;
}

// ── Event wiring ──
let eventsBound = false;
function bindEvents() {
  if (eventsBound) return;
  eventsBound = true;
  const app = document.getElementById('app');

  app.addEventListener('click', e => {
    // Pick button
    const pickBtn = e.target.closest('[data-pick]');
    if (pickBtn && !pickBtn.disabled) {
      makePick(pickBtn.dataset.pick);
      return;
    }
    // Team chip filter
    const chip = e.target.closest('[data-team-chip]');
    if (chip && !chip.disabled) {
      filterTeam = filterTeam === chip.dataset.teamChip ? '' : chip.dataset.teamChip;
      renderPlayerList();
      renderTeamFilter();
      renderTeamsLeft();
      return;
    }
    if (e.target.closest('[data-clear-team]')) {
      e.preventDefault();
      filterTeam = '';
      renderPlayerList();
      renderTeamFilter();
      renderTeamsLeft();
      return;
    }
    // Pos filter
    const posBtn = e.target.closest('[data-pos]');
    if (posBtn) {
      filterPos = posBtn.dataset.pos;
      renderPlayerList();
      renderPosFilters();
      return;
    }
    // Undo
    if (e.target.id === 'undo-btn') {
      undoPick();
      return;
    }
    if (e.target.id === 'reset-btn') {
      resetDraft();
      return;
    }
  });

  app.addEventListener('input', e => {
    if (e.target.id === 'search-player') {
      filterSearch = e.target.value.trim();
      renderPlayerList();
    }
    if (e.target.id === 'team-filter') {
      filterTeam = e.target.value;
      renderPlayerList();
      renderTeamsLeft();
    }
  });
}

// Cleanup on navigation away
export function destroyDraft() {
  if (channel) { channel.unsubscribe(); channel = null; }
}
