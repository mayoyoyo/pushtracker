import { FilesetResolver, PoseLandmarker, DrawingUtils } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/vision_bundle.mjs';

let poseLandmarker = null;
let animationFrameId = null;

const MIN_VISIBILITY = 0.5;
const SMOOTHING_WINDOW = 9;

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
  const eventLog = [];
  function log(type, data) { eventLog.push({ t: (performance.now()/1000).toFixed(2), frame: frameNum, type, ...data }); if (eventLog.length > 200) eventLog.shift(); }

  function processFrame() {
    if (!poseLandmarker || video.paused || video.ended) { animationFrameId = requestAnimationFrame(processFrame); return; }
    frameNum++;
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const result = poseLandmarker.detectForVideo(video, performance.now());
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (result.landmarks && result.landmarks.length > 0) {
      const lm = result.landmarks[0];
      tracking = true;
      drawSkeleton(ctx, lm);

      const shoulderVis = Math.max(lm[11].visibility, lm[12].visibility);
      if (shoulderVis < MIN_VISIBILITY) { if (onDebug) onDebug({ phase, count, gated: 'low-vis' }); animationFrameId = requestAnimationFrame(processFrame); return; }

      const sY = smoothValue(shoulderYBuf, (lm[11].y + lm[12].y) / 2);
      const hasNose = lm[0].visibility > MIN_VISIBILITY;
      const nY = smoothValue(noseYBuf, hasNose ? lm[0].y : (lm[11].y + lm[12].y) / 2);
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
          count++; onCount(count);
          log('COUNT', { n: count, noseDip: nTotal.toFixed(3), minElbow });
          phase = 'READY'; noseBaseY = nY; nosePeakY = nY; shoulderBaseY = sY; shoulderPeakY = sY; minElbow = 180; wristSamples = [];
        }
      }
    } else { tracking = false; if (onDebug) onDebug({ phase, count, gated: 'no-pose', mode: 'NOOB' }); }
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
  const elbowBuf = [];

  const UP_ANGLE = 150, DOWN_ANGLE = 100;
  const MAX_HIP_KNEE_PROXIMITY = 0.08; // tighter = only catches truly tucked knees from side view
  const MIN_DOWN_FRAMES = 15; // ~0.5s at 30fps — prevents counting laptop jiggle
  let state = 'UP';
  let kneelingFrames = 0, totalLBFrames = 0;
  let descentStartFrame = 0;

  const eventLog = [];
  function log(type, data) { eventLog.push({ t: (performance.now()/1000).toFixed(2), frame: frameNum, type, ...data }); if (eventLog.length > 200) eventLog.shift(); }

  function pickSide(lm) {
    const lVis = (lm[11].visibility + lm[13].visibility + lm[15].visibility) / 3;
    const rVis = (lm[12].visibility + lm[14].visibility + lm[16].visibility) / 3;
    if (lVis >= rVis) return { shoulder: lm[11], elbow: lm[13], wrist: lm[15], hip: lm[23], knee: lm[25], ankle: lm[27], vis: lVis };
    return { shoulder: lm[12], elbow: lm[14], wrist: lm[16], hip: lm[24], knee: lm[26], ankle: lm[28], vis: rVis };
  }

  function processFrame() {
    if (!poseLandmarker || video.paused || video.ended) { animationFrameId = requestAnimationFrame(processFrame); return; }
    frameNum++;
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const result = poseLandmarker.detectForVideo(video, performance.now());
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (result.landmarks && result.landmarks.length > 0) {
      const lm = result.landmarks[0];
      tracking = true;
      drawSkeleton(ctx, lm);

      const side = pickSide(lm);
      if (side.vis < MIN_VISIBILITY) { if (onDebug) onDebug({ state, count, gated: 'low-vis', mode: 'STANDARD' }); animationFrameId = requestAnimationFrame(processFrame); return; }

      const rawAngle = calculateAngle(side.shoulder, side.elbow, side.wrist);
      const angle = Math.round(smoothValue(elbowBuf, rawAngle));

      // Body alignment: shoulder-hip angle (should be roughly horizontal)
      let bodyAngle = '--';
      if (side.hip.visibility > MIN_VISIBILITY) {
        bodyAngle = Math.round(Math.abs(Math.atan2(side.hip.y - side.shoulder.y, side.hip.x - side.shoulder.x) * 180 / Math.PI));
      }

      // Kneeling detection
      if (state === 'DOWN') {
        if (side.hip.visibility > MIN_VISIBILITY && side.knee.visibility > MIN_VISIBILITY) {
          totalLBFrames++;
          if (Math.abs(side.hip.y - side.knee.y) < MAX_HIP_KNEE_PROXIMITY) kneelingFrames++;
        }
      }

      const kneelingRatio = totalLBFrames > 0 ? kneelingFrames / totalLBFrames : 0;

      if (onDebug) onDebug({ angle, bodyAngle, state, kneel: kneelingRatio.toFixed(2), count, gated: 'active', mode: 'STANDARD' });

      if (angle < DOWN_ANGLE && state === 'UP') {
        state = 'DOWN';
        kneelingFrames = 0; totalLBFrames = 0; descentStartFrame = frameNum;
        log('DOWN', { angle });
      }

      if (angle > UP_ANGLE && state === 'DOWN') {
        const framesInDown = frameNum - descentStartFrame;
        if (framesInDown < MIN_DOWN_FRAMES) {
          // Too fast — jiggle, not a real pushup
          log('REJECT', { reason: 'too-fast', frames: framesInDown, angle });
          state = 'UP'; kneelingFrames = 0; totalLBFrames = 0;
        } else {
          const kr = totalLBFrames > 0 ? kneelingFrames / totalLBFrames : 0;
          if (kr > 0.5) {
            log('REJECT', { reason: 'kneeling', kneel: kr.toFixed(2), angle, frames: framesInDown });
            state = 'UP'; kneelingFrames = 0; totalLBFrames = 0;
          } else {
            state = 'UP';
            count++; onCount(count);
            log('COUNT', { n: count, angle, kneel: kr.toFixed(2), frames: framesInDown });
            kneelingFrames = 0; totalLBFrames = 0;
          }
        }
      }
    } else { tracking = false; if (onDebug) onDebug({ state, count, gated: 'no-pose', mode: 'STANDARD' }); }
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
    video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
}
