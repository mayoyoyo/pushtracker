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

function initIcons() { if (window.lucide) lucide.createIcons(); }

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

function renderDashboard(app, data) {
  const pct = data.daily_target > 0 ? Math.min(100, (data.today_total / data.daily_target) * 100) : 0;

  app.innerHTML = `
    <div class="dashboard-header">
      <div>
        <div class="greeting-sub">Hey,</div>
        <div class="greeting-name">${data.username}</div>
      </div>
      <button class="settings-btn" id="settings-btn"><i data-lucide="settings" style="width:20px;height:20px"></i></button>
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
        <span class="icon"><i data-lucide="camera" style="width:22px;height:22px"></i></span><span class="label">Camera</span>
      </button>
      <button class="action-btn" id="btn-manual">
        <span class="icon"><i data-lucide="plus" style="width:22px;height:22px"></i></span><span class="label">Manual</span>
      </button>
      <button class="action-btn" id="btn-team">
        <span class="icon"><i data-lucide="users" style="width:22px;height:22px"></i></span><span class="label">Team</span>
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
  document.body.appendChild(overlay); initIcons();

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
        <button class="back-btn" id="back-dash"><i data-lucide="arrow-left" style="width:16px;height:16px;display:inline;vertical-align:middle"></i> Back</button>
      </div>
      ${team.map(m => {
        let statusClass = 'not-started';
        let display = `${m.today_total} / ${m.daily_target}`;
        if (m.daily_target > 0 && m.today_total >= m.daily_target) {
          statusClass = 'complete';
          display = `${m.today_total} <i data-lucide="check" style="width:16px;height:16px;display:inline"></i>`;
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

let cameraMode = 'noob'; // 'noob' or 'standard'

function showTutorial(onStart) {
  const app = document.getElementById('app');
  const isStd = cameraMode === 'standard';
  app.innerHTML = `
    <div class="camera-screen" style="background:var(--bg);overflow-y:auto">
      <div style="padding:24px 20px;max-width:400px;margin:0 auto">
        <h2 style="text-align:center;margin-bottom:8px">${isStd ? 'Standard Mode' : 'Noob Mode'}</h2>
        <div style="display:flex;justify-content:center;margin-bottom:16px">
          <div style="display:inline-flex;background:var(--surface-2);border-radius:8px;overflow:hidden">
            <button id="mode-noob" style="padding:8px 16px;border:none;font-size:13px;font-weight:500;cursor:pointer;background:${!isStd ? 'var(--primary)' : 'transparent'};color:${!isStd ? 'var(--primary-fg)' : 'var(--text)'}">Noob</button>
            <button id="mode-std" style="padding:8px 16px;border:none;font-size:13px;font-weight:500;cursor:pointer;background:${isStd ? 'var(--danger)' : 'transparent'};color:${isStd ? '#fff' : 'var(--text)'}">Standard</button>
          </div>
        </div>

        ${isStd ? `
        <div style="background:rgba(252,129,129,0.1);border:1px solid var(--danger);border-radius:10px;padding:14px 16px;margin-bottom:16px;text-align:center">
          <div style="font-size:15px;font-weight:700;color:var(--danger);margin-bottom:4px">Real ones only.</div>
          <div style="font-size:13px;color:var(--text-dim)">No knee pushups. No shortcuts. Full range of motion, verified.</div>
        </div>
        <div style="border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:16px">
          <div style="font-weight:600;margin-bottom:10px">Side-view setup:</div>
          <ul style="padding-left:18px;line-height:1.8;font-size:14px;color:var(--text-dim)">
            <li><strong style="color:var(--text)">Place camera to your side</strong> -- it needs to see your full profile</li>
            <li><strong style="color:var(--text)">Full body visible</strong> -- head to feet, including ankles</li>
            <li><strong style="color:var(--text)">Prop it 1-2 feet off the ground</strong> -- slightly elevated works best</li>
            <li><strong style="color:var(--text)">Wait for the chime</strong> -- a sound plays when the camera is ready</li>
          </ul>
        </div>
        <div style="border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:20px">
          <div style="font-weight:600;margin-bottom:10px">How it works:</div>
          <p style="font-size:14px;color:var(--text-dim);line-height:1.6">
            Tracks your shoulder movement from the side. Waits until it can see your full body, then counts reps by vertical shoulder displacement. Rejects knee pushups and camera movement.
          </p>
        </div>
        ` : `
        <div style="border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:16px">
          <div style="font-weight:600;margin-bottom:10px">Front-facing setup:</div>
          <ul style="padding-left:18px;line-height:1.8;font-size:14px;color:var(--text-dim)">
            <li><strong style="color:var(--text)">Face the camera</strong> -- place phone/laptop in front of you on the floor</li>
            <li><strong style="color:var(--text)">Camera sees your face + shoulders</strong> -- that's all it needs</li>
            <li><strong style="color:var(--text)">Stable surface</strong> -- don't bump the camera during your set</li>
            <li><strong style="color:var(--text)">Good lighting</strong> -- overhead or side lighting works best</li>
          </ul>
        </div>
        <div style="border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:20px">
          <div style="font-weight:600;margin-bottom:10px">How it works:</div>
          <p style="font-size:14px;color:var(--text-dim);line-height:1.6">
            Tracks your nose + shoulder vertical movement, elbow angle, and wrist stability. Easier to set up but allows knee pushups.
          </p>
        </div>
        `}

        <button class="btn btn-primary" style="width:100%;margin-bottom:10px" id="tut-start">Start Camera</button>
        <button class="btn btn-surface" style="width:100%" id="tut-back">Back</button>
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
    const DEV_VIEW = mode === 'standard';
    let sessionStartTime = null;
    let timerInterval = null;

    app.innerHTML = DEV_VIEW ? `
      <div class="camera-screen">
        <div class="camera-feed">
          <video id="cam-video" playsinline autoplay muted style="border:3px solid #fc8181;border-radius:8px"></video>
          <canvas id="cam-canvas"></canvas>
          <div class="tracking-badge hidden" id="cam-tracking">TRACKING</div>
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
          <div style="position:absolute;top:16px;left:16px;display:flex;gap:8px">
            <button class="prod-btn" id="cam-stop" title="Stop"><i data-lucide="square" style="width:16px;height:16px"></i></button>
            <button class="prod-btn" id="cam-flip" title="Flip camera"><i data-lucide="refresh-cw" style="width:16px;height:16px"></i></button>
          </div>
          <div style="position:absolute;top:16px;right:16px;display:flex;gap:8px;align-items:center">
            <div style="background:rgba(0,0,0,0.5);backdrop-filter:blur(8px);border-radius:20px;padding:6px 12px;font-size:12px;font-weight:600;color:#fff;display:flex;align-items:center;gap:6px">
              <i data-lucide="${mode === 'standard' ? 'move-horizontal' : 'user'}" style="width:14px;height:14px"></i>
              ${mode === 'standard' ? 'Side view' : 'Face camera'}
            </div>
            <button class="prod-btn" id="cam-help" title="Help">?</button>
          </div>
          <div id="cam-gate-msg" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;color:#fff;font-size:16px;font-weight:600;text-shadow:0 2px 8px rgba(0,0,0,0.8);pointer-events:none">
            Position yourself in frame...
          </div>
          <div style="position:absolute;bottom:0;left:0;right:0;padding:20px;text-align:center;background:linear-gradient(transparent, rgba(0,0,0,0.7))">
            <div id="cam-count" style="font-size:72px;font-weight:900;letter-spacing:-3px;line-height:1;color:#fff;text-shadow:0 2px 12px rgba(0,0,0,0.5)">0</div>
            <div style="font-size:14px;color:rgba(255,255,255,0.7);margin-top:2px">Reps</div>
            <div id="cam-timer" style="font-size:20px;font-weight:600;color:rgba(255,255,255,0.9);margin-top:4px;font-variant-numeric:tabular-nums">00:00</div>
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
              gateMsg.textContent = 'Position yourself in frame';
            } else {
              gateMsg.textContent = 'Looking for you...';
            }
          }
        }
        video.style.borderColor = d.gated === 'active' ? '#48bb78' : '#fc8181';
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
