import { test, expect, describe } from "bun:test";
import { avgLandmark, calculateAngle, computeAbdomenAngle, abdomenAgreementDelta } from "../public/tracker-helpers.js";

describe("avgLandmark", () => {
  test("averages x, y, and visibility of two landmarks", () => {
    const a = { x: 0.2, y: 0.4, visibility: 0.9 };
    const b = { x: 0.6, y: 0.8, visibility: 0.7 };
    const out = avgLandmark(a, b);
    expect(out.x).toBeCloseTo(0.4, 5);
    expect(out.y).toBeCloseTo(0.6, 5);
    expect(out.visibility).toBeCloseTo(0.8, 5);
  });
});

describe("calculateAngle", () => {
  test("returns 180 for a straight line", () => {
    expect(calculateAngle({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 })).toBeCloseTo(180, 1);
  });

  test("returns 90 for a right angle", () => {
    expect(calculateAngle({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 })).toBeCloseTo(90, 1);
  });

  test("returns 0 for coincident outer points", () => {
    expect(calculateAngle({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(0, 1);
  });
});

describe("computeAbdomenAngle", () => {
  // Build a minimal 33-landmark array where indices 11/12 (shoulders), 23/24 (hips),
  // 25/26 (knees) form a known shape and other indices are filler.
  function lm(shoulders: [number, number][], hips: [number, number][], knees: [number, number][]) {
    const a = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 1 }));
    a[11] = { x: shoulders[0][0], y: shoulders[0][1], visibility: 1 };
    a[12] = { x: shoulders[1][0], y: shoulders[1][1], visibility: 1 };
    a[23] = { x: hips[0][0], y: hips[0][1], visibility: 1 };
    a[24] = { x: hips[1][0], y: hips[1][1], visibility: 1 };
    a[25] = { x: knees[0][0], y: knees[0][1], visibility: 1 };
    a[26] = { x: knees[1][0], y: knees[1][1], visibility: 1 };
    return a;
  }

  test("returns ~180 when flat (shoulder-hip-knee colinear)", () => {
    const landmarks = lm(
      [[0.4, 0.5], [0.6, 0.5]],   // shoulder avg (0.5, 0.5)
      [[0.4, 0.7], [0.6, 0.7]],   // hip avg      (0.5, 0.7)
      [[0.4, 0.9], [0.6, 0.9]],   // knee avg     (0.5, 0.9)
    );
    expect(computeAbdomenAngle(landmarks)).toBeCloseTo(180, 1);
  });

  test("returns ~90 for a half crunch", () => {
    const landmarks = lm(
      [[0.5, 0.4], [0.5, 0.4]],
      [[0.5, 0.6], [0.5, 0.6]],
      [[0.7, 0.6], [0.7, 0.6]],
    );
    expect(computeAbdomenAngle(landmarks)).toBeCloseTo(90, 1);
  });

  test("returns ~45 when fully sitting up (acute angle at hip)", () => {
    const landmarks = lm(
      [[0.6, 0.5], [0.6, 0.5]],
      [[0.5, 0.6], [0.5, 0.6]],
      [[0.6, 0.6], [0.6, 0.6]],
    );
    expect(computeAbdomenAngle(landmarks)).toBeCloseTo(45, 1);
  });
});

describe("abdomenAgreementDelta", () => {
  test("returns 0 when left and right sides are symmetric", () => {
    const landmarks = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 1 }));
    landmarks[11] = { x: 0.4, y: 0.5, visibility: 1 };
    landmarks[12] = { x: 0.6, y: 0.5, visibility: 1 };
    landmarks[23] = { x: 0.4, y: 0.7, visibility: 1 };
    landmarks[24] = { x: 0.6, y: 0.7, visibility: 1 };
    landmarks[25] = { x: 0.4, y: 0.9, visibility: 1 };
    landmarks[26] = { x: 0.6, y: 0.9, visibility: 1 };
    expect(abdomenAgreementDelta(landmarks)).toBeCloseTo(0, 1);
  });

  test("returns non-trivial value when sides disagree", () => {
    const landmarks = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 1 }));
    // Left side flat (~180), right side crunched (~90)
    landmarks[11] = { x: 0.4, y: 0.5, visibility: 1 };
    landmarks[23] = { x: 0.4, y: 0.7, visibility: 1 };
    landmarks[25] = { x: 0.4, y: 0.9, visibility: 1 };
    landmarks[12] = { x: 0.6, y: 0.5, visibility: 1 };
    landmarks[24] = { x: 0.6, y: 0.7, visibility: 1 };
    landmarks[26] = { x: 0.8, y: 0.7, visibility: 1 };
    expect(abdomenAgreementDelta(landmarks)).toBeGreaterThan(20);
  });
});
