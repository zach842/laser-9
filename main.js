/* Laser Trainer PWA — Pi-connected version
   - No camera / OpenCV in the browser
   - UI only: countdown, game modes, sounds, stats
   - Talks to Pi over HTTP:
       POST /start_game    {shots}
       POST /stop_game
       GET  /stats
*/

const $ = sel => document.querySelector(sel);

// >>> SET THIS TO YOUR PI'S ADDRESS <<<
let PI_BASE = "http://localhost:5000";
// If raspberrypi.local doesn't resolve, change to e.g. "http://192.168.1.42:5000"

let soundOn = true;
let audioCtx = null;

let polling = false;
let pollTimer = null;
let localRunning = false;

let gameShots = 10;

// DOM refs (guarded so we don't crash if something's missing)
let countdownEl, statusEl;
let lastScoreEl, shotsFiredEl, totalScoreEl, avgScoreEl;

function init() {
  countdownEl = $("#countdown");
  statusEl = $("#status");
  lastScoreEl = $("#lastScore");
  shotsFiredEl = $("#shotsFired");
  totalScoreEl = $("#totalScore");
  avgScoreEl = $("#avgScore");

  const startBtn = $("#startBtn");
  const stopBtn = $("#stopBtn"); // optional, may not exist
  const gameSelect = $("#gameSelect");
  const settingsBtn = $("#settingsBtn");
  const closeDrawer = $("#closeDrawer");
  const soundToggle = $("#soundToggle");
  const themeToggle = $("#themeToggle");
  const resetScores = $("#resetScores");

  if (statusEl) {
    statusEl.textContent = "Connect to Pi, then select a game and tap START.";
  }

  if (settingsBtn && closeDrawer) {
    settingsBtn.onclick = () => $("#drawer").classList.add("open");
    closeDrawer.onclick = () => $("#drawer").classList.remove("open");
  }

  if (soundToggle) {
    soundToggle.onchange = e => { soundOn = e.target.checked; };
  }

  if (themeToggle) {
    themeToggle.onchange = e => {
      document.body.classList.toggle("dark", e.target.checked);
    };
  }

  if (resetScores) {
    resetScores.onclick = () => {
      // Browser-only reset; Pi keeps its own stats per game.
      updateStats(null, 0, 0, 0);
      alert("Stats reset (this device view only). Start a new game to sync with Pi.");
    };
  }

  if (gameSelect) {
    gameSelect.onchange = e => {
      gameShots = parseInt(e.target.value, 10) || 10;
    };
    // Initialize from current selection
    gameShots = parseInt(gameSelect.value || "10", 10);
  }

  if (startBtn) {
    startBtn.onclick = onStartClicked;
  }

  if (stopBtn) {
    stopBtn.onclick = stopGameOnPi;
  }
}

window.addEventListener("DOMContentLoaded", init);

// ---------------- Pi API helpers ----------------

async function pingPi() {
  try {
    const resp = await fetch(PI_BASE + "/ping", { method: "GET" });
    if (!resp.ok) throw new Error("bad status " + resp.status);
    const data = await resp.json();
    if (statusEl) statusEl.textContent = "Pi: " + (data.status || "online");
    return true;
  } catch (err) {
    console.error("pingPi failed:", err);
    if (statusEl) statusEl.textContent = "Pi offline or unreachable.";
    return false;
  }
}

