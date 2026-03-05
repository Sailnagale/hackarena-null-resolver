let pts = [];
let monitoring = false;

// Elements
const canvas = document.getElementById("drawCanvas");
const ctx = canvas.getContext("2d");
const videoFeed = document.getElementById("videoFeed");
const videoPlaceholder = document.getElementById("videoPlaceholder");
const btnStart = document.getElementById("btnStart");
const btnClear = document.getElementById("btnClear");
const eventLog = document.getElementById("eventLog");

// ─── UPLOAD HANDLER ───
document.getElementById("videoInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  addLog("Uploading video file...", "system");
  const formData = new FormData();
  formData.append("video", file);

  try {
    const res = await fetch("/upload", { method: "POST", body: formData });
    const data = await res.json();

    if (data.status === "ready_to_draw") {
      videoPlaceholder.classList.add("hidden");
      videoFeed.classList.remove("hidden");
      canvas.classList.remove("hidden");

      document.getElementById("btnDraw").disabled = false;
      btnClear.disabled = false;
      document.getElementById("sysLabel").innerText = "READY";
      document.getElementById("sysStatus").className = "sys-status state-ready";

      addLog("Upload complete. Define boundary points.", "ok");
      resizeCanvas();
    }
  } catch (err) {
    addLog("Upload failed: Connection error", "alert");
  }
});

// ─── DRAWING LOGIC ───
function resizeCanvas() {
  const wrapper = canvas.parentElement;
  canvas.width = wrapper.clientWidth;
  canvas.height = wrapper.clientHeight;
}

canvas.addEventListener("mousedown", (e) => {
  if (monitoring) return;
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (canvas.width / rect.width);
  const y = (e.clientY - rect.top) * (canvas.height / rect.height);
  pts.push([x, y]);

  // Update the HUD points count
  document.getElementById("hudPoints").innerText = `PTS: ${pts.length}`;
  document.getElementById("sbPoints").innerText = `Points: ${pts.length}`;

  draw();
});

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (pts.length < 1) return;

  ctx.strokeStyle = "#00e5ff";
  ctx.lineWidth = 2;
  ctx.shadowBlur = 10;
  ctx.shadowColor = "#00e5ff";
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);

  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(pts[i][0], pts[i][1]);
  }
  ctx.stroke();
  btnStart.disabled = pts.length < 2;
}

// ─── CONTROL BUTTONS ───
btnClear.addEventListener("click", () => {
  pts = [];
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  btnStart.disabled = true;
  document.getElementById("hudPoints").innerText = `PTS: 0`;
  addLog("Boundary cleared.", "system");
});

btnStart.addEventListener("click", startMonitoring);

async function startMonitoring() {
  const mode = document.getElementById("featureSelect").value;
  const res = await fetch("/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ feature: mode, points: pts }),
  });

  if (res.ok) {
    monitoring = true;
    videoFeed.src = "/video_feed"; // Starts the Flask stream

    // Update UI States
    document.getElementById("sysStatus").className =
      "sys-status state-monitoring";
    document.getElementById("sysLabel").innerText = "MONITORING";
    document.getElementById("sdState").innerText = "ACTIVE";
    btnStart.classList.add("running");
    addLog(`Surveillance started: ${mode}`, "system");
  }
}

// ─── UTILITIES ───
function addLog(msg, type) {
  const entry = document.createElement("div");
  entry.className = `log-entry log-${type}`;
  const time = new Date().toLocaleTimeString([], { hour12: false });
  entry.innerHTML = `<span class="le-time">${time}</span> <span class="le-msg">${msg}</span>`;
  eventLog.prepend(entry);
}

window.addEventListener("resize", resizeCanvas);
