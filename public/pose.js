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

  // Smoothing buffer for the tracking point's y-position
  const yBuffer = [];

  // Peak detection state
  // We're looking for: y goes UP (nose dips down toward floor) then comes back DOWN
  // In normalized coords: y increases = going down, y decreases = coming up
  let phase = 'READY'; // READY -> DESCENDING -> ASCENDING (count!)
  let peakY = 0;       // highest y seen during descent (lowest physical position)
  let baselineY = 0;   // y when we started tracking / last UP position
  let lastSmoothedY = 0;

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

      // Use nose (0) as primary tracking point, fall back to mid-shoulder
      const nose = landmarks[0];
      const lShoulder = landmarks[11];
      const rShoulder = landmarks[12];

      // Pick the best tracking point based on visibility
      let trackY, trackVis, trackLabel;
      if (nose.visibility > MIN_VISIBILITY) {
        trackY = nose.y;
        trackVis = nose.visibility;
        trackLabel = 'nose';
      } else if (lShoulder.visibility > MIN_VISIBILITY || rShoulder.visibility > MIN_VISIBILITY) {
        trackY = (lShoulder.y + rShoulder.y) / 2;
        trackVis = Math.max(lShoulder.visibility, rShoulder.visibility);
        trackLabel = 'shoulders';
      } else {
        if (onDebug) onDebug({ smoothY: 0, baselineY: 0, peakY: 0, dip: 0, phase, count, gated: 'low-vis', trackLabel: 'none' });
        animationFrameId = requestAnimationFrame(processFrame);
        return;
      }

      const smoothedY = smoothValue(yBuffer, trackY);

      // Initialize baseline on first good frame
      if (baselineY === 0) {
        baselineY = smoothedY;
        peakY = smoothedY;
      }

      const dip = smoothedY - baselineY; // positive = moved down, negative = moved up
      const dipFromPeak = peakY - smoothedY; // positive = moving back up from lowest point

      if (onDebug) {
        onDebug({
          smoothY: smoothedY.toFixed(3),
          baselineY: baselineY.toFixed(3),
          peakY: peakY.toFixed(3),
          dip: dip.toFixed(3),
          phase,
          count,
          gated: 'active',
          trackLabel,
          vis: trackVis.toFixed(2),
        });
      }

      // Phase state machine:
      // READY: waiting for user to start going down
      // DESCENDING: user is going down (y increasing)
      // ASCENDING: user is coming back up — once they return near baseline, count it

      if (phase === 'READY') {
        baselineY = smoothedY * 0.05 + baselineY * 0.95; // slowly adapt baseline
        if (dip > MIN_DIP_AMPLITUDE * 0.5) {
          phase = 'DESCENDING';
          peakY = smoothedY;
          logEvent('DESCEND_START', { y: smoothedY.toFixed(3), baseline: baselineY.toFixed(3) });
        }
      }

      if (phase === 'DESCENDING') {
        if (smoothedY > peakY) {
          peakY = smoothedY; // track the lowest point
        }
        // They've gone down enough and now started coming back up
        if (dipFromPeak > MIN_DIP_AMPLITUDE * 0.3 && (peakY - baselineY) > MIN_DIP_AMPLITUDE) {
          phase = 'ASCENDING';
          logEvent('ASCENDING', { peakY: peakY.toFixed(3), dipFromPeak: dipFromPeak.toFixed(3) });
        }
      }

      if (phase === 'ASCENDING') {
        // Count when they've returned close to baseline (within 40% of the dip)
        const totalDip = peakY - baselineY;
        const returnAmount = peakY - smoothedY;
        if (returnAmount > totalDip * 0.6) {
          count++;
          onCount(count);
          logEvent('COUNT', { n: count, y: smoothedY.toFixed(3), totalDip: totalDip.toFixed(3) });
          phase = 'READY';
          baselineY = smoothedY; // reset baseline to current position
          peakY = smoothedY;
        }
      }

      lastSmoothedY = smoothedY;
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
