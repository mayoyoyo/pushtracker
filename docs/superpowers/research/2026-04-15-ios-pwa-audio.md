# iOS PWA audio — investigation & shelved

**Date:** 2026-04-15
**Status:** Shelved. No known fix. Audio in camera mode does not work on iOS after the PWA has been installed to the home screen and cold-reopened once.

## Problem

Pushtracker's camera mode plays short WebAudio oscillator tones from `public/pose.js`:

- 660Hz, 100ms — per-rep click (`playTone(660, 0.1)`)
- 880Hz + 1100Hz — gate READY ascending chime
- 330Hz, 300ms — gate NOT_READY / lost alert
- Plus a 3-note ascending chime in `public/app.js` `playCongratsSound()` when daily target is hit

**Desktop Safari, desktop Chrome, mobile Safari (not installed)**: all tones audible and working.

**Installed iOS home-screen PWA**: first session after a fresh install — tones work. Close the PWA and cold-reopen from the home screen — tones silent forever. Delete-and-reinstall recovers for exactly one session, then silent again on the next cold-open. This repeats indefinitely.

## Environment

- Device: iPhone (user's personal device)
- iOS version: unknown at investigation time
- PWA: added to home screen via Safari Share → Add to Home Screen. Standalone display mode.

## What we tried (PRs #29, #30, #34, #35, #36, #37, #38)

All reverted as of this doc. Kept only PR #33 (cache-headers), which is unrelated to the audio fix itself but was a prerequisite for fast iteration (makes deploys propagate to installed PWAs without delete-and-reinstall).

### Attempt 1 — port mafia's WebAudio unlock pattern
- Shared `AudioContext` singleton via `getAudioContext()` (replacing per-tone fresh contexts).
- `navigator.audioSession.type = 'playback'` set at ctx creation — the iOS-specific flag that routes WebAudio through the media channel instead of ringer (bypasses physical silent switch).
- `unlockAudio()` on `touchend`/`click`/`keydown` capture listeners, calling `ctx.resume()` synchronously inside the gesture.
- Silent looping `<audio>` element (data URI WAV) to keep the audio session from auto-suspending.
- `visibilitychange` listener to `resume()` + restart silent loop on return from background.
- Exposed `window.getAudioContext` so `pose.js` shared the same unlocked ctx.

**Result:** Worked on the first cold-open after fresh install. Silent on the second cold-open. Same as baseline.

### Attempt 2 — prime the WebAudio output
- Added `primeAudioOutput()`: creates a near-silent (`gain=0.001`, 10ms @ 440Hz) oscillator and plays it through `ctx.destination` inside the unlock gesture. Theory: iOS may not commit media-channel routing until an actual buffer plays through the ctx.
- Set `audioSession.type = 'playback'` eagerly at module top-level, not lazily.
- `pageshow` listener in addition to `visibilitychange`.

**Result:** No change.

### Attempt 3 — on-device debug instrumentation
Added a monospace debug card on the camera tutorial screen showing:
- `ctx.state`, `audioSession.type`, silent loop status, PWA vs browser mode
- counters: `unlocked`, `resumed`, `primed`, `teardowns`, `rebuilds`, `hwUnlocks`
- `lastEvt` (last lifecycle event fired), `lastErr` (last error caught)

This was the turning point — gave us actual signal instead of blind fixes.

First screenshot after cold-reopen:
```
ctx:suspended  session:y/playback  silent:none  mode:pwa
unlock:16  resume:0  prime:16
err:resume:Failed to start the audio device
```

**Findings:**
- `audioSession.type = 'playback'` was set correctly.
- The silent `<audio>` loop **never started** (`silent:none` — `.play()` was rejecting).
- Every `ctx.resume()` call failed with WebKit's **"Failed to start the audio device"** — the native audio backend behind the JS `AudioContext` object was dead.

### Attempt 4 — teardown dead ctx on exit
Close `AudioContext` on `pagehide` / `visibilitychange:hidden` so iOS can't freeze a dead ctx into the next session. Replace `<audio>` silent loop with WebAudio `ConstantSourceNode` (`offset=0`) for keepalive, since the `<audio>` element was itself failing.

Next screenshot:
```
ctx:suspended  session:y/playback  silent:off  mode:pwa
unlock:8  resume:0  prime:0  teardown:0
err:resume:Failed to start the audio device
```

**Findings:**
- `teardown:0` — **`pagehide` did not fire on exit.** iOS is freezing the PWA without sending any of the documented lifecycle events we can intercept.
- The dead ctx survived the freeze, and resume against it kept failing.

### Attempt 5 — in-gesture rebuild
Stop trying to catch the exit. On every tap, if `audioCtx.state !== 'running'`, close it and create a fresh one synchronously inside the touch/click handler, then call `resume()` on the new one. Also set `audioSession.type` inside the gesture (in case module-load-time was too early for iOS to honor it). Added `pageshow` / `freeze` listeners + a `rebuild` counter + `evt` tag.

Next screenshot:
```
ctx:suspended  session:y/playback  silent:off  mode:pwa
unlock:8  resume:0  prime:0  rebuild:7  teardown:0
evt:pageshow:fresh  err:resume:Failed to start the audio device
```

**Findings:**
- `rebuild:7` — in-gesture rebuild path **is running**. Brand-new `AudioContext`s are being created on every tap.
- `resume:0` — **even brand new contexts refuse to resume**, with the same error.
- `teardown:0` — `pagehide`, `freeze`, `visibilitychange:hidden` all did not fire on exit.
- `evt:pageshow:fresh` — the only lifecycle event that did fire was `pageshow`, with `persisted=false` (iOS thinks this is a fresh load).

**Conclusion:** The problem is not a stale ctx. iOS is denying WebAudio output entirely to the PWA after the first session, regardless of ctx freshness.

### Attempt 6 — force hardware activation via `<audio>` element
If WebAudio is denied, try real PCM through an `<audio>` element with an audible WAV. Generated a 50ms 440Hz sine wave (amplitude 0.05) as an inline data URI, created a single `<audio>` element, played it synchronously inside the first user gesture. Theory: real audible output forces iOS to actually start the audio hardware, and then WebAudio can resume.

Final screenshot:
```
ctx:suspended  session:y/playback  silent:off  mode:pwa
unlock:10  hw:2  resume:0  prime:0  rebuild:9  teardown:0
evt:pageshow:fresh  err:resume:Failed to start the audio device
```

**Findings:**
- `hw:2` — the `<audio>` element's `.play()` promise resolved twice. Real PCM output was attempted.
- `resume:0` — WebAudio is **still** denied. The `<audio>` unlock did not cascade to WebAudio hardware activation on this device.

## Conclusion

On this user's iOS device, after a PWA has been cold-opened once from the home screen, the OS refuses to grant the PWA's WebKit process any fresh WebAudio output, no matter:
- whether the ctx is fresh or recycled
- whether `audioSession.type = 'playback'` is set (it's confirmed set, `session:y/playback`)
- whether we play audible `<audio>` element PCM first to force hardware activation
- which lifecycle event we listen on (none of `pagehide`, `freeze`, `visibilitychange:hidden`, or `pageshow:persisted` fire)

We don't know *why*. Delete-and-reinstall recovers for exactly one session, which strongly suggests iOS is storing some per-PWA state that locks audio after first close. Not a JS-side state issue — we tried every form of JS teardown and rebuild.

## Things we did NOT try (possible next directions)

1. **Convert every tone in `pose.js` to `<audio>` element playback.** We only tried `<audio>` as an unlock hammer for WebAudio. If `<audio>` itself routes through media and works (`hw:2` in the last readout suggests it at least doesn't reject), pre-generate a small set of WAV data URIs (one per tone frequency) and play them via `<audio>` elements instead of oscillators. Never verified whether `<audio>` output is *audible* on the user's device — only that `.play()` resolved.

2. **Service worker with a cache strategy.** Maybe iOS is caching some audio-related headers from the first load that later deny subsequent audio. Hasn't been verified.

3. **`navigator.mediaSession.setActionHandler` / media session API.** There's a possibility iOS wants the PWA to declare itself as a media session before granting audio hardware. Not explored.

4. **Check the user's exact iOS version.** iOS < 16.4 doesn't support `navigator.audioSession` at all. iOS 17 changed PWA audio handling again. The investigation was done with iOS version unknown.

5. **Contact Apple WebKit bug tracker.** This feels like it might be a WebKit bug specific to PWA standalone mode — worth filing a minimal reproduction.

6. **Watch the user actually tap** (or use a real mirror device) — all our data came through screenshotted debug readouts. Seeing `ctx.state` transitions in real time might reveal something.

## What's kept in the codebase

- PR #33 — `Cache-Control: no-store` on HTML/JS/CSS/JSON in `src/server.ts`. **Keep.** This makes iOS PWAs pick up new deploys on cold-open without requiring delete-and-reinstall. Unrelated to audio but discovered during this investigation and is genuinely useful.
- Everything else from PRs #29, #30, #34, #35, #36, #37, #38 — **reverted**. `public/app.js` is back to the original per-tone fresh-`AudioContext` `playCongratsSound`. `public/pose.js` `playTone` is back to per-tone fresh-`AudioContext`. No unlock listeners, no debug card, no audioSession plumbing.

If anyone picks this up later, start by reading this doc — the "things we did NOT try" list is where the oxygen is.
