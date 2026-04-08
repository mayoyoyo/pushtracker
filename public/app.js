let currentUser = null;
let currentScreen = 'loading';

let poseModule = null;
async function loadPose() {
  if (!poseModule) poseModule = await import('/pose.js');
  return poseModule;
}

function playCongratsSound() {
  function tone(freq, dur, delay) {
    setTimeout(() => {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.frequency.value = freq; gain.gain.value = 0.3;
      osc.connect(gain); gain.connect(ctx.destination); osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
      osc.stop(ctx.currentTime + dur);
    }, delay);
  }
  tone(523, 0.15, 0); tone(659, 0.15, 180); tone(784, 0.2, 360);
}

async function api(method, path, body) {
  const opts = { method, headers: { 'content-type': 'application/json' }, credentials: 'same-origin' };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function showToast(msg, duration = 3000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), duration);
}

let lucideReady = false;
function initIcons() { if (lucideReady) lucide.createIcons(); }
document.addEventListener('DOMContentLoaded', () => {
  const s = document.querySelector('script[src*="lucide"]');
  if (s) s.addEventListener('load', () => { lucideReady = true; initIcons(); });
  if (window.lucide) { lucideReady = true; initIcons(); }
});

function streakIcons(last5days) {
  if (!last5days || !last5days.length) return '';
  return last5days.map(d => {
    if (!d.met) return '🧊';
    return d.mode === 'standard' ? '<img src="/opm-fist.png" style="width:22px;height:22px;vertical-align:middle">' : '🔥';
  }).join('');
}

function streakText(streak) {
  if (!streak || streak.count === 0 || streak.type !== 'hot') return '';
  return `${streak.count} day streak 🔥`;
}

function showScreen(name, data) {
  currentScreen = name;
  const app = document.getElementById('app');
  switch (name) {
    case 'auth': renderAuth(app); break;
    case 'dashboard': renderDashboard(app, data); break;
    case 'camera': renderCamera(app); break;
    default: app.innerHTML = '<p>Loading...</p>';
  }
  initIcons();
}

function renderAuth(app) {
  let mode = 'login';

  function render() {
    app.innerHTML = `
      <div class="auth-screen">
        <div class="logo">PushTracker</div>
        <div class="subtitle">Hold each other accountable</div>
        <form class="auth-form" id="auth-form">
          <div class="input-group">
            <label>Username</label>
            <input type="text" id="auth-username" autocomplete="username" autocapitalize="none" required>
          </div>
          <div class="input-group" ${mode === 'login' ? 'style="display:none"' : ''}>
            <label>Invite Code</label>
            <input type="text" id="auth-invite" autocapitalize="characters" placeholder="Enter invite code" style="text-transform:uppercase">
          </div>
          <div class="input-group">
            <label>4-Digit Passcode</label>
            <div class="passcode-boxes">
              <input type="number" inputmode="numeric" maxlength="1" class="pin" data-idx="0">
              <input type="number" inputmode="numeric" maxlength="1" class="pin" data-idx="1">
              <input type="number" inputmode="numeric" maxlength="1" class="pin" data-idx="2">
              <input type="number" inputmode="numeric" maxlength="1" class="pin" data-idx="3">
            </div>
          </div>
          <div class="error-msg" id="auth-error"></div>
          <button type="submit" class="btn btn-primary">${mode === 'login' ? 'Log In' : 'Sign Up'}</button>
        </form>
        <div class="auth-toggle">
          ${mode === 'login'
            ? 'New here? <a id="toggle-auth">Sign up</a>'
            : 'Have an account? <a id="toggle-auth">Log in</a>'}
        </div>
      </div>
    `;

    const pins = app.querySelectorAll('.pin');
    pins.forEach((pin, i) => {
      pin.addEventListener('input', () => {
        pin.value = pin.value.slice(-1);
        if (pin.value && i < 3) pins[i + 1].focus();
      });
      pin.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !pin.value && i > 0) pins[i - 1].focus();
      });
    });

    app.querySelector('#toggle-auth').addEventListener('click', () => {
      mode = mode === 'login' ? 'signup' : 'login';
      render();
    });

    app.querySelector('#auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = app.querySelector('#auth-username').value.trim();
      const passcode = Array.from(pins).map(p => p.value).join('');
      const errEl = app.querySelector('#auth-error');

      if (passcode.length !== 4) {
        errEl.textContent = 'Enter a 4-digit passcode';
        return;
      }

      try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (mode === 'signup') {
          const inviteCode = app.querySelector('#auth-invite').value.trim();
          if (!inviteCode) { errEl.textContent = 'Enter an invite code'; return; }
          const data = await api('POST', '/api/auth/signup', { username, passcode, timezone: tz, inviteCode });
          currentUser = data.user;
        } else {
          const data = await api('POST', '/api/auth/login', { username, passcode });
          currentUser = data.user;
        }
        await checkTimezone();
        await loadDashboard();
      } catch (err) {
        errEl.textContent = err.message;
      }
    });
  }

  render();
}

