let pts = [];
let drawing = false;
let monitoring = false;
let lastTime = "";

const videoPreview = document.getElementById("videoPreview");
const videoFeed = document.getElementById("videoFeed");
const canvas = document.getElementById("drawCanvas");
const ctx = canvas.getContext("2d");
const btnStart = document.getElementById("btnStart");
const eventLog = document.getElementById("eventLog");

function syncCanvas() {
  canvas.width = videoPreview.clientWidth;
  canvas.height = videoPreview.clientHeight;
}

canvas.addEventListener("mousedown", (e) => {
  if (monitoring) return;

  drawing = true;
  pts = [];

  const rect = canvas.getBoundingClientRect();

  pts.push([e.clientX - rect.left, e.clientY - rect.top]);
});

canvas.addEventListener("mousemove", (e) => {
  if (!drawing) return;

  const rect = canvas.getBoundingClientRect();

  pts.push([e.clientX - rect.left, e.clientY - rect.top]);

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "#00f2ff";
  ctx.lineWidth = 3;

  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);

  pts.forEach((p) => ctx.lineTo(p[0], p[1]));

  ctx.stroke();
});

canvas.addEventListener("mouseup", () => (drawing = false));

document.getElementById("videoInput").addEventListener("change", async (e) => {
  const form = new FormData();

  form.append("video", e.target.files[0]);

  let r = await fetch("/upload", { method: "POST", body: form });

  let data = await r.json();

  videoPreview.src = "/uploads/" + data.filename;

  videoPreview.onloadedmetadata = () => {
    videoPreview.play();

    videoPreview.classList.remove("hidden");

    syncCanvas();

    btnStart.disabled = false;
  };
});

btnStart.addEventListener("click", async () => {
  if (monitoring) {
    await fetch("/stop", { method: "POST" });
    location.reload();
    return;
  }

  const scaleX = videoPreview.videoWidth / canvas.width;
  const scaleY = videoPreview.videoHeight / canvas.height;

  const scaledPoints = pts.map((p) => [
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

      color: document.getElementById("colorInput").value || "red",

      points: scaledPoints,
    }),
  });

  monitoring = true;

  videoPreview.classList.add("hidden");
  canvas.classList.add("hidden");

  videoFeed.src = "/video_feed?t=" + Date.now();

  videoFeed.classList.remove("hidden");

  startPolling();
});

function startPolling() {
  setInterval(async () => {
    if (!monitoring) return;

    let r = await fetch("/status");

    let d = await r.json();

    if (d.alert && d.time !== lastTime) {
      lastTime = d.time;

      const entry = document.createElement("div");

      entry.className = "text-red-400 mb-1";

      entry.innerHTML = `[${d.time}] ${d.msg}`;

      eventLog.prepend(entry);
    }
  }, 1000);
}
