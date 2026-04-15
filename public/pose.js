import { FilesetResolver, PoseLandmarker, DrawingUtils } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/vision_bundle.mjs';

let poseLandmarker = null;
let animationFrameId = null;

const MIN_VISIBILITY = 0.5;
const SMOOTHING_WINDOW = 9;

function playTone(freq, duration, type = 'sine') {
  // Use the shared ctx from app.js so we inherit the iOS PWA unlock +
  // navigator.audioSession.type = "playback" routing. Without this, every
  // tone created a fresh ctx that got silenced by the iOS silent switch.
  const ctx = window.getAudioContext ? window.getAudioContext() : new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.value = 0.3;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  osc.stop(ctx.currentTime + duration);
}

export async function initPoseDetection() {
  if (poseLandmarker) return poseLandmarker;
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm'
  );
  poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numPoses: 1,
  });
  return poseLandmarker;
}

function calculateAngle(a, b, c) {
  const radians = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x);
  let angle = Math.abs(radians * 180 / Math.PI);
  if (angle > 180) angle = 360 - angle;
  return angle;
}

function smoothValue(buffer, newValue) {
  buffer.push(newValue);
  if (buffer.length > SMOOTHING_WINDOW) buffer.shift();
  return buffer.reduce((a, b) => a + b, 0) / buffer.length;
}

function getBestElbowAngle(landmarks) {
  const lVis = Math.min(landmarks[11].visibility, landmarks[13].visibility, landmarks[15].visibility);
  const rVis = Math.min(landmarks[12].visibility, landmarks[14].visibility, landmarks[16].visibility);
  let angle = null;
  if (lVis > MIN_VISIBILITY) angle = calculateAngle(landmarks[11], landmarks[13], landmarks[15]);
  if (rVis > MIN_VISIBILITY && rVis > lVis) angle = calculateAngle(landmarks[12], landmarks[14], landmarks[16]);
  return angle;
}

function drawSkeleton(ctx, landmarks) {
  const drawingUtils = new DrawingUtils(ctx);
  drawingUtils.drawLandmarks(landmarks, { radius: 3, color: '#48bb78', fillColor: '#48bb78' });
  drawingUtils.drawConnectors(landmarks, PoseLandmarker.POSE_CONNECTIONS, { color: '#3182ce', lineWidth: 2 });
}

