/* Laser Timer — Bullseye (manual 4-corner calibration)
   - No ArUco, no square detection.
   - You tap the four corners of the target once (TL, TR, BR, BL).
   - Homography H is built from those taps and used for all shots.
*/

let cvReady = false;
let video, overlay, proc, ctx, pctx, countdownEl;
let running = false;

let H = null;                      // perspective transform
const warpSize = { w: 900, h: 1200 }; // virtual target space

let shotsFired = 0;
let totalScore = 0;
let gameShots = 10;
let lastHitTs = 0;

let soundOn = true;
let audioCtx = null;
let prevMask = null;

// Manual calibration state
let calibrationMode = false;
let calibPoints = []; // [{x,y}, ...]

const BULLSEYE = {
  center: [450, 600],
  rings: [120, 220, 320, 420],
  points: [10, 9, 8, 7, 6]
};

// ===== OpenCV bootstrapping =====

function onOpenCvReady() {
  cv['onRuntimeInitialized'] = () => {
    cvReady = true;
    setTimeout(() => {
      const splash = document.getElementById('splash');
      if (splash) splash.style.display = 'none';
    }, 200);
  };
}

function onOpenCvFail() {
  const tip = document.querySelector('#splash .tip');
  if (tip) tip.textContent = 'OpenCV failed to load. Try reloading.';
}

const $ = sel => document.querySelector(sel);

// ===== UI init =====

function init() {
  video = $('#video');
  overlay = $('#overlay');
  proc = $('#proc');
  ctx = overlay.getContext('2d');
  pctx = proc.getContext('2d');
  countdownEl = $('#countdown');

  $('#settingsBtn').onclick = () => $('#drawer').classList.add('open');
  $('#closeDrawer').onclick = () => $('#drawer').classList.remove('open');

  $('#soundToggle').onchange = e => { soundOn = e.target.checked; };
  $('#themeToggle').onchange = e => { document.body.classList.toggle('dark', e.target.checked); };
  $('#resetScores').onclick = () => {
    shotsFired = 0;
    totalScore = 0;
    updateStats();
    alert('Scores reset for this session.');
  };

  $('#gameSelect').onchange = e => { gameShots = parseInt(e.target.value, 10) || 10; };

  $('#startBtn').onclick = startFlow;
  $('#calibBtn').onclick = startManualCalibration;

  // Tap handler for calibration on overlay
  overlay.addEventListener('click', handleCalibTap);
  overlay.addEventListener('touchstart', evt => {
    // Use first touch only
    if (evt.touches && evt.touches.length > 0) {
      handleCalibTap(evt.touches[0]);
      evt.preventDefault();
    }
  });
}

window.addEventListener('DOMContentLoaded', init);

// ===== Camera + main flow =====

async function startFlow() {
  if (!cvReady) {
    alert('Vision engine still loading. Wait a moment and try again.');
    return;
  }
  if (running) return;

  // iOS / browser audio unlock
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();
  } catch (e) {
    console.warn('AudioContext resume failed:', e);
  }

  const hfps = $('#hfps')?.checked;
  const calibHi = $('#calibHi')?.checked;

  try {
    // Camera constraints: optionally high-res, optionally 60fps
    const calibConstraints = calibHi
      ? { video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 60 } }, audio: false }
      : { video: { facingMode: 'environment', width: { ideal: hfps ? 640 : 1280 }, height: { ideal: hfps ? 480 : 720 }, frameRate: { ideal: hfps ? 60 : 30, max: 60 } }, audio: false };

    const stream = await navigator.mediaDevices.getUserMedia(calibConstraints);
    video.srcObject = stream;
    await video.play();

    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
  } catch (e) {
    console.error(e);
    alert('Camera permission or constraints failed. Check browser permissions and HTTPS.');
    return;
  }

  // If high-fps mode requested, switch to 640x480@60fps after initial start
  if (hfps || calibHi) {
    try {
      const playConstraints = {
        video: {
          facingMode: 'environment',
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 60, max: 60 }
        },
        audio: false
      };
      const stream2 = await navigator.mediaDevices.getUserMedia(playConstraints);
      if (video.srcObject) video.srcObject.getTracks().forEach(t => t.stop());
      video.srcObject = stream2;
      await video.play();

      overlay.width = video.videoWidth;
      overlay.height = video.videoHeight;
    } catch (e) {
      console.warn('Could not switch to 60fps low-res; continuing with initial stream.', e);
    }
  }

  // Show countdown before detecting hits
  await countdown(10);

  shotsFired = 0;
  totalScore = 0;
  updateStats();
  running = true;
  frameLoop();
}

