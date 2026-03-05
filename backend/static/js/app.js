/**
 * ═══════════════════════════════════════════════════════
 *  ThreatSense AI-DVR · app.js
 *  Frontend logic connecting to the Flask backend.
 *
 *  Backend endpoints used:
 *    POST /upload      — send video file
 *    GET  /video_feed  — MJPEG stream (displayed as <img>)
 *    POST /start       — begin monitoring with feature + points
 *    GET  /get_status  — poll for alert state every 1s
 * ═══════════════════════════════════════════════════════
 */

"use strict";

const App = (() => {
  /* ─────────────────────────────────────────
     CONFIG
  ───────────────────────────────────────── */
  const BASE_URL = "http://127.0.0.1:5000";
  const POLL_MS = 1000; // status polling interval
  const MAX_LOG = 120; // max event log entries

  /* ─────────────────────────────────────────
     STATE
  ───────────────────────────────────────── */
  let state = {
    videoReady: false, // video uploaded & backend ready
    isDrawing: false, // user actively placing points
    isMonitoring: false, // /start has been called
    drawMode: false, // draw mode engaged (btn toggled)
    points: [], // raw canvas points (display coords)
    pollTimer: null,
    uptimeTimer: null,
    uptimeSeconds: 0,
    alertActive: false,
    sessionStart: null,
    detections: 0,
    alerts: 0,
    lastConfidence: 0,
    fpsTimer: null,
    frameCount: 0,
  };

  /* ─────────────────────────────────────────
     DOM REFS
  ───────────────────────────────────────── */
  const $ = (id) => document.getElementById(id);

  const dom = {
    videoInput: $("videoInput"),
    videoFeed: $("videoFeed"),
    videoPlaceholder: $("videoPlaceholder"),
    drawCanvas: $("drawCanvas"),
    alertOverlay: $("alertOverlay"),
    alertMsg: $("alertMsg"),
    alertFlash: $("alertFlash"),
    drawModeBadge: $("drawModeBadge"),

    btnDraw: $("btnDraw"),
    btnStart: $("btnStart"),
    btnClear: $("btnClear"),

    uploadProgress: $("uploadProgress"),
    upBar: $("upBar"),

    featureSelect: $("featureSelect"),
    featureDesc: $("featureDesc"),

    // Nav
    navClock: $("navClock"),
    uptimeDisplay: $("uptimeDisplay"),
    fpsCtr: $("fpsCtr"),
    sysStatus: $("sysStatus"),
    sysDot: $("sysDot"),
    sysLabel: $("sysLabel"),

    // Status card
    statusCard: $("statusCard"),
    statusRing: $("statusRing"),
    sdState: $("sdState"),
    sdMsg: $("sdMsg"),
    statDetections: $("statDetections"),
    statAlerts: $("statAlerts"),
    statSession: $("statSession"),

    // Confidence
    cmFill: $("cmFill"),
    cmVal: $("cmVal"),

    // Event log
    eventLog: $("eventLog"),
    bootTime: $("bootTime"),

    // Points
    pointsDisplay: $("pointsDisplay"),

    // HUD
    hudPoints: $("hudPoints"),
    hudMode: $("hudMode"),
    hudStatus: $("hudStatus"),

    // Badges
    liveBadge: $("liveBadge"),
    feedResolution: $("feedResolution"),

    // Status bar
    sbConnDot: $("sbConnDot"),
    sbConnLabel: $("sbConnLabel"),
    sbFeature: $("sbFeature"),
    sbPoints: $("sbPoints"),
  };

  /* canvas 2D context */
  let ctx = null;

  /* ─────────────────────────────────────────
     FEATURE DESCRIPTIONS
  ───────────────────────────────────────── */
  const featureDescriptions = {
    tripwire: "Draw a line. Any person crossing it triggers an alert.",
    intrusion:
      "Draw a closed polygon zone. Entry by any person triggers an alert.",
    zone: "Define a monitoring zone. Detects and counts persons within the area.",
  };

  /* ─────────────────────────────────────────
     ALERT SOUND (Web Audio API)
  ───────────────────────────────────────── */
  function playAlertSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const play = (freq, start, dur) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g);
        g.connect(ctx.destination);
        o.frequency.value = freq;
        o.type = "square";
        g.gain.setValueAtTime(0.25, ctx.currentTime + start);
        g.gain.exponentialRampToValueAtTime(
          0.001,
          ctx.currentTime + start + dur,
        );
        o.start(ctx.currentTime + start);
        o.stop(ctx.currentTime + start + dur);
      };
      play(880, 0, 0.15);
      play(660, 0.18, 0.15);
      play(880, 0.36, 0.15);
    } catch (e) {
      /* silently skip on unsupported browsers */
    }
  }

  /* ─────────────────────────────────────────
     CLOCK & UPTIME
  ───────────────────────────────────────── */
  function updateClock() {
    const now = new Date();
    dom.navClock.textContent = now.toLocaleTimeString("en-US", {
      hour12: false,
    });
  }

  function startUptime() {
    state.uptimeSeconds = 0;
    state.sessionStart = new Date();
    if (state.uptimeTimer) clearInterval(state.uptimeTimer);
    state.uptimeTimer = setInterval(() => {
      state.uptimeSeconds++;
      const h = String(Math.floor(state.uptimeSeconds / 3600)).padStart(2, "0");
      const m = String(Math.floor((state.uptimeSeconds % 3600) / 60)).padStart(
        2,
        "0",
      );
      const s = String(state.uptimeSeconds % 60).padStart(2, "0");
      dom.uptimeDisplay.textContent = `${h}:${m}:${s}`;
      dom.statSession.textContent = `${h}:${m}:${s}`;
    }, 1000);
  }

  /* ─────────────────────────────────────────
     LOG HELPERS
  ───────────────────────────────────────── */
  function nowTime() {
    return new Date().toLocaleTimeString("en-US", { hour12: false });
  }

  function log(msg, type = "system") {
    const el = document.createElement("div");
    el.className = `log-entry log-${type}`;
    el.innerHTML = `<span class="le-time">${nowTime()}</span><span class="le-msg">${msg}</span>`;
    dom.eventLog.appendChild(el);
    dom.eventLog.scrollTop = dom.eventLog.scrollHeight;

    // Trim to MAX_LOG entries
    const entries = dom.eventLog.querySelectorAll(".log-entry");
    if (entries.length > MAX_LOG) entries[0].remove();
  }

  /* ─────────────────────────────────────────
     SYSTEM STATUS HELPERS
  ───────────────────────────────────────── */
  function setSystemState(state_name, label, msg) {
    // Nav pill
    dom.sysStatus.className = `sys-status state-${state_name}`;
    dom.sysLabel.textContent = label;

    // Status card ring
    dom.statusRing.className = `sd-ring ${state_name === "monitoring" ? "monitoring" : state_name === "alert" ? "alert" : ""}`;
    dom.sdState.textContent = label;
    dom.sdMsg.textContent = msg;

    // HUD
    dom.hudStatus.textContent = `STATUS: ${label}`;
    dom.hudMode.textContent = `MODE: ${dom.featureSelect.value.toUpperCase()}`;

    // Status bar dot
    if (state_name === "monitoring") {
      dom.sbConnDot.className = "sb-dot online";
    } else if (state_name === "alert") {
      dom.sbConnDot.className = "sb-dot alert";
    } else {
      dom.sbConnDot.className = "sb-dot";
    }
    dom.sbConnLabel.textContent = `Backend: ${label}`;
  }

  /* ─────────────────────────────────────────
     CANVAS SETUP
  ───────────────────────────────────────── */
  function initCanvas() {
    const wrapper = dom.videoFeed.parentElement;
    const w = dom.videoFeed.clientWidth || wrapper.clientWidth;
    const h = dom.videoFeed.clientHeight || wrapper.clientHeight;
    dom.drawCanvas.width = w;
    dom.drawCanvas.height = h;
    dom.drawCanvas.style.width = w + "px";
    dom.drawCanvas.style.height = h + "px";
    ctx = dom.drawCanvas.getContext("2d");
  }

  /* ─────────────────────────────────────────
     DRAW BOUNDARY ON CANVAS
  ───────────────────────────────────────── */
  function redrawCanvas() {
    if (!ctx) return;
    ctx.clearRect(0, 0, dom.drawCanvas.width, dom.drawCanvas.height);

    const pts = state.points;
    if (pts.length === 0) return;

    const feature = dom.featureSelect.value;
    const isClosed =
      (feature === "intrusion" || feature === "zone") && pts.length > 2;

    /* Draw filled zone area */
    if (isClosed) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      pts.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fillStyle = "rgba(0, 180, 216, 0.10)";
      ctx.fill();
    }

    /* Draw the line/polygon */
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    pts.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
    if (isClosed) ctx.closePath();

    ctx.strokeStyle = feature === "tripwire" ? "#ff8c00" : "#00e5ff";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 3]);
    ctx.shadowBlur = 8;
    ctx.shadowColor = ctx.strokeStyle;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;

    /* Draw point handles */
    pts.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = feature === "tripwire" ? "#ff8c00" : "#00e5ff";
      ctx.shadowBlur = 10;
      ctx.shadowColor = ctx.fillStyle;
      ctx.fill();
      ctx.shadowBlur = 0;

      // Label
      ctx.font = "10px Share Tech Mono, monospace";
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.fillText(`P${i + 1}`, p.x + 7, p.y - 5);
    });

    // Point count HUD
    dom.hudPoints.textContent = `PTS: ${pts.length}`;
    dom.sbPoints.textContent = `Points: ${pts.length}`;
    renderPointChips();
  }

  /* Render point chips in sidebar */
  function renderPointChips() {
    const pts = state.points;
    if (pts.length === 0) {
      dom.pointsDisplay.innerHTML =
        '<span class="pd-empty">No boundary defined</span>';
      return;
    }
    dom.pointsDisplay.innerHTML = pts
      .map(
        (p, i) =>
          `<span class="pt-chip">P${i + 1} (${Math.round(p.x)},${Math.round(p.y)})</span>`,
      )
      .join("");
  }

  /* ─────────────────────────────────────────
     CANVAS EVENTS (click-to-place)
  ───────────────────────────────────────── */
  function getCanvasPos(e) {
    const rect = dom.drawCanvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  function onCanvasClick(e) {
    if (!state.drawMode) return;
    const pos = getCanvasPos(e);
    state.points.push(pos);
    redrawCanvas();
    log(
      `Point P${state.points.length} placed at (${Math.round(pos.x)}, ${Math.round(pos.y)})`,
      "system",
    );
  }

  function onCanvasDblClick(e) {
    if (!state.drawMode || state.points.length < 2) return;
    // Finish drawing
    toggleDrawMode(false);
    log(`Boundary finalised — ${state.points.length} point(s)`, "ok");
    dom.btnStart.disabled = false;
  }

  /* ─────────────────────────────────────────
     DRAW MODE TOGGLE
  ───────────────────────────────────────── */
  function toggleDrawMode(force) {
    state.drawMode = force !== undefined ? force : !state.drawMode;
    dom.btnDraw.classList.toggle("active", state.drawMode);
    dom.drawCanvas.style.pointerEvents = state.drawMode ? "auto" : "none";
    dom.drawModeBadge.classList.toggle("hidden", !state.drawMode);
    dom.hudMode.textContent = `MODE: ${state.drawMode ? "DRAW" : dom.featureSelect.value.toUpperCase()}`;
  }

  /* ─────────────────────────────────────────
     MAP POINTS TO REAL RESOLUTION
  ───────────────────────────────────────── */
  function getMappedPoints() {
    const img = dom.videoFeed;
    const scaleX = img.naturalWidth / img.clientWidth;
    const scaleY = img.naturalHeight / img.clientHeight;
    return state.points.map((p) => [
      Math.round(p.x * scaleX),
      Math.round(p.y * scaleY),
    ]);
  }

  /* ─────────────────────────────────────────
     UPLOAD VIDEO  →  POST /upload
  ───────────────────────────────────────── */
  async function uploadVideo(file) {
    log(
      `Uploading "${file.name}" (${(file.size / 1024 / 1024).toFixed(1)} MB)`,
      "system",
    );

    dom.uploadProgress.classList.remove("hidden");
    animateUploadBar();

    const formData = new FormData();
    formData.append("video", file);

    try {
      const res = await fetch(`${BASE_URL}/upload`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      dom.uploadProgress.classList.add("hidden");
      dom.upBar.style.width = "0%";

      if (data.status === "ready_to_draw") {
        state.videoReady = true;
        showVideoFeed();
        dom.btnDraw.disabled = false;
        dom.btnClear.disabled = false;
        log(`Upload complete — ready to draw boundary`, "ok");
        setSystemState(
          "ready",
          "READY",
          "Video loaded · Draw a boundary to continue",
        );
        dom.liveBadge.textContent = "READY";
        dom.liveBadge.className = "pm-tag live-tag";
      } else {
        log(`Upload failed: unexpected response`, "alert");
      }
    } catch (err) {
      dom.uploadProgress.classList.add("hidden");
      log(`Upload error: ${err.message}`, "alert");
    }
  }

  /* Fake upload progress animation */
  function animateUploadBar() {
    let pct = 0;
    const t = setInterval(() => {
      pct = Math.min(pct + Math.random() * 12, 90);
      dom.upBar.style.width = pct + "%";
      if (pct >= 90) clearInterval(t);
    }, 200);
    // Complete when upload resolves (caller hides the bar)
    return () => {
      dom.upBar.style.width = "100%";
      clearInterval(t);
    };
  }

  /* ─────────────────────────────────────────
     SHOW VIDEO FEED
  ───────────────────────────────────────── */
  function showVideoFeed() {
    // Prevent browser cache
    dom.videoFeed.src = `${BASE_URL}/video_feed?t=${Date.now()}`;
    dom.videoFeed.classList.remove("hidden");
    dom.videoPlaceholder.classList.add("hidden");
    dom.drawCanvas.classList.remove("hidden");

    dom.videoFeed.onload = () => {
      initCanvas();
      redrawCanvas();
      dom.feedResolution.textContent = `${dom.videoFeed.naturalWidth || "—"}×${dom.videoFeed.naturalHeight || "—"}`;
    };

    // Resize canvas if window resizes
    window.addEventListener("resize", () => {
      if (state.videoReady) {
        initCanvas();
        redrawCanvas();
      }
    });
  }

  /* ─────────────────────────────────────────
     START MONITORING  →  POST /start
  ───────────────────────────────────────── */
  async function startMonitoring() {
    if (state.isMonitoring) return;
    if (state.points.length < 2) {
      log("⚠ Draw at least 2 boundary points first", "alert");
      return;
    }

    const feature = dom.featureSelect.value;
    const mappedPoints = getMappedPoints();

    const payload = { feature, points: mappedPoints };
    log(
      `Sending start command — feature: ${feature}, points: ${mappedPoints.length}`,
      "system",
    );

    try {
      const res = await fetch(`${BASE_URL}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        state.isMonitoring = true;
        state.detections = 0;
        state.alerts = 0;

        // Refresh stream with cache bust
        dom.videoFeed.src = `${BASE_URL}/video_feed?t=${Date.now()}`;

        // Disable draw while monitoring
        toggleDrawMode(false);
        dom.btnDraw.disabled = true;
        dom.btnStart.disabled = true;

        // Update UI state
        dom.btnStart.classList.add("running");
        dom.btnStart.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="2" width="4" height="12"/><rect x="9" y="2" width="4" height="12"/></svg> Monitoring`;
        setSystemState(
          "monitoring",
          "MONITORING",
          `${feature} active · Watching for events`,
        );

        dom.liveBadge.textContent = "LIVE";
        dom.liveBadge.className = "pm-tag live-tag online";

        // Update status bar
        dom.sbFeature.textContent = `Mode: ${feature}`;

        // Begin polling + uptime
        startPolling();
        startUptime();

        log(
          `Monitoring started — ${feature} · ${mappedPoints.length} point(s)`,
          "ok",
        );
      } else {
        log(`Failed to start: server returned ${res.status}`, "alert");
      }
    } catch (err) {
      log(`Start error: ${err.message}`, "alert");
    }
  }

  /* ─────────────────────────────────────────
     POLL STATUS  →  GET /get_status
  ───────────────────────────────────────── */
  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(pollStatus, POLL_MS);
  }

  async function pollStatus() {
    try {
      const res = await fetch(`${BASE_URL}/get_status?t=${Date.now()}`);
      const data = await res.json();

      // Online indicator
      dom.sbConnDot.className = "sb-dot online";
      dom.sbConnLabel.textContent = "Backend: Connected";

      // Update confidence meter (simulate if not in response)
      const conf =
        data.confidence ??
        (data.alert
          ? (80 + Math.random() * 19).toFixed(0)
          : (50 + Math.random() * 30).toFixed(0));
      updateConfidence(parseFloat(conf));

      if (data.alert) {
        handleAlert(data.msg || "BOUNDARY BREACH");
      } else if (state.alertActive) {
        // Alert cleared
        clearAlert();
        log("All clear — no active threat detected", "ok");
        setSystemState(
          "monitoring",
          "MONITORING",
          "Watching · No active alerts",
        );
      }
    } catch (err) {
      // Backend unreachable
      dom.sbConnDot.className = "sb-dot";
      dom.sbConnLabel.textContent = "Backend: Unreachable";
    }
  }

  /* ─────────────────────────────────────────
     ALERT HANDLING
  ───────────────────────────────────────── */
  function handleAlert(msg) {
    if (state.alertActive) return; // already shown
    state.alertActive = true;
    state.alerts++;
    state.detections++;
    dom.statAlerts.textContent = state.alerts;
    dom.statDetections.textContent = state.detections;

    // Show overlay
    dom.alertMsg.textContent = msg;
    dom.alertOverlay.classList.remove("hidden");

    // Flash border
    dom.alertFlash.classList.add("active");

    // Status
    setSystemState("alert", "ALERT", msg);
    dom.statusCard.classList.add("alert");
    dom.liveBadge.textContent = "⚠ ALERT";
    dom.liveBadge.className = "pm-tag live-tag alert-state";

    // Log
    log(`🚨 ALERT: ${msg}`, "alert");

    // Sound
    playAlertSound();
  }

  function clearAlert() {
    state.alertActive = false;
    dom.alertFlash.classList.remove("active");
    dom.statusCard.classList.remove("alert");
    dom.liveBadge.textContent = "LIVE";
    dom.liveBadge.className = "pm-tag live-tag online";
  }

  function dismissAlert() {
    dom.alertOverlay.classList.add("hidden");
    clearAlert();
    log("Alert acknowledged by operator", "system");
  }

  /* ─────────────────────────────────────────
     CONFIDENCE METER
  ───────────────────────────────────────── */
  function updateConfidence(pct) {
    state.lastConfidence = pct;
    dom.cmFill.style.width = pct + "%";
    dom.cmVal.textContent = pct.toFixed(0) + "%";

    dom.cmFill.className = "cm-fill";
    if (pct >= 80) dom.cmFill.classList.add("high");
    else if (pct >= 50) {
      /* default cyan */
    }
    if (state.alertActive) dom.cmFill.classList.add("alert");
  }

  /* ─────────────────────────────────────────
     CLEAR BOUNDARY
  ───────────────────────────────────────── */
  function clearBoundary() {
    state.points = [];
    if (ctx) ctx.clearRect(0, 0, dom.drawCanvas.width, dom.drawCanvas.height);
    dom.pointsDisplay.innerHTML =
      '<span class="pd-empty">No boundary defined</span>';
    dom.hudPoints.textContent = "PTS: 0";
    dom.sbPoints.textContent = "Points: 0";
    dom.btnStart.disabled = true;
    log("Boundary cleared", "system");
  }

  /* ─────────────────────────────────────────
     CLEAR LOG
  ───────────────────────────────────────── */
  function clearLog() {
    dom.eventLog.innerHTML = "";
    log("Event log cleared", "system");
  }

  /* ─────────────────────────────────────────
     FEATURE SELECT CHANGE
  ───────────────────────────────────────── */
  function onFeatureChange() {
    const val = dom.featureSelect.value;
    dom.featureDesc.textContent = featureDescriptions[val] || "";
    dom.sbFeature.textContent = `Mode: ${val}`;
    log(`Detection mode changed to: ${val}`, "system");
    // Clear existing boundary when mode changes
    clearBoundary();
  }

  /* ─────────────────────────────────────────
     BACKEND PING (initial connection check)
  ───────────────────────────────────────── */
  async function pingBackend() {
    try {
      // Use a lightweight endpoint; /get_status is fine
      const res = await fetch(`${BASE_URL}/get_status`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        dom.sbConnDot.className = "sb-dot online";
        dom.sbConnLabel.textContent = "Backend: Connected";
        log("Backend connection established", "ok");
      }
    } catch {
      dom.sbConnDot.className = "sb-dot";
      dom.sbConnLabel.textContent = "Backend: Offline — start Flask server";
      log("⚠ Backend not reachable at http://127.0.0.1:5000", "alert");
    }
  }

  /* ─────────────────────────────────────────
     INIT
  ───────────────────────────────────────── */
  function init() {
    /* Clock */
    setInterval(updateClock, 1000);
    updateClock();
    dom.bootTime.textContent = nowTime();

    /* Feature desc */
    dom.featureDesc.textContent = featureDescriptions["tripwire"];

    /* Video file input */
    dom.videoInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) uploadVideo(file);
    });

    /* Draw button */
    dom.btnDraw.addEventListener("click", () => {
      if (!state.videoReady) return;
      toggleDrawMode();
      log(
        state.drawMode
          ? "Draw mode ON — click to place points, double-click to finish"
          : "Draw mode OFF",
        "system",
      );
    });

    /* Start button */
    dom.btnStart.addEventListener("click", () => {
      if (!state.isMonitoring) startMonitoring();
    });

    /* Clear button */
    dom.btnClear.addEventListener("click", clearBoundary);

    /* Feature select */
    dom.featureSelect.addEventListener("change", onFeatureChange);

    /* Canvas events */
    dom.drawCanvas.addEventListener("click", onCanvasClick);
    dom.drawCanvas.addEventListener("dblclick", onCanvasDblClick);

    /* Disable right-click on canvas */
    dom.drawCanvas.addEventListener("contextmenu", (e) => e.preventDefault());

    /* Initial backend ping */
    pingBackend();

    /* Keyboard shortcut: Escape → dismiss alert */
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.alertActive) dismissAlert();
    });

    /* Status bar initial */
    dom.sbFeature.textContent = "Mode: tripwire";

    log("ThreatSense AI-DVR ready · Upload a video to begin", "system");
  }

  /* ─────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────── */
  return {
    init,
    dismissAlert,
    clearLog,
  };
})();

/* Boot */
document.addEventListener("DOMContentLoaded", App.init);