// ============================================================
// STANDARD MODE — Front-facing, nose/shoulder dip + elbow + wrist
// ============================================================
function startStandardTracking(video, canvas, onCount, onDebug) {
  const ctx = canvas.getContext('2d');
  let count = 0, tracking = false, frameNum = 0;
  const noseYBuf = [], shoulderYBuf = [], elbowBuf = [];
  let phase = 'READY', nosePeakY = 0, noseBaseY = 0, shoulderBaseY = 0, shoulderPeakY = 0;
  let minElbow = 180, wristSamples = [];
  const MAX_WRIST_VAR = 0.015, MIN_DIP = 0.04, MAX_ELBOW = 130;
  const READY_FRAMES_NEEDED = 30, LOST_FRAMES_THRESHOLD = 30;
  let gateState = 'NOT_READY', gateFrames = 0, lostFrames = 0;
  const eventLog = [];
  function log(type, data) { eventLog.push({ t: (performance.now()/1000).toFixed(2), frame: frameNum, type, ...data }); if (eventLog.length > 200) eventLog.shift(); }

  function standardLandmarksVisible(lm) {
    const noseVis = lm[0].visibility;
    // Require at least one full arm (shoulder+elbow+wrist) visible
    const lArmVis = Math.min(lm[11].visibility, lm[13].visibility, lm[15].visibility);
    const rArmVis = Math.min(lm[12].visibility, lm[14].visibility, lm[16].visibility);
    return noseVis > MIN_VISIBILITY && Math.max(lArmVis, rArmVis) > MIN_VISIBILITY;
  }

  function processFrame() {
    if (!poseLandmarker || video.paused || video.ended) { animationFrameId = requestAnimationFrame(processFrame); return; }
    frameNum++;
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const result = poseLandmarker.detectForVideo(video, performance.now());
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!result.landmarks || result.landmarks.length === 0) {
      tracking = false;
      if (gateState === 'READY') {
        lostFrames++;
        if (lostFrames >= LOST_FRAMES_THRESHOLD) {
          gateState = 'NOT_READY';
          gateFrames = 0;
          phase = 'READY';
          noseYBuf.length = 0; shoulderYBuf.length = 0; elbowBuf.length = 0;
          noseBaseY = 0;
          playTone(330, 0.3);
          log('PAUSED', { reason: 'landmarks-lost' });
        }
      }
      if (onDebug) onDebug({ phase, count, gated: gateState === 'READY' ? 'pausing' : 'no-pose', mode: 'STANDARD' });
      animationFrameId = requestAnimationFrame(processFrame);
      return;
    }

    const lm = result.landmarks[0];
    tracking = true;
    drawSkeleton(ctx, lm);

    // --- READY GATE ---
    if (gateState === 'NOT_READY') {
      if (standardLandmarksVisible(lm)) {
        gateFrames++;
      } else {
        gateFrames = 0;
      }

      const missing = [];
      if (lm[0].visibility <= MIN_VISIBILITY) missing.push('nose');
      const lArmOk = Math.min(lm[11].visibility, lm[13].visibility, lm[15].visibility) > MIN_VISIBILITY;
      const rArmOk = Math.min(lm[12].visibility, lm[14].visibility, lm[16].visibility) > MIN_VISIBILITY;
      if (!lArmOk && !rArmOk) missing.push('arms');

      if (onDebug) onDebug({ gateProgress: `${gateFrames}/${READY_FRAMES_NEEDED}`, missing: missing.join(',') || 'none', phase: 'SETUP', count, gated: 'not-ready', mode: 'STANDARD' });

      if (gateFrames >= READY_FRAMES_NEEDED) {
        gateState = 'READY';
        lostFrames = 0;
        noseBaseY = 0;
        playTone(880, 0.15);
        setTimeout(() => playTone(1100, 0.15), 170);
        log('READY', {});
      }
      animationFrameId = requestAnimationFrame(processFrame);
      return;
    }

    // --- TRACKING (gate is READY) ---
    if (!standardLandmarksVisible(lm)) {
      lostFrames++;
      if (lostFrames >= LOST_FRAMES_THRESHOLD) {
        gateState = 'NOT_READY';
        gateFrames = 0;
        phase = 'READY';
        noseYBuf.length = 0; shoulderYBuf.length = 0; elbowBuf.length = 0;
        noseBaseY = 0;
        playTone(330, 0.3);
        log('PAUSED', { reason: 'landmarks-lost' });
      }
      if (onDebug) onDebug({ phase, count, gated: 'losing-landmarks', mode: 'STANDARD' });
      animationFrameId = requestAnimationFrame(processFrame);
      return;
    }

    lostFrames = 0;

    const sY = smoothValue(shoulderYBuf, (lm[11].y + lm[12].y) / 2);
    const nY = smoothValue(noseYBuf, lm[0].y);
    const rawElbow = getBestElbowAngle(lm);
    const elbow = rawElbow !== null ? Math.round(smoothValue(elbowBuf, rawElbow)) : null;

    // Wrist y
    let wY = null;
    if (lm[15].visibility > MIN_VISIBILITY && lm[16].visibility > MIN_VISIBILITY) wY = (lm[15].y + lm[16].y) / 2;
    else if (lm[15].visibility > MIN_VISIBILITY) wY = lm[15].y;
    else if (lm[16].visibility > MIN_VISIBILITY) wY = lm[16].y;

    if (noseBaseY === 0) { noseBaseY = nY; nosePeakY = nY; shoulderBaseY = sY; shoulderPeakY = sY; }

    const noseDip = nY - noseBaseY;
    const shoulderDip = sY - shoulderBaseY;
    const noseReturn = nosePeakY - nY;

    // Track during descent
    if (phase !== 'READY') {
      if (elbow !== null && elbow < minElbow) minElbow = elbow;
      if (wY !== null) wristSamples.push(wY);
    }

    let wVar = '--';
    if (wristSamples.length >= 3) { const m = wristSamples.reduce((a,b)=>a+b,0)/wristSamples.length; wVar = Math.sqrt(wristSamples.reduce((s,v)=>s+(v-m)**2,0)/wristSamples.length).toFixed(4); }

    if (onDebug) onDebug({ noseDip: noseDip.toFixed(3), shoulderDip: shoulderDip.toFixed(3), elbow: elbow ?? '--', minElbow: phase !== 'READY' ? minElbow : '--', wVar, phase, count, gated: 'active', mode: 'STANDARD', depth: Math.min(1, Math.max(0, noseDip / (MIN_DIP * 1.5))), depthThreshold: 1 / 1.5 });

    if (phase === 'READY') {
      noseBaseY = nY * 0.05 + noseBaseY * 0.95;
      shoulderBaseY = sY * 0.05 + shoulderBaseY * 0.95;
      if (noseDip > MIN_DIP * 0.5) {
        phase = 'DESCENDING'; nosePeakY = nY; shoulderPeakY = sY; minElbow = elbow ?? 180; wristSamples = [];
        log('DESCEND', { nY: nY.toFixed(3), sY: sY.toFixed(3), elbow });
      }
    }

    if (phase === 'DESCENDING') {
      if (nY > nosePeakY) nosePeakY = nY;
      if (sY > shoulderPeakY) shoulderPeakY = sY;
      const nTotal = nosePeakY - noseBaseY;
      if (noseReturn > MIN_DIP * 0.3 && nTotal > MIN_DIP) {
        const sTotal = shoulderPeakY - shoulderBaseY;
        const sOk = sTotal > MIN_DIP * 0.5;
        const eOk = minElbow <= MAX_ELBOW;
        let wOk = false;
        if (wristSamples.length >= 3) { const m = wristSamples.reduce((a,b)=>a+b,0)/wristSamples.length; const v = Math.sqrt(wristSamples.reduce((s,x)=>s+(x-m)**2,0)/wristSamples.length); wOk = v <= MAX_WRIST_VAR; }
        if (sOk && eOk && wOk) {
          phase = 'ASCENDING';
          log('ASCEND', { noseDip: nTotal.toFixed(3), shoulderDip: sTotal.toFixed(3), minElbow });
        } else {
          const reason = !sOk ? 'shoulder' : minElbow >= 180 ? 'no-elbow' : !eOk ? 'elbow-straight' : wristSamples.length < 3 ? 'no-wrist' : 'wrist-moved';
          log('REJECT', { reason, noseDip: nTotal.toFixed(3), shoulderDip: sTotal.toFixed(3), minElbow, wVar });
          phase = 'READY'; noseBaseY = nY; nosePeakY = nY; shoulderBaseY = sY; shoulderPeakY = sY;
        }
      }
    }

    if (phase === 'ASCENDING') {
      const nTotal = nosePeakY - noseBaseY;
      if (noseReturn > nTotal * 0.6) {
        count++; onCount(count); playTone(660, 0.1);
        log('COUNT', { n: count, noseDip: nTotal.toFixed(3), minElbow });
        phase = 'READY'; noseBaseY = nY; nosePeakY = nY; shoulderBaseY = sY; shoulderPeakY = sY; minElbow = 180; wristSamples = [];
      }
    }

    animationFrameId = requestAnimationFrame(processFrame);
  }
  animationFrameId = requestAnimationFrame(processFrame);
  return { getCount: () => count, isTracking: () => tracking, getLog: () => eventLog, stop: () => { if (animationFrameId) cancelAnimationFrame(animationFrameId); animationFrameId = null; } };
}

