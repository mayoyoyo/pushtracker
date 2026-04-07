import { FilesetResolver, PoseLandmarker, DrawingUtils } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/vision_bundle.mjs';

let poseLandmarker = null;
let animationFrameId = null;

const MIN_VISIBILITY = 0.5;
const SMOOTHING_WINDOW = 9;
const MIN_DIP_AMPLITUDE = 0.04;
// Elbow must bend below this angle at some point during descent to confirm a real pushup
const MAX_ELBOW_ANGLE_FOR_REP = 130;

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
  let vis = 0;
  if (lVis > MIN_VISIBILITY) {
    angle = calculateAngle(landmarks[11], landmarks[13], landmarks[15]);
    vis = lVis;
  }
  if (rVis > MIN_VISIBILITY && rVis > lVis) {
    angle = calculateAngle(landmarks[12], landmarks[14], landmarks[16]);
    vis = rVis;
  }
  return { angle, vis };
}

export function startTracking(video, canvas, onCount, onDebug) {
  const ctx = canvas.getContext('2d');
  let count = 0;
  let tracking = false;
  let frameNum = 0;

  const noseYBuffer = [];
  const shoulderYBuffer = [];
  const elbowAngleBuffer = [];

  let phase = 'READY';
  let nosePeakY = 0;
  let noseBaselineY = 0;
  let shoulderBaselineY = 0;
  let shoulderPeakY = 0;
  let minElbowDuringDescent = 180;
  let wristYSamples = []; // track wrist positions during descent
  const MAX_WRIST_VARIANCE = 0.015; // wrists must stay planted (low movement)

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

      const drawingUtils = new DrawingUtils(ctx);
      drawingUtils.drawLandmarks(landmarks, { radius: 3, color: '#48bb78', fillColor: '#48bb78' });
      drawingUtils.drawConnectors(landmarks, PoseLandmarker.POSE_CONNECTIONS, { color: '#3182ce', lineWidth: 2 });

      const nose = landmarks[0];
      const lShoulder = landmarks[11];
      const rShoulder = landmarks[12];
      const shoulderVis = Math.max(lShoulder.visibility, rShoulder.visibility);

      if (shoulderVis < MIN_VISIBILITY) {
        if (onDebug) onDebug({ noseY: 0, shoulderY: 0, elbowAngle: '--', minElbow: '--', noseDip: 0, shoulderDip: 0, phase, count, gated: 'low-vis' });
        animationFrameId = requestAnimationFrame(processFrame);
        return;
      }

      const rawShoulderY = (lShoulder.y + rShoulder.y) / 2;
      const smoothedShoulderY = smoothValue(shoulderYBuffer, rawShoulderY);

      const hasNose = nose.visibility > MIN_VISIBILITY;
      const rawNoseY = hasNose ? nose.y : rawShoulderY;
      const smoothedNoseY = smoothValue(noseYBuffer, rawNoseY);

      // Elbow angle (best visible side)
      const { angle: rawElbow } = getBestElbowAngle(landmarks);
      const elbowAngle = rawElbow !== null ? Math.round(smoothValue(elbowAngleBuffer, rawElbow)) : null;

      // Wrist y-position (average of visible wrists)
      const lWrist = landmarks[15];
      const rWrist = landmarks[16];
      let wristY = null;
      if (lWrist.visibility > MIN_VISIBILITY && rWrist.visibility > MIN_VISIBILITY) {
        wristY = (lWrist.y + rWrist.y) / 2;
      } else if (lWrist.visibility > MIN_VISIBILITY) {
        wristY = lWrist.y;
      } else if (rWrist.visibility > MIN_VISIBILITY) {
        wristY = rWrist.y;
      }

      if (noseBaselineY === 0) {
        noseBaselineY = smoothedNoseY;
        nosePeakY = smoothedNoseY;
        shoulderBaselineY = smoothedShoulderY;
        shoulderPeakY = smoothedShoulderY;
      }

      const noseDip = smoothedNoseY - noseBaselineY;
      const shoulderDip = smoothedShoulderY - shoulderBaselineY;
      const noseDipFromPeak = nosePeakY - smoothedNoseY;

      // Compute live wrist variance for debug
      let liveWristVar = '--';
      if (wristYSamples.length >= 3) {
        const mean = wristYSamples.reduce((a, b) => a + b, 0) / wristYSamples.length;
        liveWristVar = Math.sqrt(wristYSamples.reduce((sum, v) => sum + (v - mean) ** 2, 0) / wristYSamples.length).toFixed(4);
      }

      if (onDebug) {
        onDebug({
          noseY: smoothedNoseY.toFixed(3),
          shoulderY: smoothedShoulderY.toFixed(3),
          elbowAngle: elbowAngle !== null ? elbowAngle : '--',
          minElbow: phase !== 'READY' ? Math.round(minElbowDuringDescent) : '--',
          noseDip: noseDip.toFixed(3),
          shoulderDip: shoulderDip.toFixed(3),
          wristVar: liveWristVar,
          phase,
          count,
          gated: 'active',
        });
      }

      // Track during descent/ascent
      if (phase !== 'READY') {
        if (elbowAngle !== null && elbowAngle < minElbowDuringDescent) {
          minElbowDuringDescent = elbowAngle;
        }
        if (wristY !== null) {
          wristYSamples.push(wristY);
        }
      }

      if (phase === 'READY') {
        noseBaselineY = smoothedNoseY * 0.05 + noseBaselineY * 0.95;
        shoulderBaselineY = smoothedShoulderY * 0.05 + shoulderBaselineY * 0.95;
        if (noseDip > MIN_DIP_AMPLITUDE * 0.5) {
          phase = 'DESCENDING';
          nosePeakY = smoothedNoseY;
          shoulderPeakY = smoothedShoulderY;
          minElbowDuringDescent = elbowAngle !== null ? elbowAngle : 180;
          wristYSamples = [];
          logEvent('DESCEND', { nY: smoothedNoseY.toFixed(3), sY: smoothedShoulderY.toFixed(3), elbow: elbowAngle, wristY: wristY !== null ? wristY.toFixed(3) : null });
        }
      }

      if (phase === 'DESCENDING') {
        if (smoothedNoseY > nosePeakY) nosePeakY = smoothedNoseY;
        if (smoothedShoulderY > shoulderPeakY) shoulderPeakY = smoothedShoulderY;

        const noseTotalDip = nosePeakY - noseBaselineY;
        if (noseDipFromPeak > MIN_DIP_AMPLITUDE * 0.3 && noseTotalDip > MIN_DIP_AMPLITUDE) {
          const shoulderTotalDip = shoulderPeakY - shoulderBaselineY;

          // Four checks must pass:
          // 1. Shoulders also moved (not just head)
          // 2. Elbow angle dropped below threshold (arms actually bent)
          // 3. Wrists stayed planted (low variance = hands on floor)
          // 4. Wrist data was available
          const shoulderOk = shoulderTotalDip > MIN_DIP_AMPLITUDE * 0.5;
          const elbowOk = minElbowDuringDescent <= MAX_ELBOW_ANGLE_FOR_REP;
          const hasElbow = minElbowDuringDescent < 180;

          // Wrist variance: compute standard deviation of wrist y during descent
          let wristVar = 0;
          let wristOk = false;
          if (wristYSamples.length >= 3) {
            const mean = wristYSamples.reduce((a, b) => a + b, 0) / wristYSamples.length;
            wristVar = Math.sqrt(wristYSamples.reduce((sum, v) => sum + (v - mean) ** 2, 0) / wristYSamples.length);
            wristOk = wristVar <= MAX_WRIST_VARIANCE;
          }
          const hasWrist = wristYSamples.length >= 3;

          if (shoulderOk && elbowOk && wristOk) {
            phase = 'ASCENDING';
            logEvent('ASCEND', { noseDip: noseTotalDip.toFixed(3), shoulderDip: shoulderTotalDip.toFixed(3), minElbow: Math.round(minElbowDuringDescent), wristVar: wristVar.toFixed(4) });
          } else {
            const reason = !shoulderOk ? 'shoulder' : !hasElbow ? 'no-elbow-data' : !elbowOk ? 'elbow-too-straight' : !hasWrist ? 'no-wrist-data' : 'wrist-moved';
            logEvent('REJECT', { reason, noseDip: noseTotalDip.toFixed(3), shoulderDip: shoulderTotalDip.toFixed(3), minElbow: Math.round(minElbowDuringDescent), wristVar: wristVar.toFixed(4) });
            phase = 'READY';
            noseBaselineY = smoothedNoseY;
            nosePeakY = smoothedNoseY;
            shoulderBaselineY = smoothedShoulderY;
            shoulderPeakY = smoothedShoulderY;
          }
        }
      }

      if (phase === 'ASCENDING') {
        const noseTotalDip = nosePeakY - noseBaselineY;
        const noseReturn = nosePeakY - smoothedNoseY;
        if (noseReturn > noseTotalDip * 0.6) {
          count++;
          onCount(count);
          const wristMean = wristYSamples.length > 0 ? wristYSamples.reduce((a, b) => a + b, 0) / wristYSamples.length : 0;
          const wristVarFinal = wristYSamples.length >= 3 ? Math.sqrt(wristYSamples.reduce((sum, v) => sum + (v - wristMean) ** 2, 0) / wristYSamples.length) : 0;
          logEvent('COUNT', { n: count, noseDip: noseTotalDip.toFixed(3), minElbow: Math.round(minElbowDuringDescent), wristVar: wristVarFinal.toFixed(4) });
          phase = 'READY';
          noseBaselineY = smoothedNoseY;
          nosePeakY = smoothedNoseY;
          shoulderBaselineY = smoothedShoulderY;
          shoulderPeakY = smoothedShoulderY;
          minElbowDuringDescent = 180;
          wristYSamples = [];
        }
      }
    } else {
      tracking = false;
      if (onDebug) onDebug({ noseY: 0, shoulderY: 0, elbowAngle: '--', minElbow: '--', noseDip: 0, shoulderDip: 0, phase, count, gated: 'no-pose' });
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
