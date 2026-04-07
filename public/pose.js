import { FilesetResolver, PoseLandmarker, DrawingUtils } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/vision_bundle.mjs';

let poseLandmarker = null;
let animationFrameId = null;

// Front-facing detection: track nose/shoulder vertical position
// As user goes down, landmarks move down in frame (y increases)
// As user pushes up, landmarks move up (y decreases)
const SMOOTHING_WINDOW = 9;
const MIN_VISIBILITY = 0.5;
const MIN_DIP_AMPLITUDE = 0.04; // minimum vertical movement to count as a rep

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

function smoothValue(buffer, newValue) {
  buffer.push(newValue);
  if (buffer.length > SMOOTHING_WINDOW) buffer.shift();
  return buffer.reduce((a, b) => a + b, 0) / buffer.length;
}

export function startTracking(video, canvas, onCount, onDebug) {
  const ctx = canvas.getContext('2d');
  let count = 0;
  let tracking = false;
  let frameNum = 0;

  // Smoothing buffers
  const noseYBuffer = [];
  const shoulderYBuffer = [];

  // Peak detection state
  let phase = 'READY'; // READY -> DESCENDING -> ASCENDING (count!)
  let nosePeakY = 0;
  let noseBaselineY = 0;
  let shoulderBaselineY = 0;
  let shoulderPeakY = 0;

  const eventLog = [];
  function logEvent(type, data) {
    eventLog.push({ t: (performance.now() / 1000).toFixed(2), frame: frameNum, type, ...data });
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

      // Draw skeleton
      const drawingUtils = new DrawingUtils(ctx);
      drawingUtils.drawLandmarks(landmarks, { radius: 3, color: '#48bb78', fillColor: '#48bb78' });
      drawingUtils.drawConnectors(landmarks, PoseLandmarker.POSE_CONNECTIONS, { color: '#3182ce', lineWidth: 2 });

      // Track both nose and shoulders
      const nose = landmarks[0];
      const lShoulder = landmarks[11];
      const rShoulder = landmarks[12];
      const shoulderVis = Math.max(lShoulder.visibility, rShoulder.visibility);

      // Need at least shoulders visible
      if (shoulderVis < MIN_VISIBILITY) {
        if (onDebug) onDebug({ noseY: 0, shoulderY: 0, noseBase: 0, shoulderBase: 0, noseDip: 0, shoulderDip: 0, phase, count, gated: 'low-vis' });
        animationFrameId = requestAnimationFrame(processFrame);
        return;
      }

      const rawShoulderY = (lShoulder.y + rShoulder.y) / 2;
      const smoothedShoulderY = smoothValue(shoulderYBuffer, rawShoulderY);

      // Use nose if visible, otherwise just shoulders
      const hasNose = nose.visibility > MIN_VISIBILITY;
      const rawNoseY = hasNose ? nose.y : rawShoulderY;
      const smoothedNoseY = smoothValue(noseYBuffer, rawNoseY);

      // Initialize baselines
      if (noseBaselineY === 0) {
        noseBaselineY = smoothedNoseY;
        nosePeakY = smoothedNoseY;
        shoulderBaselineY = smoothedShoulderY;
        shoulderPeakY = smoothedShoulderY;
      }

      const noseDip = smoothedNoseY - noseBaselineY;
      const shoulderDip = smoothedShoulderY - shoulderBaselineY;
      const noseDipFromPeak = nosePeakY - smoothedNoseY;

      if (onDebug) {
        onDebug({
          noseY: smoothedNoseY.toFixed(3),
          shoulderY: smoothedShoulderY.toFixed(3),
          noseBase: noseBaselineY.toFixed(3),
          shoulderBase: shoulderBaselineY.toFixed(3),
          noseDip: noseDip.toFixed(3),
          shoulderDip: shoulderDip.toFixed(3),
          phase,
          count,
          gated: 'active',
          hasNose,
        });
      }

      // Phase state machine — requires BOTH nose and shoulders to move
      if (phase === 'READY') {
        noseBaselineY = smoothedNoseY * 0.05 + noseBaselineY * 0.95;
        shoulderBaselineY = smoothedShoulderY * 0.05 + shoulderBaselineY * 0.95;
        if (noseDip > MIN_DIP_AMPLITUDE * 0.5) {
          phase = 'DESCENDING';
          nosePeakY = smoothedNoseY;
          shoulderPeakY = smoothedShoulderY;
          logEvent('DESCEND', { nY: smoothedNoseY.toFixed(3), sY: smoothedShoulderY.toFixed(3) });
        }
      }

      if (phase === 'DESCENDING') {
        if (smoothedNoseY > nosePeakY) nosePeakY = smoothedNoseY;
        if (smoothedShoulderY > shoulderPeakY) shoulderPeakY = smoothedShoulderY;

        const noseTotalDip = nosePeakY - noseBaselineY;
        if (noseDipFromPeak > MIN_DIP_AMPLITUDE * 0.3 && noseTotalDip > MIN_DIP_AMPLITUDE) {
          // Check shoulders also moved — this is the anti-nod check
          const shoulderTotalDip = shoulderPeakY - shoulderBaselineY;
          if (shoulderTotalDip > MIN_DIP_AMPLITUDE * 0.5) {
            phase = 'ASCENDING';
            logEvent('ASCEND', { noseDip: noseTotalDip.toFixed(3), shoulderDip: shoulderTotalDip.toFixed(3) });
          } else {
            // Nose moved but shoulders didn't — head nod, reset
            phase = 'READY';
            noseBaselineY = smoothedNoseY;
            nosePeakY = smoothedNoseY;
            logEvent('NOD_REJECT', { noseDip: noseTotalDip.toFixed(3), shoulderDip: shoulderTotalDip.toFixed(3) });
          }
        }
      }

      if (phase === 'ASCENDING') {
        const noseTotalDip = nosePeakY - noseBaselineY;
        const noseReturn = nosePeakY - smoothedNoseY;
        if (noseReturn > noseTotalDip * 0.6) {
          count++;
          onCount(count);
          logEvent('COUNT', { n: count, noseDip: noseTotalDip.toFixed(3) });
          phase = 'READY';
          noseBaselineY = smoothedNoseY;
          nosePeakY = smoothedNoseY;
          shoulderBaselineY = smoothedShoulderY;
          shoulderPeakY = smoothedShoulderY;
        }
      }
    } else {
      tracking = false;
      if (onDebug) onDebug({ smoothY: 0, baselineY: 0, peakY: 0, dip: 0, phase, count, gated: 'no-pose', trackLabel: 'none' });
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