// ===== Manual calibration (4-corner tap) =====

function startManualCalibration() {
  calibrationMode = true;
  calibPoints = [];
  if (H) {
    H.delete();
    H = null;
  }
  $('#status').textContent = 'Tap 4 corners (TL, TR, BR, BL)';
}

function handleCalibTap(evt) {
  if (!calibrationMode) return;

  // evt may be MouseEvent or a Touch object
  const rect = overlay.getBoundingClientRect();
  const clientX = evt.clientX;
  const clientY = evt.clientY;
  const x = (clientX - rect.left) * (overlay.width / rect.width);
  const y = (clientY - rect.top) * (overlay.height / rect.height);

  calibPoints.push({ x, y });

  // Draw small marker where tapped
  ctx.save();
  ctx.beginPath();
  ctx.strokeStyle = '#00ff73';
  ctx.fillStyle = '#00ff7366';
  ctx.lineWidth = 2;
  ctx.arc(x, y, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  $('#status').textContent = `Calibration tap ${calibPoints.length}/4`;

  if (calibPoints.length === 4) {
    buildHomographyFromCalib();
  }
}

function buildHomographyFromCalib() {
  try {
    // Order the taps: we assume user tapped TL, TR, BR, BL
    const p0 = calibPoints[0]; // TL
    const p1 = calibPoints[1]; // TR
    const p2 = calibPoints[2]; // BR
    const p3 = calibPoints[3]; // BL

    const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      p0.x, p0.y,
      p1.x, p1.y,
      p2.x, p2.y,
      p3.x, p3.y
    ]);

    const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0,           0,             // TL
      warpSize.w,  0,             // TR
      warpSize.w,  warpSize.h,    // BR
      0,           warpSize.h     // BL
    ]);

    if (H) H.delete();
    H = cv.getPerspectiveTransform(srcTri, dstTri);

    srcTri.delete();
    dstTri.delete();

    calibrationMode = false;
    calibPoints = [];
    $('#status').textContent = 'Calibrated (manual corners)';
  } catch (e) {
    console.error('Homography build failed:', e);
    calibrationMode = false;
    calibPoints = [];
    $('#status').textContent = 'Calibration failed. Try again.';
  }
}

// ===== Main loop (hit detection) =====

function frameLoop() {
  if (!running) return;

  const rAF = video.requestVideoFrameCallback || window.requestAnimationFrame;
  rAF.call(video, () => {
    // Draw video
    ctx.drawImage(video, 0, 0, overlay.width, overlay.height);
    // Copy into processing canvas
    pctx.drawImage(video, 0, 0, proc.width, proc.height);

    const src = cv.imread(proc);
    const hit = detectTransientRed(src);
    src.delete();

    if (hit && H) {
      const sx = overlay.width / proc.width;
      const sy = overlay.height / proc.height;
      const visPt = { x: hit.x * sx, y: hit.y * sy };

      const sp = cv.matFromArray(1, 1, cv.CV_32FC2, [visPt.x, visPt.y]);
      const dp = cv.perspectiveTransform(sp, H);
      const a = dp.data32F;
      const ptW = { x: a[0], y: a[1] };
      sp.delete();
      dp.delete();

      const now = performance.now();
      if (now - lastHitTs > 120) {
        lastHitTs = now;
        const score = scoreBullseye(ptW);

        shotsFired++;
        totalScore += score;
        updateStats(score);
        drawHit(visPt, score);
        playSteel();

        if (shotsFired >= gameShots) {
          running = false;
          setTimeout(() => {
            alert(`Done! Total = ${totalScore}  Avg = ${(totalScore / gameShots).toFixed(1)}`);
          }, 80);
        }
      }
    } else if (!H) {
      // Gentle reminder
      $('#status').textContent = calibrationMode
        ? 'Tap 4 corners (TL, TR, BR, BL)'
        : 'Not calibrated. Tap Re-Calibrate.';
    }

    frameLoop();
  });
}

// ===== Scoring / visuals =====

function scoreBullseye(ptW) {
  const [cx, cy] = BULLSEYE.center;
  const rings = BULLSEYE.rings;
  const pts = BULLSEYE.points;
  const d = Math.hypot(ptW.x - cx, ptW.y - cy);
  for (let i = 0; i < rings.length; i++) {
    if (d <= rings[i]) return pts[i];
  }
  return pts[pts.length - 1];
}