async function checkTimezone() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (currentUser && currentUser.timezone !== tz) {
    const res = await api('PUT', '/api/me/timezone', { timezone: tz });
    if (res.changed) {
      currentUser.timezone = tz;
      showToast('We noticed you changed time zones \u2014 your daily reset has been updated.');
    }
  }
}

async function loadDashboard() {
  const data = await api('GET', '/api/me');
  currentUser = { ...currentUser, ...data };
  showScreen('dashboard', data);
}

async function renderCalendar(container, userData) {
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth() + 1;

  async function render() {
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const resp = await api('GET', `/api/me/calendar?year=${year}&month=${month}`);
    const dayMap = {};
    (resp.days || []).forEach(d => { dayMap[d.day] = d; });

    const firstDay = new Date(year, month - 1, 1).getDay();
    const daysInMonth = new Date(year, month, 0).getDate();
    const today = now.getDate();
    const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;

    let gridHtml = '';
    // Empty cells for offset
    for (let i = 0; i < firstDay; i++) gridHtml += '<div class="cal-cell"></div>';
    for (let d = 1; d <= daysInMonth; d++) {
      const isToday = isCurrentMonth && d === today;
      const entry = dayMap[d];
      let icon = '';
      if (entry) {
        if (entry.met) {
          icon = entry.mode === 'standard' ? '<img src="/opm-fist.png" style="width:14px;height:14px">' : '🔥';
        }
      }
      const todayStyle = isToday ? 'border:2px solid #ef4444;border-radius:50%;' : '';
      gridHtml += `<div class="cal-cell" style="${todayStyle}"><div style="font-size:11px;color:var(--text-muted)">${d}</div><div style="font-size:12px;line-height:1">${icon}</div></div>`;
    }

    container.innerHTML = `
      <div style="border:1px solid var(--border);border-radius:12px;padding:16px;margin-top:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <button class="cal-nav" id="cal-prev" style="background:none;border:1px solid var(--border);border-radius:6px;color:var(--text);cursor:pointer;padding:4px 8px;font-size:14px">&larr;</button>
          <div style="font-weight:600;font-size:14px">${monthNames[month-1]} ${year}</div>
          <button class="cal-nav" id="cal-next" style="background:none;border:1px solid var(--border);border-radius:6px;color:var(--text);cursor:pointer;padding:4px 8px;font-size:14px">&rarr;</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(7,1fr);text-align:center;gap:2px">
          ${'SMTWTFS'.split('').map(d => `<div style="font-size:10px;color:var(--text-muted);padding:4px 0">${d}</div>`).join('')}
          ${gridHtml}
        </div>
      </div>
    `;

    const created = new Date(userData.created_at ? userData.created_at.replace(' ', 'T') + 'Z' : now);
    const minYear = created.getFullYear();
    const minMonth = created.getMonth() + 1;

    container.querySelector('#cal-prev').addEventListener('click', () => {
      let prevM = month - 1, prevY = year;
      if (prevM < 1) { prevM = 12; prevY--; }
      if (prevY < minYear || (prevY === minYear && prevM < minMonth)) return;
      month = prevM; year = prevY;
      render();
    });
    container.querySelector('#cal-next').addEventListener('click', () => {
      let nextM = month + 1, nextY = year;
      if (nextM > 12) { nextM = 1; nextY++; }
      if (nextY > now.getFullYear() || (nextY === now.getFullYear() && nextM > now.getMonth() + 1)) return;
      month = nextM; year = nextY;
      render();
    });
  }

  await render();
}

