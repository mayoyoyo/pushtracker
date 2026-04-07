let currentUser = null;
let currentScreen = 'loading';

let poseModule = null;
async function loadPose() {
  if (!poseModule) poseModule = await import('/pose.js');
  return poseModule;
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

function showScreen(name, data) {
  currentScreen = name;
  const app = document.getElementById('app');
  switch (name) {
    case 'auth': renderAuth(app); break;
    case 'dashboard': renderDashboard(app, data); break;
    case 'camera': renderCamera(app); break;
    case 'team': renderTeam(app); break;
    default: app.innerHTML = '<p>Loading...</p>';
  }
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
          const data = await api('POST', '/api/auth/signup', { username, passcode, timezone: tz });
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

function renderDashboard(app, data) {
  const pct = data.daily_target > 0 ? Math.min(100, (data.today_total / data.daily_target) * 100) : 0;

  app.innerHTML = `
    <div class="dashboard-header">
      <div>
        <div class="greeting-sub">Hey,</div>
        <div class="greeting-name">${data.username}</div>
      </div>
      <button class="settings-btn" id="settings-btn">&#9881;</button>
    </div>
    <div class="progress-card">
      <div class="progress-label">Today</div>
      <div class="progress-count">${data.today_total} <span class="progress-target">/ ${data.daily_target}</span></div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
    </div>
    ${data.debt > 0 ? `
    <div class="debt-card">
      <div><div style="font-size:11px;text-transform:uppercase;color:var(--text-dim)">Debt</div><div class="debt-count">${data.debt}</div></div>
      <div class="debt-label">pushups<br>owed</div>
    </div>` : ''}
    <div class="action-buttons">
      <button class="action-btn primary" id="btn-camera">
        <span class="icon">&#128247;</span><span class="label">Camera</span>
      </button>
      <button class="action-btn" id="btn-manual">
        <span class="icon">&#9998;</span><span class="label">Manual</span>
      </button>
      <button class="action-btn" id="btn-team">
        <span class="icon">&#128101;</span><span class="label">Team</span>
      </button>
    </div>
  `;

  app.querySelector('#btn-camera').addEventListener('click', () => showScreen('camera'));
  app.querySelector('#btn-manual').addEventListener('click', () => showManualEntry());
  app.querySelector('#btn-team').addEventListener('click', () => showScreen('team'));
  app.querySelector('#settings-btn').addEventListener('click', () => showSettings());
}

function showManualEntry() {
  let count = 10;
  const overlay = document.createElement('div');
  overlay.className = 'manual-entry';
  overlay.innerHTML = `
    <div class="manual-card">
      <h3>Log Pushups</h3>
      <div class="stepper">
        <button id="step-down">\u2212</button>
        <div class="value" id="step-val">${count}</div>
        <button id="step-up">+</button>
      </div>
      <button class="btn btn-primary" style="width:100%;margin-bottom:10px" id="step-save">Save</button>
      <button class="btn btn-surface" style="width:100%" id="step-cancel">Cancel</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const valEl = overlay.querySelector('#step-val');
  overlay.querySelector('#step-down').addEventListener('click', () => { count = Math.max(1, count - 5); valEl.textContent = count; });
  overlay.querySelector('#step-up').addEventListener('click', () => { count += 5; valEl.textContent = count; });
  overlay.querySelector('#step-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#step-save').addEventListener('click', async () => {
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
      <h3>Settings</h3>
      <div class="setting-row">
        <span class="setting-label">Daily Target</span>
        <div class="setting-value"><input type="number" id="set-target" value="${currentUser.daily_target}" inputmode="numeric"></div>
      </div>
      <div class="setting-row">
        <span class="setting-label">Timezone</span>
        <span style="font-size:13px;color:var(--text-dim)">${currentUser.timezone}</span>
      </div>
      <button class="btn btn-primary" style="width:100%;margin-top:16px;margin-bottom:10px" id="set-save">Save</button>
      <button class="btn btn-danger" style="width:100%;margin-bottom:10px" id="set-logout">Log Out</button>
      <button class="btn btn-surface" style="width:100%" id="set-close">Close</button>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('#set-save').addEventListener('click', async () => {
    const target = parseInt(overlay.querySelector('#set-target').value) || 0;
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

async function renderTeam(app) {
  const team = await api('GET', '/api/team/today');
  team.sort((a, b) => {
    const aDone = a.daily_target > 0 && a.today_total >= a.daily_target;
    const bDone = b.daily_target > 0 && b.today_total >= b.daily_target;
    if (aDone !== bDone) return aDone ? 1 : -1;
    return a.username.localeCompare(b.username);
  });

  app.innerHTML = `
    <div class="team-screen">
      <div class="team-header">
        <h2>Team</h2>
        <button class="back-btn" id="back-dash">&larr; Back</button>
      </div>
      ${team.map(m => {
        let statusClass = 'not-started';
        let display = `${m.today_total} / ${m.daily_target}`;
        if (m.daily_target > 0 && m.today_total >= m.daily_target) {
          statusClass = 'complete';
          display = `${m.today_total} &#10004;`;
        } else if (m.today_total > 0) {
          statusClass = 'in-progress';
        }
        return `
          <div class="team-member">
            <div>
              <div class="member-name">${m.username}</div>
              <div class="member-target">Target: ${m.daily_target}</div>
              ${m.debt > 0 ? `<div class="member-debt">Debt: ${m.debt}</div>` : ''}
            </div>
            <div class="member-progress ${statusClass}">${display}</div>
          </div>`;
      }).join('')}
    </div>
  `;

  app.querySelector('#back-dash').addEventListener('click', () => loadDashboard());
}

async function renderCamera(app) {
  let facingMode = 'user';
  let stream = null;
  let tracker = null;

  app.innerHTML = `
    <div class="camera-screen">
      <div class="camera-feed">
        <video id="cam-video" playsinline autoplay muted></video>
        <canvas id="cam-canvas"></canvas>
        <div class="tracking-badge hidden" id="cam-tracking">TRACKING</div>
      </div>
      <div class="camera-counter">
        <div class="count" id="cam-count">0</div>
        <div class="count-label">pushups detected</div>
      </div>
      <div class="camera-controls">
        <button class="btn btn-danger" id="cam-stop">Stop &amp; Save</button>
        <button class="btn-flip" id="cam-flip">&#128260;</button>
      </div>
    </div>
  `;

  const video = document.getElementById('cam-video');
  const canvas = document.getElementById('cam-canvas');
  const countEl = document.getElementById('cam-count');
  const trackingBadge = document.getElementById('cam-tracking');
  let trackingInterval;

  async function startCamera() {
    const pose = await loadPose();
    await pose.initPoseDetection();
    stream = await pose.getCamera(facingMode);
    video.srcObject = stream;
    await video.play();

    tracker = pose.startTracking(video, canvas, (count) => {
      countEl.textContent = count;
    });

    trackingInterval = setInterval(() => {
      if (tracker && tracker.isTracking()) {
        trackingBadge.classList.remove('hidden');
      } else {
        trackingBadge.classList.add('hidden');
      }
    }, 500);
  }

  function stopCamera() {
    if (trackingInterval) clearInterval(trackingInterval);
    if (tracker) tracker.stop();
    if (stream) stream.getTracks().forEach(t => t.stop());
  }

  document.getElementById('cam-stop').addEventListener('click', async () => {
    const count = tracker ? tracker.getCount() : 0;
    stopCamera();
    if (count > 0) {
      await api('POST', '/api/pushups', { count, source: 'camera' });
      showToast(`Saved ${count} pushups`);
    }
    await loadDashboard();
  });

  document.getElementById('cam-flip').addEventListener('click', async () => {
    stopCamera();
    facingMode = facingMode === 'user' ? 'environment' : 'user';
    await startCamera();
  });

  try {
    await startCamera();
  } catch (err) {
    showToast('Camera access denied. Please allow camera permissions.');
    await loadDashboard();
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