// ============================================================
// OPM MODE — Side view, elbow angle + body alignment + no kneeling
// ============================================================
function startOpmTracking(video, canvas, onCount, onDebug) {
  const ctx = canvas.getContext('2d');
  let count = 0, tracking = false, frameNum = 0;
  const shoulderYBuf = [];

  // Thresholds
  const MIN_DIP = 0.03;
  const MIN_FRAMES = 10;
  const MAX_ANKLE_VAR = 0.06;
  const MIN_KNEE_ANGLE = 120;
  const READY_FRAMES_NEEDED = 30;
  const LOST_FRAMES_THRESHOLD = 30;

  // Ready gate state
  let gateState = 'NOT_READY'; // NOT_READY | READY
  let gateFrames = 0; // consecutive frames with all landmarks visible
  let lostFrames = 0; // consecutive frames with landmarks missing

  // Tracking state
  let phase = 'READY'; // READY | DESCENDING | ASCENDING
  let shoulderBaseY = 0, shoulderPeakY = 0;
  let descentStartFrame = 0;
  let ankleYSamples = [];

  const eventLog = [];
  function log(type, data) { eventLog.push({ t: (performance.now()/1000).toFixed(2), frame: frameNum, type, ...data }); if (eventLog.length > 200) eventLog.shift(); }

  function pickSide(lm) {
    const lVis = (lm[11].visibility + lm[13].visibility + lm[15].visibility) / 3;
    const rVis = (lm[12].visibility + lm[14].visibility + lm[16].visibility) / 3;
    if (lVis >= rVis) return { shoulder: lm[11], elbow: lm[13], wrist: lm[15], hip: lm[23], knee: lm[25], ankle: lm[27], vis: lVis };
    return { shoulder: lm[12], elbow: lm[14], wrist: lm[16], hip: lm[24], knee: lm[26], ankle: lm[28], vis: rVis };
  }

  function kneeAngle(side) {
    if (side.hip.visibility < MIN_VISIBILITY || side.knee.visibility < MIN_VISIBILITY || side.ankle.visibility < MIN_VISIBILITY) return null;
    return calculateAngle(side.hip, side.knee, side.ankle);
  }

  function allLandmarksVisible(side) {
    return side.shoulder.visibility > MIN_VISIBILITY
      && side.hip.visibility > MIN_VISIBILITY
      && side.knee.visibility > MIN_VISIBILITY
      && side.ankle.visibility > MIN_VISIBILITY;
  }

  function processFrame() {
    if (!poseLandmarker || video.paused || video.ended) { animationFrameId = requestAnimationFrame(processFrame); return; }
    frameNum++;
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const result = poseLandmarker.detectForVideo(video, performance.now());
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!result.landmarks || result.landmarks.length === 0) {
      tracking = false;
      if (gateState === 'READY') {
        lostFrames++;
        if (lostFrames >= LOST_FRAMES_THRESHOLD) {
          gateState = 'NOT_READY';
          gateFrames = 0;
          phase = 'READY';
          shoulderYBuf.length = 0;
          playTone(330, 0.3); // low alert tone
          log('PAUSED', { reason: 'landmarks-lost' });
        }
      }
      if (onDebug) onDebug({ phase, count, gated: gateState === 'READY' ? 'pausing' : 'no-pose', mode: 'OPM' });
      animationFrameId = requestAnimationFrame(processFrame);
      return;
    }

    const lm = result.landmarks[0];
    tracking = true;
    drawSkeleton(ctx, lm);
    const side = pickSide(lm);

    // --- READY GATE ---
    if (gateState === 'NOT_READY') {
      if (allLandmarksVisible(side)) {
        gateFrames++;
      } else {
        gateFrames = 0;
      }

      const missing = [];
      if (side.shoulder.visibility <= MIN_VISIBILITY) missing.push('shoulder');
      if (side.hip.visibility <= MIN_VISIBILITY) missing.push('hip');
      if (side.knee.visibility <= MIN_VISIBILITY) missing.push('knee');
      if (side.ankle.visibility <= MIN_VISIBILITY) missing.push('ankle');

      if (onDebug) onDebug({ gateProgress: `${gateFrames}/${READY_FRAMES_NEEDED}`, missing: missing.join(',') || 'none', phase: 'SETUP', count, gated: 'not-ready', mode: 'OPM' });

      if (gateFrames >= READY_FRAMES_NEEDED) {
        gateState = 'READY';
        lostFrames = 0;
        shoulderBaseY = side.shoulder.y;
        shoulderPeakY = side.shoulder.y;
        shoulderYBuf.length = 0;
        phase = 'READY';
        playTone(880, 0.15); // high ready chime
        setTimeout(() => playTone(1100, 0.15), 170);
        log('READY', { shoulderY: side.shoulder.y.toFixed(3) });
      }
      animationFrameId = requestAnimationFrame(processFrame);
      return;
    }

    // --- TRACKING (gate is READY) ---
    // Check if landmarks are still visible
    if (!allLandmarksVisible(side)) {
      lostFrames++;
      if (lostFrames >= LOST_FRAMES_THRESHOLD) {
        gateState = 'NOT_READY';
        gateFrames = 0;
        phase = 'READY';
        shoulderYBuf.length = 0;
        playTone(330, 0.3);
        log('PAUSED', { reason: 'landmarks-lost' });
      }
      if (onDebug) onDebug({ phase, count, gated: 'losing-landmarks', mode: 'OPM' });
      animationFrameId = requestAnimationFrame(processFrame);
      return;
    }

    lostFrames = 0;

    const smoothedShoulderY = smoothValue(shoulderYBuf, side.shoulder.y);
    const kAngle = kneeAngle(side);
    const shoulderDip = smoothedShoulderY - shoulderBaseY;

    // Track ankle during descent
    if (phase === 'DESCENDING') {
      if (smoothedShoulderY > shoulderPeakY) shoulderPeakY = smoothedShoulderY;
      ankleYSamples.push(side.ankle.y);
    }

    // Live stats
    let ankleVar = '--';
    if (ankleYSamples.length >= 3) { const m = ankleYSamples.reduce((a,b)=>a+b,0)/ankleYSamples.length; ankleVar = Math.sqrt(ankleYSamples.reduce((s,v)=>s+(v-m)**2,0)/ankleYSamples.length).toFixed(4); }

    if (onDebug) onDebug({ sDip: shoulderDip.toFixed(3), ankleVar, kneeAng: kAngle !== null ? Math.round(kAngle) : '--', phase, count, gated: 'active', mode: 'OPM', depth: Math.min(1, Math.max(0, shoulderDip / (MIN_DIP * 1.5))), depthThreshold: 1 / 1.5 });

    // --- PHASE MACHINE ---
    if (phase === 'READY') {
      // Adapt baseline slowly
      shoulderBaseY = smoothedShoulderY * 0.05 + shoulderBaseY * 0.95;
      if (shoulderDip > MIN_DIP * 0.5) {
        phase = 'DESCENDING';
        descentStartFrame = frameNum;
        shoulderPeakY = smoothedShoulderY;
        ankleYSamples = [];
        log('DESCEND', { shoulderY: smoothedShoulderY.toFixed(3), baseline: shoulderBaseY.toFixed(3) });
      }
    }

    if (phase === 'DESCENDING') {
      const totalDip = shoulderPeakY - shoulderBaseY;
      const returnAmt = shoulderPeakY - smoothedShoulderY;

      if (returnAmt > totalDip * 0.3 && totalDip > MIN_DIP) {
        const frames = frameNum - descentStartFrame;

        // Ankle variance
        let aVar = 0;
        if (ankleYSamples.length >= 3) { const m = ankleYSamples.reduce((a,b)=>a+b,0)/ankleYSamples.length; aVar = Math.sqrt(ankleYSamples.reduce((s,v)=>s+(v-m)**2,0)/ankleYSamples.length); }

        let reason = null;
        if (frames < MIN_FRAMES) reason = 'too-fast';
        else if (aVar > MAX_ANKLE_VAR) reason = 'camera-move';
        else if (kAngle !== null && kAngle < MIN_KNEE_ANGLE) reason = 'kneeling';

        if (reason) {
          log('REJECT', { reason, frames, sDip: totalDip.toFixed(3), ankleVar: aVar.toFixed(4), kneeAngle: kAngle !== null ? Math.round(kAngle) : '--' });
          phase = 'READY'; shoulderBaseY = smoothedShoulderY; shoulderPeakY = smoothedShoulderY; ankleYSamples = [];
        } else {
          phase = 'ASCENDING';
          log('ASCEND', { sDip: totalDip.toFixed(3), ankleVar: aVar.toFixed(4), kneeAngle: kAngle !== null ? Math.round(kAngle) : '--' });
        }
      }
    }

    if (phase === 'ASCENDING') {
      if (smoothedShoulderY > shoulderPeakY) shoulderPeakY = smoothedShoulderY;
      const totalDip = shoulderPeakY - shoulderBaseY;
      const returnAmt = shoulderPeakY - smoothedShoulderY;
      const ascendFrames = frameNum - descentStartFrame;
      if (returnAmt > totalDip * 0.4) {
        count++; onCount(count); playTone(660, 0.1);
        log('COUNT', { n: count, sDip: totalDip.toFixed(3) });
        phase = 'READY'; shoulderBaseY = smoothedShoulderY; shoulderPeakY = smoothedShoulderY; ankleYSamples = [];
      } else if (ascendFrames > 90) {
        log('REJECT', { reason: 'ascend-timeout', frames: ascendFrames, sDip: totalDip.toFixed(3), returnPct: (returnAmt / totalDip).toFixed(2) });
        phase = 'READY'; shoulderBaseY = smoothedShoulderY; shoulderPeakY = smoothedShoulderY; ankleYSamples = [];
      }
    }

    animationFrameId = requestAnimationFrame(processFrame);
  }
  animationFrameId = requestAnimationFrame(processFrame);
  return { getCount: () => count, isTracking: () => tracking, getLog: () => eventLog, stop: () => { if (animationFrameId) cancelAnimationFrame(animationFrameId); animationFrameId = null; } };
}