function renderDashboard(app, data) {
  let activeTab = 'me';

  function renderTab() {
    if (activeTab === 'me') renderMeTab();
    else renderTeamTab();
  }

  function tabHeader() {
    return `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">
        <div style="flex:1"></div>
        <div style="text-align:center">
          <div style="font-size:18px;font-weight:700">${data.group_name || 'Push-up Challenge'}</div>
          ${data.group_name ? '<div style="font-size:12px;color:var(--text-dim)">Push-up Challenge</div>' : ''}
        </div>
        <div style="flex:1;display:flex;justify-content:flex-end">
          <button class="settings-btn" id="settings-btn"><i data-lucide="settings" style="width:18px;height:18px"></i></button>
        </div>
      </div>
      <div style="display:flex;justify-content:center;margin-bottom:16px">
        <div style="display:inline-flex;background:var(--surface-2);border-radius:8px;overflow:hidden">
          <button id="tab-me" style="padding:8px 24px;border:none;font-size:13px;font-weight:500;cursor:pointer;background:${activeTab === 'me' ? 'var(--primary)' : 'transparent'};color:${activeTab === 'me' ? 'var(--primary-fg)' : 'var(--text)'}">Me</button>
          <button id="tab-team" style="padding:8px 24px;border:none;font-size:13px;font-weight:500;cursor:pointer;background:${activeTab === 'team' ? 'var(--primary)' : 'transparent'};color:${activeTab === 'team' ? 'var(--primary-fg)' : 'var(--text)'}">Team</button>
        </div>
      </div>`;
  }

  function bindTabs() {
    app.querySelector('#tab-me').addEventListener('click', () => { activeTab = 'me'; renderTab(); });
    app.querySelector('#tab-team').addEventListener('click', () => { activeTab = 'team'; renderTab(); });
    app.querySelector('#settings-btn').addEventListener('click', () => showSettings());
  }

  function renderMeTab() {
    const pct = data.daily_target > 0 ? Math.min(100, (data.today_total / data.daily_target) * 100) : 0;
    const done = data.daily_target > 0 && data.today_total >= data.daily_target;

    app.innerHTML = `
      ${tabHeader()}
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <div>
          <div class="greeting-sub">Hey,</div>
          <div class="greeting-name">${data.username}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px">Streak</div>
          <div style="font-size:16px;letter-spacing:1px;display:flex;align-items:center;justify-content:flex-end;gap:4px">${streakIcons(data.last5days)}${data.streak && data.streak.count > 0 && data.streak.type === 'hot' ? `<span style="font-size:11px;color:var(--success);font-weight:600;margin-left:4px">${data.streak.count}d</span>` : ''}</div>
        </div>
      </div>
      <div class="progress-card" style="${done ? 'border-color:#22c55e;box-shadow:0 0 20px rgba(34,197,94,0.15),0 0 60px rgba(34,197,94,0.05)' : ''}">
        <div class="progress-label">${done ? '✓ COMPLETE' : 'Today'}</div>
        <div class="progress-count" style="${done ? 'color:#22c55e' : ''}">${data.today_total} <span class="progress-target">/ ${data.daily_target}</span></div>
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%;${done ? 'background:#22c55e' : ''}"></div></div>
      </div>
      ${data.debt > 0 ? `
      <div class="debt-card">
        <div><div style="font-size:11px;text-transform:uppercase;color:var(--text-dim)">Debt</div><div class="debt-count">${data.debt}</div></div>
        <div class="debt-label">pushups<br>owed</div>
      </div>` : ''}
      <div style="display:flex;gap:10px;margin-top:16px">
        <button class="action-btn primary" id="btn-camera" style="flex:3">
          <span class="icon"><i data-lucide="camera" style="width:22px;height:22px"></i></span><span class="label">Record</span>
        </button>
        <button class="action-btn" id="btn-manual" style="flex:1">
          <span class="icon"><i data-lucide="plus" style="width:22px;height:22px"></i></span><span class="label">Manual</span>
        </button>
      </div>
      <div id="calendar-container"></div>
    `;

    bindTabs();
    app.querySelector('#btn-camera').addEventListener('click', () => showScreen('camera'));
    app.querySelector('#btn-manual').addEventListener('click', () => showManualEntry());
    initIcons();
    renderCalendar(document.getElementById('calendar-container'), data);
  }

  async function renderTeamTab() {
    app.innerHTML = `
      ${tabHeader()}
      <div style="text-align:center;color:var(--text-dim);padding:32px 0">Loading team...</div>
    `;
    bindTabs();
    initIcons();

    try {
      const res = await api('GET', '/api/team/today');
      const team = res.team || res;

      team.sort((a, b) => {
        const aDone = a.daily_target > 0 && a.today_total >= a.daily_target;
        const bDone = b.daily_target > 0 && b.today_total >= b.daily_target;
        if (aDone !== bDone) return aDone ? 1 : -1;
        return a.username.localeCompare(b.username);
      });

      app.innerHTML = `
        ${tabHeader()}
        ${team.map(m => {
          let statusClass = 'not-started';
          let display = `${m.today_total} / ${m.daily_target}`;
          if (m.daily_target > 0 && m.today_total >= m.daily_target) {
            statusClass = 'complete';
            display = `<i data-lucide="check" style="width:16px;height:16px;display:inline"></i> ${m.today_total} / ${m.daily_target}`;
          } else if (m.today_total > 0) {
            statusClass = 'in-progress';
          }
          return `
            <div class="team-member">
              <div>
                <div class="member-name">${m.username} <span style="font-size:14px;letter-spacing:1px">${streakIcons(m.last5days)}</span></div>
                <div class="member-target">Target: ${m.daily_target} <span style="font-size:11px;color:var(--text-dim);margin-left:4px">${streakText(m.streak)}</span></div>
                ${m.debt > 0 ? `<div class="member-debt">Debt: ${m.debt}</div>` : ''}
              </div>
              <div class="member-progress ${statusClass}">${display}</div>
            </div>`;
        }).join('')}
      `;

      bindTabs();
      initIcons();
    } catch (err) {
      app.innerHTML = `
        ${tabHeader()}
        <div style="text-align:center;color:var(--text-dim);padding:32px 0">Failed to load team</div>
      `;
      bindTabs();
      initIcons();
    }
  }

  renderTab();
}

