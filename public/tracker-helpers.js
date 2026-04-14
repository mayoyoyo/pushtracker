// Pure helpers for situp detection. No MediaPipe imports — safe to import
// from bun:test. Every function here is unit-tested in tests/tracker-helpers.test.ts.

export function calculateAngle(a, b, c) {
  const radians = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x);
  let angle = Math.abs(radians * 180 / Math.PI);
  if (angle > 180) angle = 360 - angle;
  return angle;
}

export function avgLandmark(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    visibility: (a.visibility + b.visibility) / 2,
  };
}

// Shoulder-avg → hip-avg → knee-avg abdomen angle, in degrees.
// 180° = flat supine, ~90° = half crunch, <55° = full situp.
// Landmark indices follow MediaPipe Pose: 11/12 shoulders, 23/24 hips, 25/26 knees.
export function computeAbdomenAngle(landmarks) {
  const shoulder = avgLandmark(landmarks[11], landmarks[12]);
  const hip = avgLandmark(landmarks[23], landmarks[24]);
  const knee = avgLandmark(landmarks[25], landmarks[26]);
  return calculateAngle(shoulder, hip, knee);
}

// |leftAbdomenAngle − rightAbdomenAngle| in degrees. Used to reject asymmetric
// reps where one side of the body moves much more than the other.
export function abdomenAgreementDelta(landmarks) {
  const left = calculateAngle(landmarks[11], landmarks[23], landmarks[25]);
  const right = calculateAngle(landmarks[12], landmarks[24], landmarks[26]);
  return Math.abs(left - right);
}
