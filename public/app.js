let currentUser = null;
let currentScreen = 'loading';

let poseModule = null;
async function loadPose() {
  if (!poseModule) poseModule = await import('/pose.js');
  return poseModule;
}

// Sounds work in desktop Safari / Chrome but not in iOS PWA after a
// cold reopen. The previous WebAudio unlock plumbing (PRs #29, #30,
// #34-#38) did not fix it — see docs/superpowers/research/2026-04-15-
// ios-pwa-audio.md for the full investigation. Reverted to the simple
// per-tone fresh-ctx approach for now; shelved for later.
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
    if (d.mode === 'opm') return '<img src="/opm-fist.png" style="width:22px;height:22px;vertical-align:middle">';
    if (d.mode === 'situp') return '🙆';
    return '👊';
  }).join('');
}

function streakText(streak) {
  if (!streak) return '';
  if (streak.type === 'hot' && streak.count > 0) return `🔥 ${streak.count}d streak`;
  if (streak.type === 'ice') return '🧊';
  return '';
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
        <img src="/opm-fist.png" class="logo-fist" alt="">
        <div class="logo">PushTracker</div>
        <div class="subtitle">No excuses.</div>
        <form class="auth-form" id="auth-form" novalidate>
          <div class="input-group">
            <label>Username</label>
            <input type="text" id="auth-username" autocomplete="username" autocapitalize="none" maxlength="15" required>
            <div class="field-error" id="err-username"></div>
          </div>
          <div class="input-group" ${mode === 'login' ? 'style="display:none"' : ''}>
            <label>Invite Code</label>
            <input type="text" id="auth-invite" autocapitalize="characters" placeholder="Enter invite code" maxlength="4" style="text-transform:uppercase">
            <div class="field-error" id="err-invite"></div>
          </div>
          <div class="input-group">
            <label>4-Digit Passcode</label>
            <div class="passcode-boxes">
              <input type="number" inputmode="numeric" maxlength="1" class="pin" data-idx="0">
              <input type="number" inputmode="numeric" maxlength="1" class="pin" data-idx="1">
              <input type="number" inputmode="numeric" maxlength="1" class="pin" data-idx="2">
              <input type="number" inputmode="numeric" maxlength="1" class="pin" data-idx="3">
            </div>
            <div class="field-error" id="err-passcode"></div>
          </div>
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
        clearFieldError('err-passcode');
        if (pin.value && i < 3) pins[i + 1].focus();
      });
      pin.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !pin.value && i > 0) pins[i - 1].focus();
      });
    });

    // Live-filter non-alphanumeric characters from username and invite
    // inputs so typing `_`, space, or punctuation never reaches the
    // value at all. Paste is covered too — the 'input' event fires
    // after paste and we re-assign value.
    const usernameInput = app.querySelector('#auth-username');
    usernameInput.addEventListener('input', () => {
      const filtered = usernameInput.value.replace(/[^A-Za-z0-9]/g, '');
      if (filtered !== usernameInput.value) usernameInput.value = filtered;
      clearFieldError('err-username');
    });

    const inviteInput = app.querySelector('#auth-invite');
    if (inviteInput) {
      inviteInput.addEventListener('input', () => {
        const filtered = inviteInput.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
        if (filtered !== inviteInput.value) inviteInput.value = filtered;
        clearFieldError('err-invite');
      });
    }

    function clearFieldError(id) {
      const el = app.querySelector('#' + id);
      if (el) el.textContent = '';
    }
    function setFieldError(id, message) {
      const el = app.querySelector('#' + id);
      if (el) el.textContent = message;
    }
    function clearAllFieldErrors() {
      ['err-username', 'err-invite', 'err-passcode'].forEach(clearFieldError);
    }
    // Best-effort route from a server error message to the field it
    // probably refers to. Priority: passcode > invite > username so
    // "Invalid username or passcode" lands under the passcode row
    // (the more commonly mistyped of the two).
    function routeServerError(message) {
      if (/passcode/i.test(message)) return 'err-passcode';
      if (/invite/i.test(message)) return 'err-invite';
      if (/username/i.test(message)) return 'err-username';
      return 'err-passcode';
    }

    app.querySelector('#toggle-auth').addEventListener('click', () => {
      mode = mode === 'login' ? 'signup' : 'login';
      render();
    });

    app.querySelector('#auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      clearAllFieldErrors();

      const username = usernameInput.value.trim();
      const passcode = Array.from(pins).map(p => p.value).join('');
      let ok = true;

      if (!username) {
        setFieldError('err-username', 'Required');
        ok = false;
      } else if (!/^[A-Za-z0-9]{1,15}$/.test(username)) {
        setFieldError('err-username', '1–15 letters or numbers');
        ok = false;
      }

      if (mode === 'signup') {
        const inviteCode = inviteInput.value.trim();
        if (!inviteCode) {
          setFieldError('err-invite', 'Required');
          ok = false;
        } else if (!/^[A-Za-z0-9]{4}$/.test(inviteCode)) {
          setFieldError('err-invite', '4 letters or numbers');
          ok = false;
        }
      }

      if (passcode.length !== 4) {
        setFieldError('err-passcode', 'Enter a 4-digit passcode');
        ok = false;
      }

      if (!ok) return;

      try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (mode === 'signup') {
          const inviteCode = inviteInput.value.trim();
          const data = await api('POST', '/api/auth/signup', { username, passcode, timezone: tz, inviteCode });
          currentUser = data.user;
        } else {
          const data = await api('POST', '/api/auth/login', { username, passcode });
          currentUser = data.user;
        }
        await checkTimezone();
        await loadDashboard();
      } catch (err) {
        setFieldError(routeServerError(err.message), err.message);
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
  // "pushup today" = the civil date (in the user's timezone) that the cron will
  // write as day_date for the current 7am-to-7am window. Using browser civil
  // today here would mislabel work done between midnight and the boundary hour:
  // the in-progress win would show on tomorrow's cell while yesterday shows
  // fail, because day_results hasn't been written yet and the fallback is 🧊.
  // Mirrors src/cron.ts: day_date = prevBoundary → user timezone → ISO date.
  const pushupToday = (() => {
    if (!userData.next_day_boundary || !userData.timezone) {
      const fallback = new Date();
      return { year: fallback.getFullYear(), month: fallback.getMonth() + 1, day: fallback.getDate() };
    }
    const nextBoundary = new Date(userData.next_day_boundary);
    const prevBoundary = new Date(nextBoundary.getTime() - 86400000);
    const iso = prevBoundary.toLocaleDateString('en-CA', { timeZone: userData.timezone });
    const [y, m, d] = iso.split('-').map(Number);
    return { year: y, month: m, day: d };
  })();

  let year = pushupToday.year;
  let month = pushupToday.month;

  async function render() {
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const resp = await api('GET', `/api/me/calendar?year=${year}&month=${month}`);
    const dayMap = {};
    (resp.days || []).forEach(d => { dayMap[d.day] = d; });

    const firstDay = new Date(year, month - 1, 1).getDay();
    const daysInMonth = new Date(year, month, 0).getDate();
    const today = pushupToday.day;
    const isCurrentMonth = year === pushupToday.year && month === pushupToday.month;

    let gridHtml = '';
    // Empty cells for offset
    for (let i = 0; i < firstDay; i++) gridHtml += '<div class="cal-cell"></div>';
    const created = userData.created_at ? new Date(userData.created_at.replace(' ', 'T') + 'Z') : new Date();
    const pushupTodayDate = new Date(pushupToday.year, pushupToday.month - 1, pushupToday.day);
    for (let d = 1; d <= daysInMonth; d++) {
      const isToday = isCurrentMonth && d === today;
      const cellDate = new Date(year, month - 1, d);
      const isPast = cellDate < pushupTodayDate;
      const afterCreation = cellDate >= new Date(created.getFullYear(), created.getMonth(), created.getDate());
      const entry = dayMap[d];
      let icon = '';
      const metIcon = (mode) => {
        if (mode === 'opm') return '<img src="/opm-fist.png" style="width:14px;height:14px">';
        if (mode === 'situp') return '🙆';
        return '👊';
      };

      if (isToday && userData.today_total >= userData.daily_target && userData.daily_target > 0) {
        const todayEntry = userData.last5days && userData.last5days.length > 0 ? userData.last5days[userData.last5days.length - 1] : null;
        icon = metIcon(todayEntry && todayEntry.mode);
      } else if (entry) {
        icon = entry.met ? metIcon(entry.mode) : '🧊';
      } else if (isPast && afterCreation) {
        icon = '🧊';
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
      if (nextY > pushupToday.year || (nextY === pushupToday.year && nextM > pushupToday.month)) return;
      month = nextM; year = nextY;
      render();
    });
  }

  await render();
}