function showManualEntry() {
  let count = 10;
  let editing = false;
  const overlay = document.createElement('div');
  overlay.className = 'manual-entry';
  overlay.innerHTML = `
    <div class="manual-card">
      <h3>Log Pushups</h3>
      <div class="stepper">
        <button id="step-down">\u2212</button>
        <div class="value" id="step-val" style="cursor:pointer">${count}</div>
        <input type="number" id="step-input" inputmode="numeric" style="display:none;width:70px;font-size:36px;font-weight:700;text-align:center;background:transparent;border:1px solid var(--border);border-radius:var(--radius);color:var(--text);outline:none;letter-spacing:-1px" value="${count}">
        <button id="step-up">+</button>
      </div>
      <button class="btn btn-primary" style="width:100%;margin-bottom:10px" id="step-save">Save</button>
      <button class="btn btn-surface" style="width:100%" id="step-cancel">Cancel</button>
    </div>
  `;
  document.body.appendChild(overlay); initIcons();

  const valEl = overlay.querySelector('#step-val');
  const inputEl = overlay.querySelector('#step-input');
  function updateDisplay() { valEl.textContent = count; inputEl.value = count; }

  overlay.querySelector('#step-down').addEventListener('click', () => { count = Math.max(1, count - 1); updateDisplay(); });
  overlay.querySelector('#step-up').addEventListener('click', () => { count += 1; updateDisplay(); });

  valEl.addEventListener('click', () => {
    valEl.style.display = 'none';
    inputEl.style.display = '';
    inputEl.value = count;
    inputEl.focus();
    inputEl.select();
  });
  inputEl.addEventListener('blur', () => {
    const v = parseInt(inputEl.value);
    if (v > 0) count = v;
    inputEl.style.display = 'none';
    valEl.style.display = '';
    updateDisplay();
  });
  inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') inputEl.blur(); });

  overlay.querySelector('#step-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#step-save').addEventListener('click', async () => {
    if (inputEl.style.display !== 'none') { const v = parseInt(inputEl.value); if (v > 0) count = v; }
    await api('POST', '/api/pushups', { count, source: 'manual' });
    overlay.remove();
    showToast(`Logged ${count} pushups`);
    await loadDashboard();
  });
}

