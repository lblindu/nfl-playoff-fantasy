/* ============================================================
   Themes — the dark base never changes; only the accent does.
   A theme id is 'classic' (the original gold), 'nfl', or a team abbreviation.
   ============================================================ */

// [abbr, name, accent]. Accents are bright variants of each team's colors; applyTheme
// still lightens any that would be hard to read on the dark background.
export const TEAMS = [
  ['ARI', 'Arizona Cardinals', '#C9304F'],
  ['ATL', 'Atlanta Falcons', '#D9304A'],
  ['BAL', 'Baltimore Ravens', '#7C5CE0'],
  ['BUF', 'Buffalo Bills', '#2F7BFF'],
  ['CAR', 'Carolina Panthers', '#1AA3E6'],
  ['CHI', 'Chicago Bears', '#F0580F'],
  ['CIN', 'Cincinnati Bengals', '#FB5A1A'],
  ['CLE', 'Cleveland Browns', '#FF5A1F'],
  ['DAL', 'Dallas Cowboys', '#4F83E0'],
  ['DEN', 'Denver Broncos', '#FF6A1A'],
  ['DET', 'Detroit Lions', '#1C9BE0'],
  ['GB', 'Green Bay Packers', '#3FAE68'],
  ['HOU', 'Houston Texans', '#E0344A'],
  ['IND', 'Indianapolis Colts', '#3B82F6'],
  ['JAX', 'Jacksonville Jaguars', '#00B4C6'],
  ['KC', 'Kansas City Chiefs', '#F03A52'],
  ['LV', 'Las Vegas Raiders', '#B9C0C4'],
  ['LAC', 'Los Angeles Chargers', '#1AA0E8'],
  ['LA', 'Los Angeles Rams', '#4A80F0'],
  ['MIA', 'Miami Dolphins', '#00B8C4'],
  ['MIN', 'Minnesota Vikings', '#8B5CD6'],
  ['NE', 'New England Patriots', '#4C7FD6'],
  ['NO', 'New Orleans Saints', '#D8BE86'],
  ['NYG', 'New York Giants', '#3B6FE0'],
  ['NYJ', 'New York Jets', '#2FAE6F'],
  ['PHI', 'Philadelphia Eagles', '#19A89A'],
  ['PIT', 'Pittsburgh Steelers', '#FFB612'],
  ['SF', 'San Francisco 49ers', '#D82B2B'],
  ['SEA', 'Seattle Seahawks', '#69BE28'],
  ['TB', 'Tampa Bay Buccaneers', '#E5322D'],
  ['TEN', 'Tennessee Titans', '#4B92DB'],
  ['WAS', 'Washington Commanders', '#C8454F'],
].map(([id, name, accent]) => ({ id, name, accent }));

export const GENERAL_THEMES = [
  { id: 'classic', name: 'Classic gold', accent: '#f5a623' },
  { id: 'nfl', name: 'NFL colors', accent: '#E3342F' },
];

export const findTheme = id => [...GENERAL_THEMES, ...TEAMS].find(t => t.id === id);

const BG = [9, 9, 15];
const hexToRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const rgbToHex = c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
const mix = (c, to, t) => c.map((v, i) => Math.round(v + (to[i] - v) * t));

function luminance([r, g, b]) {
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Lighten until the accent reads as text on the dark background (WCAG AA, 4.5:1)
function readable(rgb) {
  let c = rgb;
  for (let t = 0.05; contrast(c, BG) < 4.5 && t <= 1; t += 0.05) c = mix(rgb, [255, 255, 255], t);
  return c;
}

const PROPS = ['--gold', '--gold-rgb', '--gold-dim', '--gold-border', '--gold-hover', '--gold-deep', '--on-gold'];

// Applies a theme to the page and caches it so the next load has no flash of the old colors
export function applyTheme(id) {
  const root = document.documentElement;
  const theme = findTheme(id);

  if (!theme || theme.id === 'classic') {
    PROPS.forEach(p => root.style.removeProperty(p));
    try { localStorage.removeItem('themeVars'); } catch { /* storage unavailable */ }
    return;
  }

  const accent = readable(hexToRgb(theme.accent));
  const rgb = accent.join(',');
  const vars = {
    '--gold': rgbToHex(accent),
    '--gold-rgb': rgb,
    '--gold-dim': `rgba(${rgb},0.15)`,
    '--gold-border': `rgba(${rgb},0.35)`,
    '--gold-hover': rgbToHex(mix(accent, [0, 0, 0], 0.12)),
    '--gold-deep': rgbToHex(mix(accent, [0, 0, 0], 0.25)),
    '--on-gold': contrast(accent, [0, 0, 0]) >= contrast(accent, [255, 255, 255]) ? '#000000' : '#ffffff',
  };
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  try { localStorage.setItem('themeVars', JSON.stringify(vars)); } catch { /* storage unavailable */ }
}