// ============================================================
// SITUP MODE — Spine angle from flat, via rotated-frame pose estimation
// ============================================================
// Signal design: a 2-point vector angle between the shoulders and the hips. The
// shoulder-hip vector is mathematically stable (no degeneracy), unlike 3-point
// angles which the MDPI study flagged as unreliable on supine subjects. We
// measure the angle between this vector and the body's long axis (the y-axis
// of the rotated frame, since MediaPipe sees a 90°-rotated input where the
// head is at one end of the y-axis and feet at the other). Flat = 0°, fully
// upright = 90°. This is a POSTURE signal — it doesn't care where the body is
// in the frame, only how curled up the torso is, which is what a situp IS.
//
// Baseline is clamped to [0°, MAX_BASELINE_ANGLE] so "rest" always means "near
// flat" — the user can't slowly drift into a half-curled resting posture and
// then get credit for small motions from that corrupted baseline.
function startSitupTracking(video, canvas, onCount, onDebug) {
  const ctx = canvas.getContext('2d');

  // Offscreen processing canvas — the video is rotated 90° into this canvas
  // before being passed to MediaPipe. MediaPipe is trained almost entirely on
  // upright humans and its body-model fitting fails unreliably on supine
  // subjects that appear horizontally in the frame. Rotating the input so the
  // user appears vertical (head at top, feet at bottom) restores reliable
  // landmark detection. The visible video element stays in its native
  // landscape orientation — only the input to MediaPipe is rotated.
  const procCanvas = document.createElement('canvas');
  const procCtx = procCanvas.getContext('2d');

  let count = 0, tracking = false, frameNum = 0;
  const signalBuf = [];

  // Thresholds — signal is spine angle in DEGREES (0° flat, 90° fully upright)
  const MIN_LIFT = 40;                    // minimum peak angle change to count a rep (40° from rest)
  const MIN_FRAMES = 10;                  // minimum frames between rep-start and count
  const MAX_BASELINE_ANGLE = 15;          // rest baseline is clamped to [0°, 15°] — forces "rest = near flat"
  // Knee-lock check DISABLED. MediaPipe's knee landmark is unreliable on supine bodies —
  // observed knee jitter of 30%+ of image height. The check false-rejects real reps.
  // Keeping the accumulator for debug logs but gating on Infinity so it never triggers.
  const MAX_KNEE_LIFT_DELTA = Infinity;
  const ACTIVE_TIMEOUT_FRAMES = 900;      // ~7.5s — full rep up and back down
  const RETURN_TOLERANCE = 5;             // spine must return to within 5° of baseline to count
  const READY_FRAMES_NEEDED = 30;
  const LOST_FRAMES_THRESHOLD = 60;       // 0.5s grace for brief landmark occlusions

  // Ready gate state
  let gateState = 'NOT_READY';
  let gateFrames = 0;
  let lostFrames = 0;

  // Tracking state. Single active phase: rep starts when spine angle exceeds
  // half-threshold from baseline, tracks peak, and COUNTs when the angle
  // returns within RETURN_TOLERANCE of baseline. The baseline is never reset
  // on count and is clamped to [0°, MAX_BASELINE_ANGLE] so rest always means
  // "near flat" — this prevents the user from slowly drifting into a curled
  // rest posture and getting credit for partial-range motions.
  let phase = 'READY'; // READY | ACTIVE
  let baselineAngle = 0;  // degrees, clamped to [0, MAX_BASELINE_ANGLE]
  let peakDevMag = 0;     // max (smoothedAngle - baselineAngle) during current rep, in degrees
  let activeStartFrame = 0;
  let startKneeLift = null;
  let kneeLiftDeltaMax = 0;

  // Debug instrumentation
  let maxDevSinceGate = 0;
  let lastTrackLogFrame = 0;
  const TRACK_LOG_INTERVAL = 30;

  // Baseline adapts only when the signal is very close to baseline — frozen
  // during motion. Must be tighter than the EMA's steady-state lag so freeze
  // kicks in quickly once a rep starts.
  const BASELINE_ADAPT_WINDOW = 2;  // degrees

  const eventLog = [];
  function log(type, data) { eventLog.push({ t: (performance.now()/1000).toFixed(2), frame: frameNum, type, ...data }); if (eventLog.length > 200) eventLog.shift(); }

  // Spine angle in DEGREES, computed from the shoulder→hip vector in the
  // rotated frame. When flat, the body's long axis is parallel to the rotated
  // frame's y-axis (head at one end, feet at the other), so dx ≈ 0 and |dy|
  // is large → angle ≈ 0°. When sitting upright, shoulders rotate away from
  // the hips' y-axis, so |dx| grows and |dy| shrinks → angle → 90°. We use
  // absolute values of both components so the signal is direction-agnostic:
  // it doesn't matter which side the user is lying on, which side they lean
  // toward when sitting, or which way the frame was rotated.
  function computeSpineAngle(lm) {
    const shoulderX = (lm[11].x + lm[12].x) / 2;
    const shoulderY = (lm[11].y + lm[12].y) / 2;
    const hipX = (lm[23].x + lm[24].x) / 2;
    const hipY = (lm[23].y + lm[24].y) / 2;
    const dx = shoulderX - hipX;
    const dy = shoulderY - hipY;
    return Math.atan2(Math.abs(dx), Math.abs(dy)) * 180 / Math.PI;
  }

  function computeKneeLift(lm) {
    // knee elevation above hip. Used for leg-lock cheat detection via delta-during-rep.
    const hipY = (lm[23].y + lm[24].y) / 2;
    const kneeY = (lm[25].y + lm[26].y) / 2;
    return hipY - kneeY;
  }

  function landmarksVisible(lm) {
    // Only require shoulders and hips for the gate. Knees aren't needed
    // because the knee-lock form check is disabled. Reducing the gate from
    // 6 landmarks to 4 dramatically cuts gate drops during real reps.
    return lm[11].visibility > MIN_VISIBILITY
      && lm[12].visibility > MIN_VISIBILITY
      && lm[23].visibility > MIN_VISIBILITY
      && lm[24].visibility > MIN_VISIBILITY;
  }

  // Median filter — a 15-frame median is immune to single-frame spikes.
  const SIGNAL_MEDIAN_WINDOW = 15;
  function smoothMedian(newValue) {
    signalBuf.push(newValue);
    if (signalBuf.length > SIGNAL_MEDIAN_WINDOW) signalBuf.shift();
    const sorted = [...signalBuf].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  function clampBaseline(angle) {
    return Math.max(0, Math.min(MAX_BASELINE_ANGLE, angle));
  }

  function processFrame() {
    if (!poseLandmarker || video.paused || video.ended) { animationFrameId = requestAnimationFrame(processFrame); return; }
    frameNum++;

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) {
      animationFrameId = requestAnimationFrame(processFrame);
      return;
    }

    // Rotate the video 90° COUNTER-clockwise into an offscreen processing
    // canvas. Dimensions are swapped — a landscape 1280×720 source becomes
    // a portrait 720×1280. MediaPipe sees this rotated image internally. The
    // visible video stays in its native landscape orientation.
    //
    // Direction (CCW vs CW) matters because it determines which side of the
    // original landscape ends up at the top of the rotated portrait. Counter-
    // clockwise puts the RIGHT side of the original at the TOP of the rotated
    // frame. That matches a user lying with their head on the right side of
    // the camera (laptop webcam perspective). If the user lies with head on
    // the left, CW would be correct — we'd detect that by observing signal
    // direction during real reps (negative = wrong rotation, flip direction).
    procCanvas.width = vh;
    procCanvas.height = vw;
    procCtx.save();
    procCtx.translate(0, vw);
    procCtx.rotate(-Math.PI / 2);
    procCtx.drawImage(video, 0, 0, vw, vh);
    procCtx.restore();

    // Visible canvas is landscape, matching the native video. The skeleton
    // will be drawn here after transforming landmarks back from rotated space.
    canvas.width = vw;
    canvas.height = vh;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // MediaPipe processes the rotated image. Landmarks come back in the
    // rotated coordinate space where y increases from head (top) to feet
    // (bottom) in that frame. Signal computations use these rotated coords
    // directly. Skeleton drawing needs un-rotated coords (see below).
    const result = poseLandmarker.detectForVideo(procCanvas, performance.now());

    if (!result.landmarks || result.landmarks.length === 0) {
      tracking = false;
      if (gateState === 'READY') {
        lostFrames++;
        if (lostFrames >= LOST_FRAMES_THRESHOLD) {
          gateState = 'NOT_READY';
          gateFrames = 0;
          phase = 'READY';
          signalBuf.length = 0;
          playTone(330, 0.3);
          log('PAUSED', { reason: 'landmarks-lost' });
        }
      }
      if (onDebug) onDebug({ phase, count, gated: gateState === 'READY' ? 'pausing' : 'no-pose', mode: 'SITUP' });
      animationFrameId = requestAnimationFrame(processFrame);
      return;
    }

    const lm = result.landmarks[0];
    tracking = true;

    // Transform rotated-space landmarks back to native-video coordinates for
    // the visible skeleton overlay. For 90° counter-clockwise rotation, the
    // forward transform is:
    //   rotated.x = original.y
    //   rotated.y = 1 - original.x
    // Inverse:
    //   original.x = 1 - rotated.y
    //   original.y = rotated.x
    const nativeLm = lm.map(p => ({
      x: 1 - p.y,
      y: p.x,
      z: p.z,
      visibility: p.visibility,
    }));
    drawSkeleton(ctx, nativeLm);

    // --- READY GATE ---
    if (gateState === 'NOT_READY') {
      if (landmarksVisible(lm)) gateFrames++;
      else gateFrames = 0;

      const missing = [];
      if (lm[11].visibility <= MIN_VISIBILITY || lm[12].visibility <= MIN_VISIBILITY) missing.push('shoulder');
      if (lm[23].visibility <= MIN_VISIBILITY || lm[24].visibility <= MIN_VISIBILITY) missing.push('hip');

      if (onDebug) onDebug({ gateProgress: `${gateFrames}/${READY_FRAMES_NEEDED}`, missing: missing.join(',') || 'none', phase: 'SETUP', count, gated: 'not-ready', mode: 'SITUP' });

      if (gateFrames >= READY_FRAMES_NEEDED) {
        gateState = 'READY';
        lostFrames = 0;
        const initialAngle = computeSpineAngle(lm);
        baselineAngle = clampBaseline(initialAngle);
        peakDevMag = 0;
        signalBuf.length = 0;
        phase = 'READY';
        maxDevSinceGate = 0;
        lastTrackLogFrame = frameNum;
        playTone(880, 0.15);
        setTimeout(() => playTone(1100, 0.15), 170);
        log('READY', { angle: initialAngle.toFixed(1), baseline: baselineAngle.toFixed(1) });
      }
      animationFrameId = requestAnimationFrame(processFrame);
      return;
    }

    // --- TRACKING (gate is READY) ---
    if (!landmarksVisible(lm)) {
      lostFrames++;
      if (lostFrames >= LOST_FRAMES_THRESHOLD) {
        gateState = 'NOT_READY';
        gateFrames = 0;
        phase = 'READY';
        signalBuf.length = 0;
        playTone(330, 0.3);
        log('PAUSED', { reason: 'landmarks-lost' });
      }
      if (onDebug) onDebug({ phase, count, gated: 'losing-landmarks', mode: 'SITUP' });
      animationFrameId = requestAnimationFrame(processFrame);
      return;
    }
    lostFrames = 0;

    const rawAngle = computeSpineAngle(lm);
    const smoothedAngle = smoothMedian(rawAngle);
    // Deviation can be negative (user briefly flatter than baseline), but for
    // rep detection we only care about positive deviation — sitting up is the
    // only direction that matters. The spine angle is unsigned by construction,
    // so no need for a sign-lock mechanism.
    const devSigned = smoothedAngle - baselineAngle;
    const devMag = Math.max(0, devSigned);  // only positive deviation counts toward a rep
    if (devMag > maxDevSinceGate) maxDevSinceGate = devMag;

    // Periodic TRACK log
    if (frameNum - lastTrackLogFrame >= TRACK_LOG_INTERVAL) {
      log('TRACK', {
        phase,
        raw: rawAngle.toFixed(1),
        smoothed: smoothedAngle.toFixed(1),
        baseline: baselineAngle.toFixed(1),
        dev: devSigned.toFixed(1),
        maxDev: maxDevSinceGate.toFixed(1),
      });
      lastTrackLogFrame = frameNum;
    }

    // Leg-lock tracking during the rep
    if (phase === 'ACTIVE') {
      const currentKneeLift = computeKneeLift(lm);
      if (startKneeLift !== null) {
        const delta = Math.abs(currentKneeLift - startKneeLift);
        if (delta > kneeLiftDeltaMax) kneeLiftDeltaMax = delta;
      }
    }

    if (onDebug) onDebug({
      lift: smoothedAngle.toFixed(1),
      liftDelta: devSigned.toFixed(1),
      baseline: baselineAngle.toFixed(1),
      kneeDelta: phase !== 'READY' ? kneeLiftDeltaMax.toFixed(3) : '--',
      phase, count, gated: 'active', mode: 'SITUP',
      depth: Math.min(1, Math.max(0, devMag / MIN_LIFT)),
      depthThreshold: 1,
    });

    // --- PHASE MACHINE (single active phase) ---
    // Rep starts when deviation from the clamped baseline exceeds half MIN_LIFT.
    // Peak is tracked continuously during ACTIVE. COUNT fires only once peak has
    // exceeded MIN_LIFT AND the signal has returned to within RETURN_TOLERANCE of
    // baseline — i.e., the user went from near-flat to ≥40° and back to near-flat.
    // The baseline is clamped to [0°, MAX_BASELINE_ANGLE] so a user who rests in
    // a half-curled posture can't trigger counts with partial-range motions.
    function resetRepState() {
      phase = 'READY';
      peakDevMag = 0;
      startKneeLift = null;
      kneeLiftDeltaMax = 0;
    }

    if (phase === 'READY') {
      // Baseline adaption — only when signal is very close to baseline (frozen during motion).
      // Clamped to prevent baseline from drifting into a curled rest posture.
      if (devMag < BASELINE_ADAPT_WINDOW) {
        baselineAngle = clampBaseline(smoothedAngle * 0.05 + baselineAngle * 0.95);
      }
      // Trigger rep start: deviation crosses half-threshold
      if (devMag > MIN_LIFT * 0.5) {
        phase = 'ACTIVE';
        activeStartFrame = frameNum;
        peakDevMag = devMag;
        startKneeLift = computeKneeLift(lm);
        kneeLiftDeltaMax = 0;
        log('REP_START', { angle: smoothedAngle.toFixed(1), baseline: baselineAngle.toFixed(1), dev: devMag.toFixed(1) });
      }
    } else if (phase === 'ACTIVE') {
      if (devMag > peakDevMag) peakDevMag = devMag;
      const activeFrames = frameNum - activeStartFrame;
      const committed = peakDevMag > MIN_LIFT;

      if (!committed && devMag < RETURN_TOLERANCE) {
        // False start — user twitched but never reached a real rep. Return quietly to READY.
        resetRepState();
      } else if (committed && devMag < RETURN_TOLERANCE) {
        // Signal has returned to rest after a real rep — count it.
        if (activeFrames < MIN_FRAMES) {
          log('REJECT', { reason: 'too-fast', frames: activeFrames, peakDevMag: peakDevMag.toFixed(1) });
          resetRepState();
        } else if (kneeLiftDeltaMax > MAX_KNEE_LIFT_DELTA) {
          log('REJECT', { reason: 'knee-moved', kneeDelta: kneeLiftDeltaMax.toFixed(3), peakDevMag: peakDevMag.toFixed(1) });
          resetRepState();
        } else {
          count++; onCount(count); playTone(660, 0.1);
          log('COUNT', { n: count, peakDevMag: peakDevMag.toFixed(1), activeFrames });
          resetRepState();
        }
      } else if (activeFrames > ACTIVE_TIMEOUT_FRAMES) {
        log('REJECT', { reason: 'active-timeout', activeFrames, peakDevMag: peakDevMag.toFixed(1) });
        // On timeout, the user has stayed in a non-rest position too long. Clamp the
        // new baseline so it still represents "near flat" even if the user is half-curled.
        baselineAngle = clampBaseline(smoothedAngle);
        resetRepState();
      }
    }

    animationFrameId = requestAnimationFrame(processFrame);
  }
  animationFrameId = requestAnimationFrame(processFrame);
  return { getCount: () => count, isTracking: () => tracking, getLog: () => eventLog, stop: () => { if (animationFrameId) cancelAnimationFrame(animationFrameId); animationFrameId = null; } };
}

// ============================================================
// Public API
// ============================================================
export function startTracking(video, canvas, onCount, onDebug, mode = 'standard') {
  if (mode === 'situp') return startSitupTracking(video, canvas, onCount, onDebug);
  if (mode === 'opm') return startOpmTracking(video, canvas, onCount, onDebug);
  return startStandardTracking(video, canvas, onCount, onDebug);
}

export async function getCamera(facingMode = 'user') {
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 }, aspectRatio: { ideal: 16/9 } },
    audio: false,
  });
}
