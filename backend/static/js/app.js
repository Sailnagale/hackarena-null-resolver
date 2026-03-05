let pts = [];
let drawing = false;
let monitoring = false;
let lastMsg = "";

const videoPreview = document.getElementById("videoPreview");
const videoFeed = document.getElementById("videoFeed");
const canvas = document.getElementById("drawCanvas");
const ctx = canvas.getContext("2d");
const eventLog = document.getElementById("eventLog");

/* ----------------- AUDIO ALERT ----------------- */

function speak(msg) {
  const speech = new SpeechSynthesisUtterance(msg);
  speech.lang = "en-US";
  window.speechSynthesis.speak(speech);
}

/* ----------------- POPUP ALERT ----------------- */

function popup(msg) {
  const box = document.createElement("div");

  box.className =
    "fixed top-6 right-6 bg-red-600 text-white p-4 rounded shadow-lg z-50";

  box.innerText = "🚨 " + msg;

  document.body.appendChild(box);

  setTimeout(() => box.remove(), 4000);
}

/* ----------------- CANVAS SYNC ----------------- */

function syncCanvas() {
  canvas.width = videoPreview.clientWidth;
  canvas.height = videoPreview.clientHeight;

  canvas.style.width = videoPreview.clientWidth + "px";
  canvas.style.height = videoPreview.clientHeight + "px";
}

/* ----------------- TRIPWIRE DRAWING ----------------- */

canvas.addEventListener("mousedown", (e) => {
  if (monitoring) return;

  if (document.getElementById("featureSelect").value !== "tripwire") return;

  drawing = true;
  pts = [];

  const rect = canvas.getBoundingClientRect();

  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  pts.push([x, y]);
});

canvas.addEventListener("mousemove", (e) => {
  if (!drawing) return;

  const rect = canvas.getBoundingClientRect();

  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  pts.push([x, y]);

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "#00f2ff";
  ctx.lineWidth = 3;

  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);

  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(pts[i][0], pts[i][1]);
  }

  ctx.stroke();
});

canvas.addEventListener("mouseup", () => {
  drawing = false;
});

/* ----------------- VIDEO UPLOAD ----------------- */

document.getElementById("videoInput").addEventListener("change", async (e) => {
  const form = new FormData();
  form.append("video", e.target.files[0]);

  let r = await fetch("/upload", { method: "POST", body: form });

  let data = await r.json();

  videoPreview.src = "/uploads/" + data.filename;

  videoPreview.classList.remove("hidden");

  videoPreview.onloadedmetadata = () => {
    videoPreview.play();

    syncCanvas();

    canvas.style.zIndex = 20;
  };
});

/* ----------------- START MONITORING ----------------- */

async function startMonitoring() {
  const scaleX = videoPreview.videoWidth / canvas.width;
  const scaleY = videoPreview.videoHeight / canvas.height;

  const scaled = pts.map((p) => [
    Math.round(p[0] * scaleX),
    Math.round(p[1] * scaleY),
  ]);

  await fetch("/start", {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
    },

    body: JSON.stringify({
      feature: document.getElementById("featureSelect").value,
      color: document.getElementById("colorInput").value,
      points: scaled,
    }),
  });

  monitoring = true;

  videoPreview.classList.add("hidden");
  canvas.classList.add("hidden");

  videoFeed.src = "/video_feed?t=" + Date.now();

  videoFeed.classList.remove("hidden");

  poll();
}

document.getElementById("startBtn").onclick = startMonitoring;

/* ----------------- STOP ----------------- */

document.getElementById("stopBtn").onclick = async () => {
  await fetch("/stop", { method: "POST" });

  monitoring = false;

  location.reload();
};

/* ----------------- RESTART ----------------- */

document.getElementById("restartBtn").onclick = () => {
  location.reload();
};

/* ----------------- STATUS POLLING ----------------- */

function poll() {
  setInterval(async () => {
    if (!monitoring) return;

    const r = await fetch("/status");

    const d = await r.json();

    if (!d.alert) return;

    if (d.msg === lastMsg) return;

    lastMsg = d.msg;

    const entry = document.createElement("div");

    entry.className = "text-red-400";

    entry.innerHTML = `[${d.time}] ${d.msg}`;

    eventLog.prepend(entry);

    popup(d.msg);

    speak(d.msg);
  }, 1000);
}