function renderDashboard(app, data) {
  let activeTab = 'me';
  let showBreakdown = false;

  function renderTab() {
    if (activeTab === 'me') renderMeTab();
    else renderTeamTab();
  }

  function tabHeader() {
    return `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">
        <div style="flex:1"></div>
        <div style="text-align:center">
          <div style="font-size:18px;font-weight:700">${data.group_name || ''}</div>
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
    const surplus = Math.max(0, data.today_total - data.daily_target);
    const debtCovered = data.debt > 0 ? Math.min(surplus, data.debt) : 0;
    const debtFullyPaid = debtCovered > 0 && debtCovered >= data.debt;
    const remainingDebt = Math.max(0, data.debt - debtCovered);

    // Mode breakdown for the segmented progress bar. Manual rolls into standard,
    // matching the cron's day-icon "other" bucket (src/day-icon.ts).
    const byMode = data.today_by_mode || { opm: 0, situp: 0, standard: 0 };
    const totalReps = byMode.opm + byMode.situp + byMode.standard;
    const hasAnyReps = totalReps > 0;
    // Segment widths are proportional to target. Scale down if total > target.
    const tgt = data.daily_target || 1;
    let opmW = (byMode.opm / tgt) * 100;
    let situpW = (byMode.situp / tgt) * 100;
    let stdW = (byMode.standard / tgt) * 100;
    const sumW = opmW + situpW + stdW;
    if (sumW > 100) {
      const k = 100 / sumW;
      opmW *= k; situpW *= k; stdW *= k;
    }
    const segmentedBar = `
      <div class="progress-bar progress-bar-segmented">
        ${opmW   > 0 ? `<div class="seg seg-opm"   style="width:${opmW}%"></div>`   : ''}
        ${situpW > 0 ? `<div class="seg seg-situp" style="width:${situpW}%"></div>` : ''}
        ${stdW   > 0 ? `<div class="seg seg-std"   style="width:${stdW}%"></div>`   : ''}
      </div>
    `;

    // Percentages for the breakdown view (relative to total reps done today).
    const pctOf = (n) => totalReps > 0 ? Math.round((n / totalReps) * 100) : 0;
    const modeRows = [
      { key: 'opm',   label: 'One Punch', count: byMode.opm,      pct: pctOf(byMode.opm) },
      { key: 'situp', label: 'Sit-up',    count: byMode.situp,    pct: pctOf(byMode.situp) },
      { key: 'std',   label: 'Standard',  count: byMode.standard, pct: pctOf(byMode.standard) },
    ].filter(m => m.count > 0).sort((a, b) => b.count - a.count);

    // Plurality-winning mode. Same rule as src/day-icon.ts pickDayIcon: most
    // reps wins, ties break toward the harder mode (opm > situp > standard).
    // This drives the completion border color so the card theme matches
    // whichever mode dominated the day.
    const pluralityKey = (() => {
      const max = Math.max(byMode.opm, byMode.situp, byMode.standard);
      if (byMode.opm === max) return 'opm';
      if (byMode.situp === max) return 'situp';
      return 'std';
    })();
    // Palette for the completed state. `rgb` is the raw channel triplet so the
    // box-shadow glow can be built with rgba(...) at low alpha.
    const completedStyles = done ? (() => {
      const palette = {
        opm:   { color: 'var(--one-punch)', rgb: '245,132,38'  },
        situp: { color: 'var(--info)',      rgb: '59,130,246'  },
        std:   { color: 'var(--primary)',   rgb: '250,250,250' },
      }[pluralityKey];
      return {
        card:  `border-color:${palette.color};box-shadow:0 0 20px rgba(${palette.rgb},0.15),0 0 60px rgba(${palette.rgb},0.05)`,
        count: `color:${palette.color}`,
        label: `color:${palette.color}`,
      };
    })() : null;

    const frontBody = `
      <div class="progress-count" style="${completedStyles ? completedStyles.count : ''}">${data.today_total} <span class="progress-target">/ ${data.daily_target}</span></div>
      ${segmentedBar}
    `;

    const backBody = `
      <div class="breakdown-list">
        ${modeRows.map(m => `
          <div class="breakdown-row">
            <div class="breakdown-dot seg-dot-${m.key}"></div>
            <div class="breakdown-label">${m.label}</div>
            <div class="breakdown-count">${m.count}</div>
            <div class="breakdown-pct">${m.pct}%</div>
          </div>
        `).join('')}
      </div>
      ${segmentedBar}
    `;

    // Inner HTML of #progress-card-el. Extracted so the flip toggle can swap
    // just this content instead of re-rendering the whole Me tab (which
    // would also re-fetch the calendar from /api/me/calendar).
    function progressCardInner(showBack) {
      return `
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div class="progress-label">${showBack ? 'BREAKDOWN' : (done ? `<span style="${completedStyles ? completedStyles.label : ''}">✓ COMPLETE</span>` : 'Today')}<span class="progress-time-left" id="time-left"></span></div>
          ${hasAnyReps ? `<button class="flip-btn" id="flip-btn" aria-label="${showBack ? 'Hide breakdown' : 'Show breakdown'}"><i data-lucide="${showBack ? 'arrow-left' : 'pie-chart'}" style="width:14px;height:14px"></i></button>` : ''}
        </div>
        ${showBack ? backBody : frontBody}
        ${data.debt > 0 ? `<div style="margin-top:8px;font-size:12px;color:${debtFullyPaid ? '#22c55e' : 'var(--danger)'}">${debtFullyPaid ? '✓' : ''} ${debtCovered}/${data.debt} debt covered</div>` : ''}
        ${done && (data.has_slack || data.has_discord) ? `<div style="margin-top:${data.debt > 0 ? '4' : '8'}px;font-size:11px;color:var(--text-muted);display:flex;align-items:center;gap:5px"><i data-lucide="hash" style="width:12px;height:12px;opacity:0.5"></i> Results posted to ${data.has_slack && data.has_discord ? 'Slack and Discord' : data.has_slack ? 'Slack' : 'Discord'} at 7am</div>` : ''}
      `;
    }

    // Re-queries #time-left each tick so it survives the card-inner swap.
    function updateTimeLeft() {
      if (!data.next_day_boundary) return;
      const timeEl = document.getElementById('time-left');
      if (!timeEl) return;
      const ms = new Date(data.next_day_boundary).getTime() - Date.now();
      if (ms <= 0) { timeEl.textContent = '(resetting...)'; return; }
      const totalMin = Math.floor(ms / 60000);
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      timeEl.textContent = h > 0 ? `(${h}h ${m}m left)` : `(${m}m left)`;
    }

    function bindFlipBtn() {
      const flipBtn = document.getElementById('flip-btn');
      if (!flipBtn) return;
      flipBtn.addEventListener('click', () => {
        showBreakdown = !showBreakdown;
        const cardEl = document.getElementById('progress-card-el');
        cardEl.innerHTML = progressCardInner(showBreakdown && hasAnyReps);
        bindFlipBtn();
        initIcons();
        updateTimeLeft();
      });
    }

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
      <div class="progress-card" id="progress-card-el" style="${completedStyles ? completedStyles.card : ''}">
        ${progressCardInner(showBreakdown && hasAnyReps)}
      </div>
      ${remainingDebt > 0 ? `
      <div class="debt-card">
        <div><div style="font-size:11px;text-transform:uppercase;color:var(--text-dim)">Debt</div><div class="debt-count">${remainingDebt}${remainingDebt >= data.daily_target * 3 ? ' <span class="debt-max">MAX</span>' : ''}</div></div>
        <div class="debt-label">pushups<br>owed</div>
      </div>` : ''}
      <div style="display:flex;gap:10px;margin-top:16px">
        <button class="action-btn primary" id="btn-camera" style="flex:3">
          <span class="icon"><i data-lucide="activity" style="width:22px;height:22px"></i></span><span class="label">Start</span>
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
    bindFlipBtn();
    initIcons();
    renderCalendar(document.getElementById('calendar-container'), data);

    updateTimeLeft();
    if (data.next_day_boundary) setInterval(updateTimeLeft, 60000);
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
          const mSurplus = Math.max(0, m.today_total - m.daily_target);
          const mRemainingDebt = Math.max(0, m.debt - Math.min(mSurplus, m.debt));

          // Streak/ice slot — all decision logic lives on the backend now
          // (src/day-icon.ts#computeStreakDisplay). streak.type is one of
          // 'hot' | 'ice' | 'none'; streakText renders each case.
          const leftText = streakText(m.streak);
          const hasLeftText = leftText.length > 0;

          // Expanded: last5 icon row + today breakdown bar + legend. Only
          // shown for members who have ever logged — non-starters have
          // nothing to show and no reason to be clickable.
          const byMode = m.today_by_mode || { opm: 0, situp: 0, standard: 0 };
          const tgt = m.daily_target || 1;
          const hasTodayReps = (byMode.opm + byMode.situp + byMode.standard) > 0;
          let opmW   = (byMode.opm      / tgt) * 100;
          let situpW = (byMode.situp    / tgt) * 100;
          let stdW   = (byMode.standard / tgt) * 100;
          const sumW = opmW + situpW + stdW;
          if (sumW > 100) { const k = 100 / sumW; opmW *= k; situpW *= k; stdW *= k; }

          const expanded = m.ever_logged ? `
            <div class="member-expanded">
              <div class="member-expanded-wrap">
                <div class="member-expanded-inner">
                  <div class="expanded-row">
                    <div class="expanded-label">Last 5</div>
                    <div class="expanded-icons">${streakIcons(m.last5days)}</div>
                  </div>
                  <div class="expanded-row">
                    <div class="expanded-label">Today</div>
                    ${hasTodayReps ? `
                      <div class="expanded-bar">
                        ${opmW   > 0 ? `<div class="seg seg-opm"   style="width:${opmW}%"></div>`   : ''}
                        ${situpW > 0 ? `<div class="seg seg-situp" style="width:${situpW}%"></div>` : ''}
                        ${stdW   > 0 ? `<div class="seg seg-std"   style="width:${stdW}%"></div>`   : ''}
                      </div>
                    ` : '<span class="expanded-empty">No reps yet</span>'}
                  </div>
                  ${hasTodayReps ? `
                    <div class="expanded-legend">
                      ${byMode.opm      > 0 ? `<div class="legend-item"><span class="breakdown-dot seg-dot-opm"></span>OP <strong>${byMode.opm}</strong></div>` : ''}
                      ${byMode.situp    > 0 ? `<div class="legend-item"><span class="breakdown-dot seg-dot-situp"></span>Sit-up <strong>${byMode.situp}</strong></div>` : ''}
                      ${byMode.standard > 0 ? `<div class="legend-item"><span class="breakdown-dot seg-dot-std"></span>Standard <strong>${byMode.standard}</strong></div>` : ''}
                    </div>
                  ` : ''}
                </div>
              </div>
            </div>` : '';

          return `
            <div class="team-member${m.ever_logged ? ' expandable' : ''}" data-member-id="${m.id}">
              <div class="team-member-header">
                <div>
                  <div class="member-name">${m.username}</div>
                  <div class="member-target">${!m.ever_logged ? '<span style="font-size:11px;color:var(--text-dim)">not started</span>' : `${leftText}${mRemainingDebt > 0 ? `<span style="font-size:11px;color:var(--danger);margin-left:${hasLeftText ? '4' : '0'}px">${hasLeftText ? '· ' : ''}${mRemainingDebt} debt${mRemainingDebt >= m.daily_target * 3 ? ' <span class="debt-max-inline">MAX</span>' : ''}</span>` : ''}`}</div>
                </div>
                <div class="team-member-right">
                  <div class="member-progress ${statusClass}">${display}</div>
                  ${m.ever_logged ? '<i data-lucide="chevron-down" class="team-chevron"></i>' : ''}
                </div>
              </div>
              ${expanded}
            </div>`;
        }).join('')}
      `;

      // Accordion: clicking a header opens it and closes any currently
      // open sibling. Click again to close. Non-expandable rows (not yet
      // started) do nothing.
      app.querySelectorAll('.team-member.expandable .team-member-header').forEach(header => {
        header.addEventListener('click', () => {
          const card = header.parentElement;
          const wasOpen = card.classList.contains('open');
          app.querySelectorAll('.team-member.open').forEach(c => c.classList.remove('open'));
          if (!wasOpen) card.classList.add('open');
        });
      });

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
      <p style="font-size:11px;color:var(--text-muted);text-align:center;margin:-8px 0 14px">Tap the number to type it</p>
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
  overlay.querySelector('#step-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true;
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
      <div class="setting-section-label">Lifetime Totals</div>
      <div class="setting-row">
        <span class="setting-label" style="display:flex;align-items:center;gap:10px">
          <span style="font-size:16px">👊</span>
          Push-ups
        </span>
        <span class="lifetime-value" id="lifetime-pushups">…</span>
      </div>
      <div class="setting-row">
        <span class="setting-label" style="display:flex;align-items:center;gap:10px">
          <span style="font-size:16px">🙆</span>
          Sit-ups
        </span>
        <span class="lifetime-value" id="lifetime-situps">…</span>
      </div>
      <button class="btn btn-primary" style="width:100%;margin-top:16px;margin-bottom:10px" id="set-save">Save</button>
      ${currentUser.paired_username ? `
        <div style="display:flex;gap:8px">
          <button class="btn btn-one-punch" style="flex:1" id="set-switch">Switch to ${currentUser.paired_username}</button>
          <button class="btn btn-danger" style="flex:1" id="set-logout">Log Out</button>
        </div>
      ` : `
        <button class="btn btn-danger" style="width:100%" id="set-logout">Log Out</button>
      `}
    </div>
  `;
  document.body.appendChild(overlay); initIcons();

  // Fetch lifetime totals (separate endpoint, not on /api/me hot path).
  api('GET', '/api/me/lifetime').then(({ pushups, situps }) => {
    const pEl = overlay.querySelector('#lifetime-pushups');
    const sEl = overlay.querySelector('#lifetime-situps');
    if (pEl) pEl.textContent = pushups.toLocaleString();
    if (sEl) sEl.textContent = situps.toLocaleString();
  }).catch(() => { /* leave placeholders on error */ });

  overlay.querySelector('#set-save').addEventListener('click', async () => {
    const target = parseInt(overlay.querySelector('#set-target').value) || 0;
    const err = document.getElementById('target-error');
    if (target < 20) { err.textContent = 'Minimum target is 20'; err.style.display = ''; return; }
    err.style.display = 'none';
    try {
      await api('PUT', '/api/me/target', { target });
      currentUser.daily_target = target;
      overlay.remove();
      showToast('Target updated');
      await loadDashboard();
    } catch (e) {
      // Debt-gate rejection (or any other 400) — surface the server's
      // message in the field error slot so it persists instead of
      // flashing as a transient toast.
      err.textContent = (e && e.message) ? e.message : 'Could not update target';
      err.style.display = '';
    }
  });
  overlay.querySelector('#set-logout').addEventListener('click', async () => {
    await api('POST', '/api/auth/logout');
    currentUser = null;
    overlay.remove();
    showScreen('auth');
  });
  const switchBtn = overlay.querySelector('#set-switch');
  if (switchBtn) {
    switchBtn.addEventListener('click', async () => {
      try {
        await api('POST', '/api/auth/switch');
        overlay.remove();
        await loadDashboard();
      } catch (e) {
        showToast('Switch failed');
      }
    });
  }
  overlay.querySelector('#set-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

let cameraMode = 'standard'; // 'standard', 'opm', or 'situp'

function getModeContent(mode) {
  if (mode === 'situp') return `
    <div style="text-align:center;margin-bottom:20px">
      <div style="font-size:36px">🙆</div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Streak icon</div>
    </div>
    <div style="font-weight:600;margin-bottom:10px;font-size:16px;text-align:center">Setup in 3 steps:</div>
    <div style="display:flex;gap:14px;align-items:flex-start;margin-bottom:16px">
      <img src="/setup-situp.png" style="width:110px;flex-shrink:0;border-radius:10px;object-fit:contain">
      <div style="flex:1">
        <div style="display:flex;flex-direction:column;gap:12px;font-size:13px;margin-top:14px">
          <div style="display:flex;gap:8px;align-items:flex-start"><span style="font-weight:700;color:var(--info);font-size:16px">1</span><div><strong style="color:var(--text)">Phone to your side</strong><br><span style="color:var(--text-dim)">It needs to see your full profile</span></div></div>
          <div style="display:flex;gap:8px;align-items:flex-start"><span style="font-weight:700;color:var(--info);font-size:16px">2</span><div><strong style="color:var(--text)">Lie down with knees bent</strong><br><span style="color:var(--text-dim)">Shoulders and hips must be in frame</span></div></div>
          <div style="display:flex;gap:8px;align-items:flex-start"><span style="font-weight:700;color:var(--info);font-size:16px">3</span><div><strong style="color:var(--text)">Wait for the chime</strong><br><span style="color:var(--text-dim)">Green border means ready</span></div></div>
        </div>
      </div>
    </div>
    <p style="font-size:11px;color:var(--text-muted);line-height:1.5;padding:0 4px">Sit-up Mode tracks your spine angle — from lying flat to sitting up. Full range of motion is required for each rep to count. Same daily target as pushups.</p>`;

  if (mode === 'opm') return `
    <div style="text-align:center;margin-bottom:20px">
      <img src="/opm-fist.png" style="width:48px;height:48px">
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Streak icon</div>
    </div>
    <div style="font-weight:600;margin-bottom:10px;font-size:16px;text-align:center">Setup in 3 steps:</div>
    <div style="display:flex;gap:14px;align-items:flex-start;margin-bottom:16px">
      <img src="/setup-opm.png" style="width:110px;flex-shrink:0;border-radius:10px;object-fit:contain">
      <div style="flex:1">
        <div style="display:flex;flex-direction:column;gap:12px;font-size:13px;margin-top:14px">
          <div style="display:flex;gap:8px;align-items:flex-start"><span style="font-weight:700;color:var(--primary);font-size:16px">1</span><div><strong style="color:var(--text)">Phone to your side</strong><br><span style="color:var(--text-dim)">It needs to see your full profile</span></div></div>
          <div style="display:flex;gap:8px;align-items:flex-start"><span style="font-weight:700;color:var(--primary);font-size:16px">2</span><div><strong style="color:var(--text)">Shoulder to ankle in frame</strong><br><span style="color:var(--text-dim)">Ankles must be visible — reps won't count without them</span></div></div>
          <div style="display:flex;gap:8px;align-items:flex-start"><span style="font-weight:700;color:var(--primary);font-size:16px">3</span><div><strong style="color:var(--text)">Wait for the chime</strong><br><span style="color:var(--text-dim)">Green border means ready</span></div></div>
        </div>
      </div>
    </div>
    <p style="font-size:11px;color:var(--text-muted);line-height:1.5;padding:0 4px">One Punch Mode uses full-body tracking with stricter form requirements. Some reps may not count if ankles leave the frame or knee angle is too bent. Keep your full body visible for best results.</p>`;

  return `
    <div style="text-align:center;margin-bottom:20px">
      <div style="font-size:36px">👊</div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Streak icon</div>
    </div>
    <div style="font-weight:600;margin-bottom:10px;font-size:16px;text-align:center">Setup in 3 steps:</div>
    <div style="display:flex;gap:14px;align-items:flex-start;margin-bottom:16px">
      <img src="/setup-standard.png" style="width:110px;flex-shrink:0;border-radius:10px;object-fit:contain">
      <div style="flex:1">
        <div style="display:flex;flex-direction:column;gap:12px;font-size:13px;margin-top:14px">
          <div style="display:flex;gap:8px;align-items:flex-start"><span style="font-weight:700;color:var(--primary);font-size:16px">1</span><div><strong style="color:var(--text)">Face the camera</strong><br><span style="color:var(--text-dim)">Place phone on the floor in front of you</span></div></div>
          <div style="display:flex;gap:8px;align-items:flex-start"><span style="font-weight:700;color:var(--primary);font-size:16px">2</span><div><strong style="color:var(--text)">Face, shoulders + wrists visible</strong><br><span style="color:var(--text-dim)">Wrists need to be in frame to track</span></div></div>
          <div style="display:flex;gap:8px;align-items:flex-start"><span style="font-weight:700;color:var(--primary);font-size:16px">3</span><div><strong style="color:var(--text)">Wait for the chime</strong><br><span style="color:var(--text-dim)">Green border means ready</span></div></div>
        </div>
      </div>
    </div>
    <p style="font-size:11px;color:var(--text-muted);line-height:1.5;padding:0 4px">Standard Mode only tracks your upper body — it can't tell if you're on your knees or doing full push-ups. Great for getting started, but it won't catch shortcuts.</p>`;
}

function showTutorial(onStart) {
  const app = document.getElementById('app');
  const isOpm = cameraMode === 'opm';
  const isSitup = cameraMode === 'situp';
  const title = isOpm ? 'One Punch Mode' : isSitup ? 'Sit-up Mode' : 'Standard Mode';
  const titleColor = isOpm ? 'color:var(--one-punch)' : isSitup ? 'color:var(--info)' : '';
  const btnClass = isOpm ? 'btn-one-punch' : isSitup ? 'btn-info' : 'btn-primary';

  app.innerHTML = `
    <div class="camera-screen" style="background:var(--bg);overflow-y:auto">
      <button id="tut-back" style="position:fixed;top:16px;left:16px;background:none;border:none;color:var(--text-dim);cursor:pointer;padding:8px;z-index:101"><i data-lucide="arrow-left" style="width:20px;height:20px"></i></button>
      <div style="padding:24px 20px;max-width:400px;margin:0 auto">
        <h2 style="text-align:center;margin-bottom:8px;${titleColor}">${title}</h2>
        <div style="display:flex;justify-content:center;margin-bottom:16px">
          <div style="display:inline-flex;background:var(--surface-2);border-radius:8px;overflow:hidden">
            <button id="mode-std" style="padding:8px 14px;border:none;font-size:13px;font-weight:500;cursor:pointer;background:${!isOpm && !isSitup ? 'var(--primary)' : 'transparent'};color:${!isOpm && !isSitup ? 'var(--primary-fg)' : 'var(--text)'}">Standard</button>
            <button id="mode-opm" style="padding:8px 14px;border:none;font-size:13px;font-weight:500;cursor:pointer;background:${isOpm ? 'var(--one-punch)' : 'transparent'};color:${isOpm ? '#fff' : 'var(--text)'}">One Punch</button>
            <button id="mode-situp" style="padding:8px 14px;border:none;font-size:13px;font-weight:500;cursor:pointer;background:${isSitup ? 'var(--info)' : 'transparent'};color:${isSitup ? '#fff' : 'var(--text)'}">Sit-up</button>
          </div>
        </div>

        ${getModeContent(cameraMode)}

        <button class="btn ${btnClass}" style="width:100%;margin-top:24px" id="tut-start">Start Recording</button>
      </div>
    </div>
  `;

  initIcons();
  document.getElementById('mode-std').addEventListener('click', () => { cameraMode = 'standard'; showTutorial(onStart); });
  document.getElementById('mode-opm').addEventListener('click', () => { cameraMode = 'opm'; showTutorial(onStart); });
  document.getElementById('mode-situp').addEventListener('click', () => { cameraMode = 'situp'; showTutorial(onStart); });
  document.getElementById('tut-start').addEventListener('click', onStart);
  document.getElementById('tut-back').addEventListener('click', () => loadDashboard());
}

async function renderCamera(app) {
  showTutorial(() => startCameraSession());

  async function startCameraSession() {
    let facingMode = 'user';
    let stream = null;
    let tracker = null;
    const mode = cameraMode;
    const DEV_VIEW = false;
    let sessionStartTime = null;
    let timerInterval = null;

    // Stop & Save follows the active mode color so the whole screen reads as one
    // palette. Standard maps to btn-primary (white bg / dark text) — still high
    // contrast over the camera feed's dark gradient, and matches the mode-select.
    const stopBtnClass = mode === 'opm' ? 'btn-one-punch'
      : mode === 'situp' ? 'btn-info'
      : 'btn-primary';

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
            <span style="color:${mode === 'opm' ? 'var(--one-punch)' : mode === 'situp' ? 'var(--info)' : 'var(--primary)'};font-weight:bold">${mode === 'opm' ? 'OPM' : mode === 'situp' ? 'SITUP' : 'STANDARD'}</span>
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
          <div class="count-label">${mode === 'situp' ? 'sit-ups detected' : 'pushups detected'}</div>
        </div>
        <div class="camera-controls">
          <button class="btn ${stopBtnClass}" id="cam-stop">Stop &amp; Save</button>
          <button class="btn-flip" id="cam-flip" title="Flip camera"><i data-lucide="refresh-cw" style="width:16px;height:16px"></i></button>
          <button class="btn-flip" id="cam-log" title="Copy debug log">LOG</button>
          <button class="btn-flip" id="cam-help" title="Help">?</button>
        </div>
      </div>
    ` : `
      <div class="camera-screen">
        <div class="camera-feed">
          <video id="cam-video" playsinline autoplay muted></video>
          <canvas id="cam-canvas"></canvas>
          <div id="cam-gate-border" style="position:absolute;inset:0;border:6px solid #fc8181;pointer-events:none;z-index:5;transition:border-color 0.15s"></div>
          <div style="position:absolute;top:16px;right:16px;display:flex;gap:8px;align-items:center">
            <div style="background:rgba(0,0,0,0.5);backdrop-filter:blur(8px);border-radius:20px;padding:6px 12px;font-size:12px;font-weight:600;color:#fff;display:flex;align-items:center;gap:6px">
              ${mode === 'opm' ? '<img src="/opm-fist.png" style="width:14px;height:14px">' : mode === 'situp' ? '<span style="font-size:12px">🙆</span>' : '<span style="font-size:12px">👊</span>'}
              ${mode === 'opm' ? 'One Punch' : mode === 'situp' ? 'Sit-up' : 'Standard'}
            </div>
            <button class="prod-btn" id="cam-help" title="Help">?</button>
          </div>
          <div id="depth-bar" style="position:absolute;right:12px;top:50%;transform:translateY(-50%);width:12px;height:40%;background:rgba(0,0,0,0.5);border-radius:6px;overflow:hidden;border:1px solid rgba(255,255,255,0.2)">
            <div id="depth-threshold" style="position:absolute;left:0;right:0;bottom:67%;height:2px;background:#fff;z-index:1"></div>
            <div id="depth-fill" style="position:absolute;bottom:0;left:0;right:0;height:0%;background:#ef4444;transition:height 0.05s,background 0.1s;border-radius:0 0 5px 5px"></div>
          </div>
          <div id="cam-gate-msg" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;color:#fff;font-size:16px;font-weight:600;text-shadow:0 2px 8px rgba(0,0,0,0.8);pointer-events:none">
            ${mode === 'situp' ? 'Lie down in view of the camera' : 'Face the camera'}...
          </div>
          <div id="cam-congrats" style="display:none;position:absolute;top:30%;left:50%;transform:translate(-50%,-50%);text-align:center;color:#fff;pointer-events:none">
            <div style="font-size:24px;font-weight:700;text-shadow:0 2px 8px rgba(0,0,0,0.8)">Daily complete!</div>
            <div style="font-size:14px;color:rgba(255,255,255,0.7);margin-top:4px">Keep going for extra credit</div>
          </div>
          <div style="position:absolute;bottom:0;left:0;right:0;padding:20px;text-align:center;background:linear-gradient(transparent, #000)">
            <div id="cam-count" style="font-size:72px;font-weight:900;letter-spacing:-3px;line-height:1;color:#fff;text-shadow:0 2px 12px rgba(0,0,0,0.5)">0</div>
            <div style="font-size:14px;color:rgba(255,255,255,0.7);margin-top:2px">Reps</div>
            <div id="cam-timer" style="font-size:20px;font-weight:600;color:rgba(255,255,255,0.9);margin-top:4px;font-variant-numeric:tabular-nums">00:00</div>
          </div>
        </div>
        <div id="cam-bottom-bar" style="flex:0 0 auto;padding:12px 16px;padding-bottom:max(12px, env(safe-area-inset-bottom));background:#000;display:flex;align-items:center;gap:8px">
          <div style="flex:0 0 60px"></div>
          <button class="btn ${stopBtnClass}" id="cam-stop" style="flex:1;max-width:260px;margin:0 auto;padding:14px">Stop & Save</button>
          <button class="prod-btn" id="cam-flip" title="Flip camera" style="flex:0 0 60px;height:40px;border-radius:20px"><i data-lucide="switch-camera" style="width:18px;height:18px"></i></button>
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
      const mirror = facingMode === 'user' ? 'scaleX(-1)' : '';
      video.style.transform = mirror;
      canvas.style.transform = mirror;

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
          if (mode === 'opm') {
            document.getElementById('d-f1').textContent = 'sDip:' + (d.sDip ?? '--');
            document.getElementById('d-f2').textContent = 'aVar:' + (d.ankleVar ?? '--');
            document.getElementById('d-f3').textContent = 'knee:' + (d.kneeAng ?? '--');
            document.getElementById('d-f4').textContent = d.gateProgress ? 'gate:' + d.gateProgress : (d.missing && d.missing !== 'none' ? 'need:' + d.missing : '');
          } else if (mode === 'situp') {
            document.getElementById('d-f1').textContent = 'ang:' + (d.lift ?? '--');
            document.getElementById('d-f2').textContent = 'dev:' + (d.liftDelta ?? '--');
            document.getElementById('d-f3').textContent = 'base:' + (d.baseline ?? '--');
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
              gateMsg.textContent = mode === 'situp' ? 'Lie down in view of the camera' : 'Face the camera';
            } else {
              gateMsg.textContent = 'Looking for you...';
            }
          }
        }
        const gateBorder = document.getElementById('cam-gate-border');
        const gateColor = d.gated === 'active' ? '#48bb78' : '#fc8181';
        if (gateBorder) gateBorder.style.borderColor = gateColor;
        else video.style.borderColor = gateColor;
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

    document.getElementById('cam-stop').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (btn.disabled) return;
      btn.disabled = true;
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
      const helpOverlay = document.createElement('div');
      helpOverlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:200;overflow-y:auto;display:flex;align-items:flex-start;justify-content:center';
      helpOverlay.innerHTML = `
        <div style="padding:24px 20px;max-width:400px;width:100%;position:relative;margin-top:20px">
          <button id="help-close" style="position:absolute;top:0;right:0;background:none;border:none;color:var(--text-dim);cursor:pointer;padding:8px;font-size:20px">&times;</button>
          <h2 style="text-align:center;margin-bottom:16px;${mode === 'opm' ? 'color:var(--one-punch)' : mode === 'situp' ? 'color:var(--info)' : ''}">${mode === 'opm' ? 'One Punch Mode' : mode === 'situp' ? 'Sit-up Mode' : 'Standard Mode'}</h2>
          ${getModeContent(mode)}
        </div>
      `;
      document.body.appendChild(helpOverlay);
      helpOverlay.querySelector('#help-close').addEventListener('click', () => helpOverlay.remove());
      helpOverlay.addEventListener('click', (e) => { if (e.target === helpOverlay) helpOverlay.remove(); });
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

// Pull-to-refresh: only active on the dashboard at scroll top. Re-fetches
// /api/me via loadDashboard() rather than a full page reload so we keep
// bundled state (cameraMode, pose model, etc.) warm.
(function () {
  const THRESHOLD = 60;
  const MAX_PULL = 80;
  let pulling = false;
  let startY = 0;
  let pullDist = 0;
  let refreshing = false;
  let indicator = null;
  let spinner = null;

  function onStart(e) {
    if (refreshing || currentScreen !== 'dashboard' || window.scrollY > 0) return;
    indicator = document.getElementById('pull-refresh');
    spinner = indicator?.querySelector('.pull-refresh-spinner');
    if (!indicator || !spinner) return;
    startY = (e.touches ? e.touches[0] : e).clientY;
    pulling = true;
    pullDist = 0;
  }

  function onMove(e) {
    if (!pulling || !indicator) return;
    const dy = (e.touches ? e.touches[0] : e).clientY - startY;
    if (dy <= 0) {
      pullDist = 0;
      indicator.style.height = '0px';
      return;
    }
    e.preventDefault();
    pullDist = Math.min(dy, MAX_PULL);
    indicator.style.height = pullDist + 'px';
    spinner.style.transform = 'rotate(' + (pullDist * 4) + 'deg)';
    indicator.classList.toggle('ready', pullDist >= THRESHOLD);
  }

  async function onEnd() {
    if (!pulling || !indicator) return;
    pulling = false;
    const ind = indicator;
    const spn = spinner;
    indicator = null;
    spinner = null;

    if (pullDist < THRESHOLD) {
      ind.classList.remove('ready');
      ind.style.height = '0px';
      spn.style.transform = '';
      pullDist = 0;
      return;
    }

    refreshing = true;
    ind.classList.remove('ready');
    ind.classList.add('refreshing');
    ind.style.height = '40px';
    spn.style.transform = '';
    try { await loadDashboard(); } catch {}
    ind.classList.remove('refreshing');
    ind.style.height = '0px';
    refreshing = false;
    pullDist = 0;
  }

  document.addEventListener('touchstart', onStart, { passive: true });
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', onEnd, { passive: true });
  document.addEventListener('touchcancel', onEnd, { passive: true });
})();
