/* Theme picker modal — live preview, saved to the user's account metadata */
import { getSupabase, getSession, toast } from './app.js';
import { TEAMS, GENERAL_THEMES, applyTheme } from './theme.js';

const currentTheme = () => getSession()?.user?.user_metadata?.theme;

function ensureStyles() {
  if (document.getElementById('theme-picker-css')) return;
  const s = document.createElement('style');
  s.id = 'theme-picker-css';
  s.textContent = `
    .tp-back{position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px}
    .tp-box{background:var(--bg-2,#14141c);border:1px solid var(--border,#2a2a38);border-radius:16px;max-width:560px;width:100%;max-height:90vh;overflow:auto;padding:20px}
    .tp-box h2{margin:0 0 4px;font-size:18px}
    .tp-sub{color:var(--text-2,#999);font-size:13px;margin-bottom:14px}
    .tp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
    .tp-opt{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;border:1px solid var(--border,#2a2a38);background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer;text-align:left}
    .tp-opt:hover{border-color:var(--gold-border)}
    .tp-opt.sel{border-color:var(--gold);background:var(--gold-dim)}
    .tp-dot{width:16px;height:16px;border-radius:50%;flex:none}
    .tp-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
  `;
  document.head.appendChild(s);
}

export function openThemePicker({ firstRun = false } = {}) {
  ensureStyles();
  const original = currentTheme();
  let chosen = original && original !== 'classic' ? original : (original === 'classic' ? 'classic' : 'nfl');
  const all = [...GENERAL_THEMES, ...TEAMS];

  const back = document.createElement('div');
  back.className = 'tp-back';
  back.innerHTML = `
    <div class="tp-box">
      <h2>${firstRun ? 'Pick your team' : 'Theme'}</h2>
      <div class="tp-sub">Choose your favorite team's colors, or stay with NFL colors / classic gold.</div>
      <div class="tp-grid">
        ${all.map(t => `<button class="tp-opt" data-id="${t.id}"><span class="tp-dot" style="background:${t.accent}"></span>${t.name}</button>`).join('')}
      </div>
      <div class="tp-actions">
        <button class="btn btn-ghost" id="tp-cancel">${firstRun ? 'Skip' : 'Cancel'}</button>
        <button class="btn btn-primary" id="tp-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(back);

  const mark = () => back.querySelectorAll('.tp-opt').forEach(b => b.classList.toggle('sel', b.dataset.id === chosen));
  mark();

  back.querySelectorAll('.tp-opt').forEach(b => b.addEventListener('click', () => {
    chosen = b.dataset.id;
    applyTheme(chosen); // live preview
    mark();
  }));

  const close = () => back.remove();
  const save = async id => {
    const { error } = await getSupabase().auth.updateUser({ data: { theme: id } });
    if (error) { toast(error.message, 'error'); return false; }
    return true;
  };

  back.querySelector('#tp-cancel').addEventListener('click', async () => {
    if (firstRun) {
      applyTheme('classic');
      await save('classic'); // remember the skip so we don't ask again
    } else {
      applyTheme(original);
    }
    close();
  });
  back.querySelector('#tp-save').addEventListener('click', async () => {
    if (await save(chosen)) { applyTheme(chosen); close(); }
  });
}

// Ask once if the account has never chosen a theme (Google sign-ups, existing users)
export function maybeAskTheme() {
  if (getSession() && currentTheme() === undefined) openThemePicker({ firstRun: true });
}
