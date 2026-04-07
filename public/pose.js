import { FilesetResolver, PoseLandmarker, DrawingUtils } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/vision_bundle.mjs';

let poseLandmarker = null;
let animationFrameId = null;

const MIN_VISIBILITY = 0.5;
const SMOOTHING_WINDOW = 9;

function playTone(freq, duration, type = 'sine') {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
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
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
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
// NOOB MODE — Front-facing, nose/shoulder dip + elbow + wrist
// ============================================================
function startNoobTracking(video, canvas, onCount, onDebug) {
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

  function noobLandmarksVisible(lm) {
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
      if (onDebug) onDebug({ phase, count, gated: gateState === 'READY' ? 'pausing' : 'no-pose', mode: 'NOOB' });
      animationFrameId = requestAnimationFrame(processFrame);
      return;
    }

    const lm = result.landmarks[0];
    tracking = true;
    drawSkeleton(ctx, lm);

    // --- READY GATE ---
    if (gateState === 'NOT_READY') {
      if (noobLandmarksVisible(lm)) {
        gateFrames++;
      } else {
        gateFrames = 0;
      }

      const missing = [];
      if (lm[0].visibility <= MIN_VISIBILITY) missing.push('nose');
      const lArmOk = Math.min(lm[11].visibility, lm[13].visibility, lm[15].visibility) > MIN_VISIBILITY;
      const rArmOk = Math.min(lm[12].visibility, lm[14].visibility, lm[16].visibility) > MIN_VISIBILITY;
      if (!lArmOk && !rArmOk) missing.push('arms');

      if (onDebug) onDebug({ gateProgress: `${gateFrames}/${READY_FRAMES_NEEDED}`, missing: missing.join(',') || 'none', phase: 'SETUP', count, gated: 'not-ready', mode: 'NOOB' });

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
    if (!noobLandmarksVisible(lm)) {
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
      if (onDebug) onDebug({ phase, count, gated: 'losing-landmarks', mode: 'NOOB' });
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

    if (onDebug) onDebug({ noseDip: noseDip.toFixed(3), shoulderDip: shoulderDip.toFixed(3), elbow: elbow ?? '--', minElbow: phase !== 'READY' ? minElbow : '--', wVar, phase, count, gated: 'active', mode: 'NOOB' });

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
// STANDARD MODE — Side view, elbow angle + body alignment + no kneeling
// ============================================================
function startStandardTracking(video, canvas, onCount, onDebug) {
  const ctx = canvas.getContext('2d');
  let count = 0, tracking = false, frameNum = 0;
  const shoulderYBuf = [];

  // Thresholds
  const MIN_DIP = 0.03;
  const MIN_FRAMES = 15;
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
      if (onDebug) onDebug({ phase, count, gated: gateState === 'READY' ? 'pausing' : 'no-pose', mode: 'STANDARD' });
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

      if (onDebug) onDebug({ gateProgress: `${gateFrames}/${READY_FRAMES_NEEDED}`, missing: missing.join(',') || 'none', phase: 'SETUP', count, gated: 'not-ready', mode: 'STANDARD' });

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
      if (onDebug) onDebug({ phase, count, gated: 'losing-landmarks', mode: 'STANDARD' });
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

    if (onDebug) onDebug({ sDip: shoulderDip.toFixed(3), ankleVar, kneeAng: kAngle !== null ? Math.round(kAngle) : '--', phase, count, gated: 'active', mode: 'STANDARD' });

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
      if (returnAmt > totalDip * 0.6) {
        count++; onCount(count); playTone(660, 0.1);
        log('COUNT', { n: count, sDip: totalDip.toFixed(3) });
        phase = 'READY'; shoulderBaseY = smoothedShoulderY; shoulderPeakY = smoothedShoulderY; ankleYSamples = [];
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
export function startTracking(video, canvas, onCount, onDebug, mode = 'noob') {
  if (mode === 'standard') return startStandardTracking(video, canvas, onCount, onDebug);
  return startNoobTracking(video, canvas, onCount, onDebug);
}

export async function getCamera(facingMode = 'user') {
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 }, aspectRatio: { ideal: 16/9 } },
    audio: false,
  });
}
