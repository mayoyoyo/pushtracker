import { FilesetResolver, PoseLandmarker, DrawingUtils } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/vision_bundle.mjs';

let poseLandmarker = null;
let animationFrameId = null;

// Thresholds — these are what we're tuning
const UP_ANGLE = 150;
const DOWN_ANGLE = 100;
const MIN_VISIBILITY = 0.5;

// Shoulder y-oscillation settings
const SMOOTHING_WINDOW = 7;
const MIN_MOVEMENT_AMPLITUDE = 0.03;
const AMPLITUDE_WINDOW = 45;

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

export function calculateAngle(a, b, c) {
  const radians = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x);
  let angle = Math.abs(radians * 180 / Math.PI);
  if (angle > 180) angle = 360 - angle;
  return angle;
}

function pickVisibleSide(landmarks) {
  const leftVis = (landmarks[11].visibility + landmarks[13].visibility + landmarks[15].visibility) / 3;
  const rightVis = (landmarks[12].visibility + landmarks[14].visibility + landmarks[16].visibility) / 3;
  if (leftVis >= rightVis) {
    return { shoulder: landmarks[11], elbow: landmarks[13], wrist: landmarks[15], visibility: leftVis };
  }
  return { shoulder: landmarks[12], elbow: landmarks[14], wrist: landmarks[16], visibility: rightVis };
}

function smoothValue(buffer, newValue) {
  buffer.push(newValue);
  if (buffer.length > SMOOTHING_WINDOW) buffer.shift();
  return buffer.reduce((a, b) => a + b, 0) / buffer.length;
}

export function startTracking(video, canvas, onCount, onDebug) {
  const ctx = canvas.getContext('2d');
  let state = 'UP';
  let count = 0;
  let tracking = false;
  let frameNum = 0;

  const shoulderYBuffer = [];
  const elbowAngleBuffer = [];
  const recentShoulderY = [];

  // Event log for debugging — stores state transitions and key moments
  const eventLog = [];

  function logEvent(type, data) {
    eventLog.push({ t: (performance.now() / 1000).toFixed(2), frame: frameNum, type, ...data });
    // Keep last 200 events
    if (eventLog.length > 200) eventLog.shift();
  }

  function processFrame() {
    if (!poseLandmarker || video.paused || video.ended) {
      animationFrameId = requestAnimationFrame(processFrame);
      return;
    }

    frameNum++;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const result = poseLandmarker.detectForVideo(video, performance.now());
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (result.landmarks && result.landmarks.length > 0) {
      const landmarks = result.landmarks[0];
      tracking = true;

      const drawingUtils = new DrawingUtils(ctx);
      drawingUtils.drawLandmarks(landmarks, { radius: 3, color: '#48bb78', fillColor: '#48bb78' });
      drawingUtils.drawConnectors(landmarks, PoseLandmarker.POSE_CONNECTIONS, { color: '#3182ce', lineWidth: 2 });

      const { shoulder, elbow, wrist, visibility } = pickVisibleSide(landmarks);

      if (visibility < MIN_VISIBILITY) {
        if (onDebug) onDebug({ rawAngle: 0, smoothAngle: 0, shoulderY: 0, amplitude: 0, state, gated: 'low-vis', count, vis: visibility.toFixed(2) });
        animationFrameId = requestAnimationFrame(processFrame);
        return;
      }

      const smoothedShoulderY = smoothValue(shoulderYBuffer, shoulder.y);
      const rawAngle = calculateAngle(shoulder, elbow, wrist);
      const smoothedAngle = smoothValue(elbowAngleBuffer, rawAngle);

      recentShoulderY.push(smoothedShoulderY);
      if (recentShoulderY.length > AMPLITUDE_WINDOW) recentShoulderY.shift();
      const amplitude = Math.max(...recentShoulderY) - Math.min(...recentShoulderY);

      const gated = amplitude < MIN_MOVEMENT_AMPLITUDE;

      if (onDebug) {
        onDebug({
          rawAngle: Math.round(rawAngle),
          smoothAngle: Math.round(smoothedAngle),
          shoulderY: smoothedShoulderY.toFixed(3),
          amplitude: amplitude.toFixed(3),
          state,
          gated: gated ? 'no-motion' : 'active',
          count,
          vis: visibility.toFixed(2),
        });
      }

      if (gated) {
        animationFrameId = requestAnimationFrame(processFrame);
        return;
      }

      const prevState = state;
      if (smoothedAngle < DOWN_ANGLE && state === 'UP') {
        state = 'DOWN';
        logEvent('DOWN', { angle: Math.round(smoothedAngle), raw: Math.round(rawAngle), amp: amplitude.toFixed(3), sy: smoothedShoulderY.toFixed(3) });
      }
      if (smoothedAngle > UP_ANGLE && state === 'DOWN') {
        state = 'UP';
        count++;
        onCount(count);
        logEvent('COUNT', { n: count, angle: Math.round(smoothedAngle), raw: Math.round(rawAngle), amp: amplitude.toFixed(3), sy: smoothedShoulderY.toFixed(3) });
      }
    } else {
      tracking = false;
      if (onDebug) onDebug({ rawAngle: 0, smoothAngle: 0, shoulderY: 0, amplitude: 0, state, gated: 'no-pose', count, vis: '0' });
    }

    animationFrameId = requestAnimationFrame(processFrame);
  }

  animationFrameId = requestAnimationFrame(processFrame);

  return {
    getCount: () => count,
    isTracking: () => tracking,
    getLog: () => eventLog,
    stop: () => {
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    },
  };
}

export async function getCamera(facingMode = 'user') {
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
}
