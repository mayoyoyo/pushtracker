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

function showTutorial(onStart) {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="camera-screen" style="background:var(--bg);overflow-y:auto">
      <div style="padding:24px 20px;max-width:400px;margin:0 auto">
        <h2 style="text-align:center;margin-bottom:16px">Camera Setup</h2>

        <div style="margin-bottom:20px">
          <svg viewBox="0 0 400 280" style="width:100%;border-radius:10px;background:#1a1a2e">
            <!-- Floor line -->
            <line x1="20" y1="240" x2="380" y2="240" stroke="#4a5568" stroke-width="2"/>

            <!-- Phone/laptop on floor facing user -->
            <rect x="170" y="210" width="60" height="30" rx="4" fill="none" stroke="#718096" stroke-width="2"/>
            <circle cx="200" cy="218" r="4" fill="#718096"/>
            <text x="172" y="255" fill="#718096" font-size="10">Your phone</text>
            <!-- Camera view cone -->
            <path d="M 200 215 L 130 100 L 270 100" stroke="#718096" stroke-width="1" fill="#718096" opacity="0.06"/>

            <!-- Person UP position (facing camera) -->
            <circle cx="200" cy="115" r="16" fill="#48bb78" opacity="0.3"/>
            <circle cx="200" cy="115" r="16" stroke="#48bb78" stroke-width="2" fill="none"/>
            <!-- Shoulders -->
            <line x1="170" y1="138" x2="230" y2="138" stroke="#3182ce" stroke-width="3"/>
            <!-- Arms going down -->
            <line x1="170" y1="138" x2="155" y2="175" stroke="#3182ce" stroke-width="2"/>
            <line x1="230" y1="138" x2="245" y2="175" stroke="#3182ce" stroke-width="2"/>
            <!-- Joints -->
            <circle cx="170" cy="138" r="4" fill="#48bb78"/>
            <circle cx="230" cy="138" r="4" fill="#48bb78"/>
            <text x="255" y="125" fill="#48bb78" font-size="13" font-weight="bold">UP</text>

            <!-- Person DOWN position (closer to camera = lower + bigger) -->
            <circle cx="200" cy="160" r="18" fill="#fc8181" opacity="0.1"/>
            <circle cx="200" cy="160" r="18" stroke="#fc8181" stroke-width="2" fill="none" opacity="0.4" stroke-dasharray="4"/>
            <line x1="160" y1="185" x2="240" y2="185" stroke="#fc8181" stroke-width="2" opacity="0.3" stroke-dasharray="4"/>
            <text x="255" y="168" fill="#fc8181" font-size="13" font-weight="bold" opacity="0.5">DOWN</text>

            <!-- Arrow showing vertical motion -->
            <path d="M 140 120 L 140 165" stroke="#ecc94b" stroke-width="2" fill="none" marker-end="url(#arrow)"/>
            <path d="M 135 165 L 135 120" stroke="#ecc94b" stroke-width="2" fill="none" marker-end="url(#arrow)" opacity="0.5"/>
            <defs><marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#ecc94b"/></marker></defs>

            <text x="80" y="80" fill="#e2e8f0" font-size="12" opacity="0.5">Camera sees you</text>
            <text x="80" y="95" fill="#e2e8f0" font-size="12" opacity="0.5">move up and down</text>
          </svg>
        </div>

        <div style="background:var(--surface);border-radius:10px;padding:16px;margin-bottom:16px">
          <div style="font-weight:600;margin-bottom:10px">Setup:</div>
          <ul style="padding-left:18px;line-height:1.8;font-size:14px;color:var(--text-dim)">
            <li><strong style="color:var(--text)">Face the camera</strong> -- place phone/laptop on the floor in front of you, screen facing up</li>
            <li><strong style="color:var(--text)">Camera sees your face + shoulders</strong> -- that's all it needs</li>
            <li><strong style="color:var(--text)">Stable surface</strong> -- don't bump the camera during your set</li>
            <li><strong style="color:var(--text)">Good lighting</strong> -- overhead or side lighting works best</li>
          </ul>
        </div>

        <div style="background:var(--surface);border-radius:10px;padding:16px;margin-bottom:20px">
          <div style="font-weight:600;margin-bottom:10px">How it works:</div>
          <p style="font-size:14px;color:var(--text-dim);line-height:1.6">
            The AI tracks your nose/shoulders. As you go down, they move lower in the frame. As you push up, they rise. Each full dip-and-return = 1 pushup. No special angle needed -- just go down and come back up.
          </p>
        </div>

        <button class="btn btn-primary" style="width:100%;margin-bottom:10px" id="tut-start">Start Camera</button>
        <button class="btn btn-surface" style="width:100%" id="tut-back">Back</button>
      </div>
    </div>
  `;

  document.getElementById('tut-start').addEventListener('click', onStart);
  document.getElementById('tut-back').addEventListener('click', () => loadDashboard());
}

async function renderCamera(app) {
  // Show tutorial first
  showTutorial(() => startCameraSession());

  async function startCameraSession() {
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
        <div id="cam-debug-panel" style="background:rgba(0,0,0,0.85);padding:8px 12px;font-family:monospace;font-size:11px;line-height:1.6;color:#e2e8f0">
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:4px">
            <span>nose: <strong id="d-nose" style="color:#ecc94b">--</strong></span>
            <span>shld: <strong id="d-shld" style="color:#63b3ed">--</strong></span>
            <span>elb: <strong id="d-elbow" style="color:#48bb78">--</strong></span>
            <span>minE: <strong id="d-minelbow" style="color:#fc8181">--</strong></span>
            <span>wVar: <strong id="d-wvar" style="color:#d69e2e">--</strong></span>
          </div>
          <div style="display:flex;gap:12px;align-items:center">
            <span>phase: <strong id="d-phase" style="color:#48bb78">--</strong></span>
            <span>gate: <strong id="d-gate" style="color:#fc8181">--</strong></span>
            <span>count: <strong id="d-count" style="color:#fff;font-size:14px">0</strong></span>
          </div>
          <div style="margin-top:4px">
            <div style="display:flex;align-items:center;gap:6px">
              <span style="font-size:10px;width:18px">y</span>
              <div style="flex:1;height:12px;background:#2d3748;border-radius:3px;position:relative;overflow:hidden">
                <div id="d-bar-base" style="position:absolute;top:0;width:2px;height:100%;background:#718096" title="baseline"></div>
                <div id="d-bar-peak" style="position:absolute;top:0;width:2px;height:100%;background:#fc8181" title="peak (lowest)"></div>
                <div id="d-bar-y" style="position:absolute;top:0;width:4px;height:100%;background:#48bb78;border-radius:2px" title="current y"></div>
              </div>
            </div>
          </div>
        </div>
        <div class="camera-counter">
          <div class="count" id="cam-count">0</div>
          <div class="count-label">pushups detected</div>
        </div>
        <div class="camera-controls">
          <button class="btn btn-danger" id="cam-stop">Stop &amp; Save</button>
          <button class="btn-flip" id="cam-flip" title="Flip camera">&#128260;</button>
          <button class="btn-flip" id="cam-log" title="Copy debug log">LOG</button>
          <button class="btn-flip" id="cam-help" title="Help">?</button>
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
      }, (d) => {
        document.getElementById('d-nose').textContent = d.noseDip;
        document.getElementById('d-shld').textContent = d.shoulderDip;
        document.getElementById('d-elbow').textContent = d.elbowAngle;
        document.getElementById('d-minelbow').textContent = d.minElbow;
        document.getElementById('d-wvar').textContent = d.wristVar || '--';
        document.getElementById('d-phase').textContent = d.phase;
        document.getElementById('d-phase').style.color = d.phase === 'DESCENDING' ? '#fc8181' : d.phase === 'ASCENDING' ? '#ecc94b' : '#48bb78';
        document.getElementById('d-gate').textContent = d.gated;
        document.getElementById('d-gate').style.color = d.gated === 'active' ? '#48bb78' : '#fc8181';
        document.getElementById('d-count').textContent = d.count;
        const noseNum = parseFloat(d.noseY) || 0;
        const noseBase = parseFloat(d.noseBase) || 0;
        const shldNum = parseFloat(d.shoulderY) || 0;
        document.getElementById('d-bar-y').style.left = (noseNum * 100) + '%';
        document.getElementById('d-bar-base').style.left = (noseBase * 100) + '%';
        document.getElementById('d-bar-peak').style.left = (shldNum * 100) + '%';
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

    document.getElementById('cam-log').addEventListener('click', () => {
      if (tracker) {
        const log = tracker.getLog();
        const text = log.map(e => JSON.stringify(e)).join('\n');
        navigator.clipboard.writeText(text).then(() => {
          showToast('Debug log copied to clipboard (' + log.length + ' events)');
        }).catch(() => {
          // Fallback: show in alert
          prompt('Copy this debug log:', text);
        });
      }
    });

    document.getElementById('cam-help').addEventListener('click', () => {
      stopCamera();
      showTutorial(() => startCameraSession());
    });

    try {
      await startCamera();
    } catch (err) {
      showToast('Camera access denied. Please allow camera permissions.');
      await loadDashboard();
    }
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