function drawHit(pt, score) {
  ctx.save();
  ctx.strokeStyle = '#00ff73';
  ctx.lineWidth = 3;
  ctx.fillStyle = '#00ff7366';
  ctx.beginPath();
  ctx.arc(pt.x, pt.y, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 20px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('+' + score, pt.x, pt.y - 26);
  ctx.restore();
}

// ===== Red flash detection =====

function detectTransientRed(src) {
  const debug = $('#debugToggle')?.checked;
  const rgb = new cv.Mat();
  const hsv = new cv.Mat();
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB, 0);
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV, 0);

  // HSV red mask
  const m1 = new cv.Mat();
  const m2 = new cv.Mat();
  const maskRed = new cv.Mat();
  const lowS = 110, lowV = 170;
  cv.inRange(
    hsv,
    new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, lowS, lowV, 0]),
    new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [12, 255, 255, 0]),
    m1
  );
  cv.inRange(
    hsv,
    new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [160, lowS, lowV, 0]),
    new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [179, 255, 255, 0]),
    m2
  );
  cv.add(m1, m2, maskRed);

  // R - G
  const ch = new cv.MatVector();
  cv.split(rgb, ch);
  const R = ch.get(0);
  const G = ch.get(1);
  const diff = new cv.Mat();
  cv.subtract(R, G, diff);
  const maskRG = new cv.Mat();
  cv.threshold(diff, maskRG, 36, 255, cv.THRESH_BINARY);

  // Combined masked red area
  const combined = new cv.Mat();
  cv.bitwise_and(maskRed, maskRG, combined);

  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
  cv.morphologyEx(combined, combined, cv.MORPH_OPEN, kernel);

  const sens = parseInt($('#sens').value, 10) || 18;
  const minArea = parseInt($('#minArea').value, 10) || 16;

  let pt = null;
  if (prevMask) {
    const pos = new cv.Mat();
    cv.subtract(combined, prevMask, pos);

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(pos, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area > minArea && area > sens && area > bestArea) {
        const m = cv.moments(c);
        if (m.m00 !== 0) {
          pt = {
            x: Math.round(m.m10 / m.m00),
            y: Math.round(m.m01 / m.m00)
          };
          bestArea = area;
        }
      }
    }

    if (debug) {
      const vis = new cv.Mat();
      cv.cvtColor(pos, vis, cv.COLOR_GRAY2RGBA, 0);
      const smallW = 160;
      const smallH = Math.round(pos.rows * (160 / pos.cols));
      const dsize = new cv.Size(smallW, smallH);
      const small = new cv.Mat();
      cv.resize(vis, small, dsize, 0, 0, cv.INTER_NEAREST);
      const imgData = new ImageData(new Uint8ClampedArray(small.data), smallW, smallH);
      ctx.putImageData(imgData, 8, 8);
      vis.delete();
      small.delete();
    }

    pos.delete();
    contours.delete();
    hierarchy.delete();
  }

  if (prevMask) prevMask.delete();
  prevMask = combined.clone();

  rgb.delete();
  hsv.delete();
  m1.delete();
  m2.delete();
  maskRed.delete();
  diff.delete();
  maskRG.delete();
  combined.delete();
  kernel.delete();
  R.delete();
  G.delete();
  ch.delete();

  return pt;
}

// ===== Sounds + countdown + stats =====

function playBeep() {
  if (!soundOn) return;
  try {
    const ctx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.14);
    audioCtx = ctx;
  } catch (e) {
    const el = document.getElementById('beepAudio');
    if (el) el.play().catch(() => {});
  }
}

function playSteel() {
  if (!soundOn) return;
  try {
    const ctx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume();
    const o1 = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    const g = ctx.createGain();
    o1.type = 'sine';
    o2.type = 'sine';
    o1.frequency.value = 1400;
    o2.frequency.value = 2200;
    const end = ctx.currentTime + 0.2;
    g.gain.setValueAtTime(0.7, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    o1.connect(g);
    o2.connect(g);
    g.connect(ctx.destination);
    o1.start();
    o2.start();
    o1.stop(end);
    o2.stop(end);
    audioCtx = ctx;
  } catch (e) {
    const el = document.getElementById('steelAudio');
    if (el) el.play().catch(() => {});
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function countdown(n) {
  countdownEl.classList.remove('hidden');
  for (let i = n; i > 0; i--) {
    countdownEl.textContent = String(i);
    playBeep();
    await sleep(1000);
  }
  countdownEl.textContent = 'GO!';
  playBeep();
  await sleep(500);
  countdownEl.classList.add('hidden');
}

function updateStats(last = null) {
  $('#lastScore').textContent = last !== null ? last : '—';
  $('#shotsFired').textContent = shotsFired;
  $('#totalScore').textContent = totalScore;
  $('#avgScore').textContent = shotsFired ? (totalScore / shotsFired).toFixed(1) : 0;
}
