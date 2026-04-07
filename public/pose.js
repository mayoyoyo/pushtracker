import { FilesetResolver, PoseLandmarker, DrawingUtils } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/vision_bundle.mjs';

let poseLandmarker = null;
let animationFrameId = null;

const UP_ANGLE = 160;
const DOWN_ANGLE = 90;
const MIN_VISIBILITY = 0.6;

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
    return { shoulder: landmarks[11], elbow: landmarks[13], wrist: landmarks[15], hip: landmarks[23], visibility: leftVis };
  }
  return { shoulder: landmarks[12], elbow: landmarks[14], wrist: landmarks[16], hip: landmarks[24], visibility: rightVis };
}

function isInPushupPosition(shoulder, wrist, hip) {
  // In a pushup, the body is roughly horizontal:
  // 1. Wrists should be near or below shoulder height (y increases downward in image)
  const wristBelowShoulder = wrist.y >= shoulder.y - 0.1;
  // 2. Shoulders and hips should be at roughly similar height (body is horizontal, not upright)
  //    Allow some tolerance — abs(shoulder.y - hip.y) should be small relative to frame
  const bodyHorizontal = Math.abs(shoulder.y - hip.y) < 0.35;
  // 3. The person shouldn't be standing upright — shoulder should not be far above hip
  //    In an upright position, shoulder.y << hip.y (shoulder much higher)
  const notUpright = (hip.y - shoulder.y) < 0.4;
  return wristBelowShoulder && bodyHorizontal && notUpright;
}

export function startTracking(video, canvas, onCount) {
  const ctx = canvas.getContext('2d');
  let state = 'UP';
  let count = 0;
  let tracking = false;

  function processFrame() {
    if (!poseLandmarker || video.paused || video.ended) {
      animationFrameId = requestAnimationFrame(processFrame);
      return;
    }

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

      const { shoulder, elbow, wrist, hip, visibility } = pickVisibleSide(landmarks);

      // Skip frame if landmarks aren't confident enough
      if (visibility < MIN_VISIBILITY) {
        animationFrameId = requestAnimationFrame(processFrame);
        return;
      }

      // Only count if the person is actually in a pushup position
      if (!isInPushupPosition(shoulder, wrist, hip)) {
        animationFrameId = requestAnimationFrame(processFrame);
        return;
      }

      const angle = calculateAngle(shoulder, elbow, wrist);

      if (angle < DOWN_ANGLE && state === 'UP') {
        state = 'DOWN';
      }
      if (angle > UP_ANGLE && state === 'DOWN') {
        state = 'UP';
        count++;
        onCount(count);
      }
    } else {
      tracking = false;
    }

    animationFrameId = requestAnimationFrame(processFrame);
  }

  animationFrameId = requestAnimationFrame(processFrame);

  return {
    getCount: () => count,
    isTracking: () => tracking,
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