function showSettings() {
  const overlay = document.createElement('div');
  overlay.className = 'settings-panel';
  overlay.innerHTML = `
    <div class="settings-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h3 style="margin:0">Settings</h3>
        <button id="set-close" style="background:none;border:none;color:var(--text-dim);cursor:pointer;padding:4px;font-size:18px;line-height:1">&times;</button>
      </div>
      <div class="setting-row">
        <span class="setting-label">Daily Target</span>
        <div class="setting-value"><input type="number" id="set-target" value="${currentUser.daily_target}" min="20" inputmode="numeric"></div>
      </div>
      <div id="target-error" style="display:none;font-size:12px;color:var(--danger);text-align:right;padding:4px 0">Minimum target is 20</div>
      <div class="setting-row">
        <span class="setting-label">Timezone</span>
        <span style="font-size:13px;color:var(--text-dim)">${currentUser.timezone}</span>
      </div>
      <button class="btn btn-primary" style="width:100%;margin-top:16px;margin-bottom:10px" id="set-save">Save</button>
      <button class="btn btn-danger" style="width:100%" id="set-logout">Log Out</button>
    </div>
  `;
  document.body.appendChild(overlay); initIcons();

  overlay.querySelector('#set-save').addEventListener('click', async () => {
    const target = parseInt(overlay.querySelector('#set-target').value) || 0;
    if (target < 20) { document.getElementById('target-error').style.display = ''; return; }
    document.getElementById('target-error').style.display = 'none';
    await api('PUT', '/api/me/target', { target });
    currentUser.daily_target = target;
    overlay.remove();
    showToast('Target updated');
    await loadDashboard();
  });
  overlay.querySelector('#set-logout').addEventListener('click', async () => {
    await api('POST', '/api/auth/logout');
    currentUser = null;
    overlay.remove();
    showScreen('auth');
  });
  overlay.querySelector('#set-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

let cameraMode = 'noob'; // 'noob' or 'standard'

function showTutorial(onStart) {
  const app = document.getElementById('app');
  const isStd = cameraMode === 'standard';
  app.innerHTML = `
    <div class="camera-screen" style="background:var(--bg);overflow-y:auto">
      <div style="padding:24px 20px;max-width:400px;margin:0 auto;position:relative">
        <button id="tut-back" style="position:absolute;top:0;left:0;background:none;border:none;color:var(--text-dim);cursor:pointer;padding:4px"><i data-lucide="arrow-left" style="width:20px;height:20px"></i></button>
        <h2 style="text-align:center;margin-bottom:8px">${isStd ? 'One Punch Mode' : 'Noob Mode'}</h2>
        <div style="display:flex;justify-content:center;margin-bottom:16px">
          <div style="display:inline-flex;background:var(--surface-2);border-radius:8px;overflow:hidden">
            <button id="mode-noob" style="padding:8px 16px;border:none;font-size:13px;font-weight:500;cursor:pointer;background:${!isStd ? 'var(--primary)' : 'transparent'};color:${!isStd ? 'var(--primary-fg)' : 'var(--text)'}">Noob</button>
            <button id="mode-std" style="padding:8px 16px;border:none;font-size:13px;font-weight:500;cursor:pointer;background:${isStd ? 'var(--danger)' : 'transparent'};color:${isStd ? '#fff' : 'var(--text)'}">One Punch</button>
          </div>
        </div>

        ${isStd ? `
        <div style="text-align:center;margin-bottom:16px">
          <img src="/opm-fist.png" style="width:64px;height:64px">
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Streak icon</div>
        </div>
        <div style="text-align:center;margin-bottom:16px">
          <img src="/setup-opm.svg" style="width:100%;max-width:240px">
        </div>
        <div style="border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:20px">
          <div style="font-weight:600;margin-bottom:12px;text-align:center">Setup in 3 steps:</div>
          <div style="display:flex;flex-direction:column;gap:12px;font-size:14px">
            <div style="display:flex;gap:10px;align-items:flex-start"><span style="font-weight:700;color:var(--primary);font-size:18px">1</span><span style="color:var(--text-dim)"><strong style="color:var(--text)">Phone to your side</strong> — prop it 1-2 feet off the ground</span></div>
            <div style="display:flex;gap:10px;align-items:flex-start"><span style="font-weight:700;color:var(--primary);font-size:18px">2</span><span style="color:var(--text-dim)"><strong style="color:var(--text)">Full body in frame</strong> — head to feet, including ankles</span></div>
            <div style="display:flex;gap:10px;align-items:flex-start"><span style="font-weight:700;color:var(--primary);font-size:18px">3</span><span style="color:var(--text-dim)"><strong style="color:var(--text)">Wait for the chime</strong> — green border = ready to go</span></div>
          </div>
        </div>
        <p style="font-size:11px;color:var(--text-muted);line-height:1.5;margin-bottom:20px;padding:0 4px">One Punch Mode uses full-body tracking with stricter form requirements. Some reps may not count if ankles leave the frame or knee angle is too bent. Keep your full body visible for best results.</p>
        ` : `
        <div style="text-align:center;margin-bottom:16px">
          <div style="font-size:48px">🔥</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Streak icon</div>
        </div>
        <div style="text-align:center;margin-bottom:16px">
          <img src="/setup-noob.svg" style="width:100%;max-width:240px">
        </div>
        <div style="border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:20px">
          <div style="font-weight:600;margin-bottom:12px;text-align:center">Setup in 3 steps:</div>
          <div style="display:flex;flex-direction:column;gap:12px;font-size:14px">
            <div style="display:flex;gap:10px;align-items:flex-start"><span style="font-weight:700;color:var(--primary);font-size:18px">1</span><span style="color:var(--text-dim)"><strong style="color:var(--text)">Face the camera</strong> — place phone on the floor in front of you</span></div>
            <div style="display:flex;gap:10px;align-items:flex-start"><span style="font-weight:700;color:var(--primary);font-size:18px">2</span><span style="color:var(--text-dim)"><strong style="color:var(--text)">Show your face + shoulders</strong> — that's all it needs</span></div>
            <div style="display:flex;gap:10px;align-items:flex-start"><span style="font-weight:700;color:var(--primary);font-size:18px">3</span><span style="color:var(--text-dim)"><strong style="color:var(--text)">Wait for the chime</strong> — green border = ready to go</span></div>
          </div>
        </div>
        <p style="font-size:11px;color:var(--text-muted);line-height:1.5;margin-bottom:20px;padding:0 4px">Noob Mode only tracks your upper body — it can't tell if you're on your knees or doing full push-ups. Great for getting started, but it won't catch shortcuts.</p>
        `}

        <button class="btn btn-primary" style="width:100%" id="tut-start">Start Camera</button>
      </div>
    </div>
  `;

  document.getElementById('mode-noob').addEventListener('click', () => { cameraMode = 'noob'; showTutorial(onStart); });
  document.getElementById('mode-std').addEventListener('click', () => { cameraMode = 'standard'; showTutorial(onStart); });
  document.getElementById('tut-start').addEventListener('click', onStart);
  document.getElementById('tut-back').addEventListener('click', () => loadDashboard());
}

async function renderCamera(app) {
  showTutorial(() => startCameraSession());

  async function startCameraSession() {
    let facingMode = cameraMode === 'standard' ? 'environment' : 'user';
    let stream = null;
    let tracker = null;
    const mode = cameraMode;
    const DEV_VIEW = false;
    let sessionStartTime = null;
    let timerInterval = null;

    app.innerHTML = DEV_VIEW ? `
      <div class="camera-screen">
        <div class="camera-feed">
          <video id="cam-video" playsinline autoplay muted style="border:3px solid #fc8181;border-radius:8px"></video>
          <canvas id="cam-canvas"></canvas>
          <div class="tracking-badge hidden" id="cam-tracking">TRACKING</div>
          <div id="depth-bar" style="position:absolute;right:12px;top:50%;transform:translateY(-50%);width:12px;height:40%;background:rgba(0,0,0,0.5);border-radius:6px;overflow:hidden;border:1px solid rgba(255,255,255,0.2)">
            <div id="depth-threshold" style="position:absolute;left:0;right:0;bottom:67%;height:2px;background:#fff;z-index:1"></div>
            <div id="depth-fill" style="position:absolute;bottom:0;left:0;right:0;height:0%;background:#ef4444;transition:height 0.05s,background 0.1s;border-radius:0 0 5px 5px"></div>
          </div>
        </div>
        <div id="cam-debug-panel" style="background:rgba(0,0,0,0.85);padding:8px 12px;font-family:monospace;font-size:11px;line-height:1.6;color:#e2e8f0">
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:4px">
            <span style="color:${mode === 'standard' ? 'var(--danger)' : 'var(--primary)'};font-weight:bold">${mode === 'standard' ? 'STANDARD' : 'NOOB'}</span>
            <span>d1: <strong id="d-f1" style="color:#ecc94b">--</strong></span>
            <span>d2: <strong id="d-f2" style="color:#63b3ed">--</strong></span>
            <span>d3: <strong id="d-f3" style="color:#48bb78">--</strong></span>
            <span>d4: <strong id="d-f4" style="color:#d69e2e">--</strong></span>
          </div>
          <div style="display:flex;gap:12px;align-items:center">
            <span>state: <strong id="d-state" style="color:#48bb78">--</strong></span>
            <span>gate: <strong id="d-gate" style="color:#fc8181">--</strong></span>
            <span>count: <strong id="d-count" style="color:#fff;font-size:14px">0</strong></span>
          </div>
        </div>
        <div class="camera-counter">
          <div class="count" id="cam-count">0</div>
          <div class="count-label">pushups detected</div>
        </div>
        <div class="camera-controls">
          <button class="btn btn-danger" id="cam-stop">Stop &amp; Save</button>
          <button class="btn-flip" id="cam-flip" title="Flip camera"><i data-lucide="refresh-cw" style="width:16px;height:16px"></i></button>
          <button class="btn-flip" id="cam-log" title="Copy debug log">LOG</button>
          <button class="btn-flip" id="cam-help" title="Help">?</button>
        </div>
      </div>
    ` : `
      <div class="camera-screen">
        <div class="camera-feed">
          <video id="cam-video" playsinline autoplay muted style="border:3px solid #fc8181;border-radius:8px"></video>
          <canvas id="cam-canvas"></canvas>
          <div style="position:absolute;top:16px;right:16px;display:flex;gap:8px;align-items:center">
            <div style="background:rgba(0,0,0,0.5);backdrop-filter:blur(8px);border-radius:20px;padding:6px 12px;font-size:12px;font-weight:600;color:#fff;display:flex;align-items:center;gap:6px">
              ${mode === 'standard' ? '<img src="/opm-fist.png" style="width:14px;height:14px">' : '<i data-lucide="user" style="width:14px;height:14px"></i>'}
              ${mode === 'standard' ? 'One Punch' : 'Noob'}
            </div>
            <button class="prod-btn" id="cam-help" title="Help">?</button>
          </div>
          <div id="depth-bar" style="position:absolute;right:12px;top:50%;transform:translateY(-50%);width:12px;height:40%;background:rgba(0,0,0,0.5);border-radius:6px;overflow:hidden;border:1px solid rgba(255,255,255,0.2)">
            <div id="depth-threshold" style="position:absolute;left:0;right:0;bottom:67%;height:2px;background:#fff;z-index:1"></div>
            <div id="depth-fill" style="position:absolute;bottom:0;left:0;right:0;height:0%;background:#ef4444;transition:height 0.05s,background 0.1s;border-radius:0 0 5px 5px"></div>
          </div>
          <div id="cam-gate-msg" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;color:#fff;font-size:16px;font-weight:600;text-shadow:0 2px 8px rgba(0,0,0,0.8);pointer-events:none">
            ${mode === 'standard' ? 'Stand sideways to the camera' : 'Face the camera'}...
          </div>
          <div id="cam-congrats" style="display:none;position:absolute;top:30%;left:50%;transform:translate(-50%,-50%);text-align:center;color:#fff;pointer-events:none">
            <div style="font-size:24px;font-weight:700;text-shadow:0 2px 8px rgba(0,0,0,0.8)">Daily complete!</div>
            <div style="font-size:14px;color:rgba(255,255,255,0.7);margin-top:4px">Keep going for extra credit</div>
          </div>
          <div style="position:absolute;bottom:70px;left:0;right:0;padding:20px;text-align:center;background:linear-gradient(transparent, rgba(0,0,0,0.7))">
            <div id="cam-count" style="font-size:72px;font-weight:900;letter-spacing:-3px;line-height:1;color:#fff;text-shadow:0 2px 12px rgba(0,0,0,0.5)">0</div>
            <div style="font-size:14px;color:rgba(255,255,255,0.7);margin-top:2px">Reps</div>
            <div id="cam-timer" style="font-size:20px;font-weight:600;color:rgba(255,255,255,0.9);margin-top:4px;font-variant-numeric:tabular-nums">00:00</div>
          </div>
          <div id="cam-bottom-bar" style="position:absolute;bottom:0;left:0;right:0;padding:12px 16px;padding-bottom:max(12px, env(safe-area-inset-bottom));display:flex;gap:8px">
            <button class="btn btn-danger" id="cam-stop" style="flex:1;padding:14px">Stop & Save</button>
            <button class="prod-btn" id="cam-flip" title="Flip camera"><i data-lucide="refresh-cw" style="width:16px;height:16px"></i></button>
          </div>
        </div>
      </div>
    `;

    const video = document.getElementById('cam-video');
    const canvas = document.getElementById('cam-canvas');
    const countEl = document.getElementById('cam-count');
    const trackingBadge = DEV_VIEW ? document.getElementById('cam-tracking') : null;
    const gateMsg = !DEV_VIEW ? document.getElementById('cam-gate-msg') : null;
    const timerEl = !DEV_VIEW ? document.getElementById('cam-timer') : null;
    let trackingInterval;

    function updateTimer() {
      if (!sessionStartTime || !timerEl) return;
      const s = Math.floor((Date.now() - sessionStartTime) / 1000);
      const m = Math.floor(s / 60);
      timerEl.textContent = String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    }

    async function startCamera() {
      const pose = await loadPose();
      await pose.initPoseDetection();
      stream = await pose.getCamera(facingMode);
      video.srcObject = stream;
      await video.play();

      tracker = pose.startTracking(video, canvas, (count) => {
        countEl.textContent = count;
        const congratsEl = document.getElementById('cam-congrats');
        if (congratsEl && count === currentUser.daily_target) {
          congratsEl.style.display = '';
          playCongratsSound();
          setTimeout(() => { congratsEl.style.display = 'none'; }, 3000);
        }
      }, (d) => {
        if (DEV_VIEW) {
          if (mode === 'standard') {
            document.getElementById('d-f1').textContent = 'sDip:' + (d.sDip ?? '--');
            document.getElementById('d-f2').textContent = 'aVar:' + (d.ankleVar ?? '--');
            document.getElementById('d-f3').textContent = 'knee:' + (d.kneeAng ?? '--');
            document.getElementById('d-f4').textContent = d.gateProgress ? 'gate:' + d.gateProgress : (d.missing && d.missing !== 'none' ? 'need:' + d.missing : '');
          } else {
            document.getElementById('d-f1').textContent = 'nDip:' + (d.noseDip ?? '--');
            document.getElementById('d-f2').textContent = 'sDip:' + (d.shoulderDip ?? '--');
            document.getElementById('d-f3').textContent = 'elb:' + (d.elbow ?? '--');
            document.getElementById('d-f4').textContent = d.gateProgress ? 'gate:' + d.gateProgress : 'wVar:' + (d.wVar ?? '--');
          }
          const stateKey = d.phase || d.state || '--';
          document.getElementById('d-state').textContent = stateKey;
          document.getElementById('d-state').style.color = stateKey === 'DOWN' || stateKey === 'DESCENDING' ? '#fc8181' : stateKey === 'ASCENDING' ? '#ecc94b' : '#48bb78';
          document.getElementById('d-gate').textContent = d.gated ?? '--';
          document.getElementById('d-gate').style.color = d.gated === 'active' ? '#48bb78' : '#fc8181';
          document.getElementById('d-count').textContent = d.count ?? 0;
        } else {
          // Prod view: gate message + timer
          if (d.gated === 'active') {
            if (gateMsg.style.display !== 'none') gateMsg.style.display = 'none';
            if (!sessionStartTime) sessionStartTime = Date.now();
          } else {
            gateMsg.style.display = '';
            const missing = d.missing;
            if (d.gateProgress) {
              gateMsg.textContent = 'Hold still...';
            } else if (missing && missing !== 'none') {
              gateMsg.textContent = mode === 'standard' ? 'Stand sideways to the camera' : 'Face the camera';
            } else {
              gateMsg.textContent = 'Looking for you...';
            }
          }
        }
        video.style.borderColor = d.gated === 'active' ? '#48bb78' : '#fc8181';
        // Depth bar
        const depthFill = document.getElementById('depth-fill');
        const depthBar = document.getElementById('depth-bar');
        if (depthFill && d.depth !== undefined) {
          const pct = Math.round(d.depth * 100);
          depthFill.style.height = pct + '%';
          depthFill.style.background = d.depth >= (d.depthThreshold || 0.67) ? '#22c55e' : '#ef4444';
          depthBar.style.opacity = d.gated === 'active' ? '1' : '0.3';
        }
      }, mode);

      if (DEV_VIEW) {
        trackingInterval = setInterval(() => {
          if (tracker && tracker.isTracking()) trackingBadge.classList.remove('hidden');
          else trackingBadge.classList.add('hidden');
        }, 500);
      } else {
        trackingInterval = setInterval(updateTimer, 1000);
      }
    }

    function stopCamera() {
      if (trackingInterval) clearInterval(trackingInterval);
      if (timerInterval) clearInterval(timerInterval);
      if (tracker) tracker.stop();
      if (stream) stream.getTracks().forEach(t => t.stop());
    }

    document.getElementById('cam-stop').addEventListener('click', async () => {
      const count = tracker ? tracker.getCount() : 0;
      stopCamera();
      if (count > 0) {
        await api('POST', '/api/pushups', { count, source: 'camera', mode });
        showToast(`Saved ${count} pushups`);
      }
      await loadDashboard();
    });

    document.getElementById('cam-flip').addEventListener('click', async () => {
      stopCamera();
      facingMode = facingMode === 'user' ? 'environment' : 'user';
      await startCamera();
    });

    if (DEV_VIEW) {
      document.getElementById('cam-log').addEventListener('click', () => {
        if (tracker) {
          const log = tracker.getLog();
          const text = log.map(e => JSON.stringify(e)).join('\n');
          navigator.clipboard.writeText(text).then(() => showToast('Debug log copied (' + log.length + ' events)')).catch(() => prompt('Copy:', text));
        }
      });
    }

    document.getElementById('cam-help').addEventListener('click', () => {
      stopCamera();
      showTutorial(() => startCameraSession());
    });

    initIcons();
    try { await startCamera(); }
    catch { showToast('Camera access denied.'); await loadDashboard(); }
  }
}

async function init() {
  try {
    const data = await api('GET', '/api/me');
    currentUser = data;
    await checkTimezone();
    showScreen('dashboard', data);
  } catch {
    showScreen('auth');
  }
}

init();