async function startGameOnPi(shots) {
  const body = JSON.stringify({ shots: shots || 10 });
  const resp = await fetch(PI_BASE + "/start_game", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
  if (!resp.ok) {
    const msg = "Pi /start_game failed: " + resp.status;
    console.error(msg);
    throw new Error(msg);
  }
  const data = await resp.json();
  return data;
}

async function stopGameOnPi() {
  try {
    const resp = await fetch(PI_BASE + "/stop_game", { method: "POST" });
    if (!resp.ok) throw new Error("bad status " + resp.status);
    const data = await resp.json();
    localRunning = false;
    stopPolling();
    if (statusEl) statusEl.textContent = "Stopped by user.";
    return data;
  } catch (err) {
    console.error("stopGameOnPi failed:", err);
  }
}

async function fetchStats() {
  const resp = await fetch(PI_BASE + "/stats", { method: "GET" });
  if (!resp.ok) throw new Error("bad status " + resp.status);
  return resp.json();
}

// ---------------- Game flow ----------------

async function onStartClicked() {
  if (localRunning) return;

  // Make sure Pi is reachable first
  const ok = await pingPi();
  if (!ok) {
    alert("Could not reach Pi at:\n" + PI_BASE + "\n\nUpdate PI_BASE in main.js or check network.");
    return;
  }

  try {
    // Warm-up audio on first interaction (for iOS/Chrome auto-play rules)
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();
  } catch (e) {
    console.warn("AudioContext resume failed:", e);
  }

  // Countdown before we actually tell the Pi to start
  if (statusEl) statusEl.textContent = "Get ready…";
  await countdown(10);

  // Tell the Pi to start the game
  try {
    if (statusEl) statusEl.textContent = "Starting game on Pi…";
    await startGameOnPi(gameShots);
  } catch (err) {
    console.error(err);
    alert("Pi /start_game failed. Check Pi and try again.");
    if (statusEl) statusEl.textContent = "Failed to start on Pi.";
    return;
  }

  localRunning = true;
  if (statusEl) statusEl.textContent = "Running: " + gameShots + "-shot game.";
  startPolling();
}

function startPolling() {
  if (polling) return;
  polling = true;

  const poll = async () => {
    if (!polling) return;
    try {
      const data = await fetchStats();
      const running = data.running;
      const status = data.status || "";
      const shots = data.shots || 0;
      const shotsGoal = data.shots_goal || gameShots;
      const last = data.last_score ?? null;
      const total = data.total_score || 0;
      const avg = data.avg_score || 0;

      updateStats(last, shots, total, avg);

      if (statusEl) {
        if (status === "finished") {
          statusEl.textContent = "Finished (" + shots + "/" + shotsGoal + ")";
        } else if (status === "running") {
          statusEl.textContent = "Running (" + shots + "/" + shotsGoal + ")";
        } else {
          statusEl.textContent = "Pi: " + status;
        }
      }

      // If Pi says finished, stop polling
      if (!running && status === "finished") {
        localRunning = false;
        polling = false;
        if (pollTimer) clearTimeout(pollTimer);

        setTimeout(() => {
          alert("Game finished.\nTotal: " + total + "\nAvg: " + avg.toFixed(1));
        }, 100);
        return;
      }
    } catch (err) {
      console.error("pollStats error:", err);
      if (statusEl) statusEl.textContent = "Lost contact with Pi.";
      // We could stop polling or keep trying; for now keep trying slowly
    }

    pollTimer = setTimeout(poll, 250);
  };

  poll();
}

function stopPolling() {
  polling = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

// ---------------- UI helpers ----------------

function updateStats(lastScore, shots, total, avg) {
  if (lastScoreEl) {
    lastScoreEl.textContent = lastScore !== null && lastScore !== undefined ? lastScore : "—";
  }
  if (shotsFiredEl) {
    shotsFiredEl.textContent = shots != null ? shots : 0;
  }
  if (totalScoreEl) {
    totalScoreEl.textContent = total != null ? total : 0;
  }
  if (avgScoreEl) {
    avgScoreEl.textContent = avg != null ? avg.toFixed(1) : "0.0";
  }
}

const sleep = ms => new Promise(res => setTimeout(res, ms));

const sleep = ms => new Promise(res => setTimeout(res, ms));

async function countdown(n) {
  const overlay = document.getElementById("countdownOverlay");
  const text = document.getElementById("countdownText");
  const sub = document.getElementById("cdSubtext");
  if (!overlay || !text || !sub) return;

  // Show overlay
  overlay.classList.remove("hidden", "cd-cool", "cd-hot", "cd-go");
  overlay.classList.add("cd-cool");
  sub.textContent = "STANDBY";

  for (let i = n; i > 0; i--) {
    text.textContent = i;

    if (i > 3) {
      // Cool phase: STANDBY
      overlay.classList.remove("cd-hot");
      overlay.classList.add("cd-cool");
      sub.textContent = "STANDBY";
    } else {
      // Hot phase: ARMED (3..1)
      overlay.classList.remove("cd-cool");
      overlay.classList.add("cd-hot");
      sub.textContent = "ARMED";
    }

    playBeep();
    await sleep(1000);
  }

  // GO phase
  overlay.classList.remove("cd-cool", "cd-hot");
  overlay.classList.add("cd-go");
  text.textContent = "GO";
  sub.textContent = "ENGAGE";
  playBeep();
  await sleep(600);

  overlay.classList.add("hidden");
  overlay.classList.remove("cd-go");
}
// ---------------- Sounds ----------------

function playBeep() {
  if (!soundOn) return;
  try {
    const ctx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.14);
    audioCtx = ctx;
  } catch (e) {
    const el = $("#beepAudio");
    if (el) {
      el.currentTime = 0;
      el.play().catch(() => {});
    }
  }
}

function playSteel() {
  // We are not triggering steel directly here, because Pi does not send per-hit notifications yet.
  // Later we can extend /stats or add a /hits stream for sound per hit.
  if (!soundOn) return;
  try {
    const ctx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume();
    const o1 = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    const g = ctx.createGain();
    o1.type = "sine";
    o2.type = "sine";
    o1.frequency.value = 1400;
    o2.frequency.value = 2200;
    const end = ctx.currentTime + 0.18;
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
    const el = $("#steelAudio");
    if (el) {
      el.currentTime = 0;
      el.play().catch(() => {});
    }
  }
}
