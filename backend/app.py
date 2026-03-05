import os, cv2, time, json, numpy as np
from flask import Flask, render_template, Response, request, jsonify
from ultralytics import YOLO
from datetime import datetime
from twilio.rest import Client
from dotenv import load_dotenv

load_dotenv()
app = Flask(__name__)

# --- TWILIO CONFIG ---
ACC_SID = os.getenv("TWILIO_ACCOUNT_SID")
AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN")
WHATSAPP_FROM = os.getenv("TWILIO_WHATSAPP_FROM")
TARGET_WHATSAPP = os.getenv("TARGET_WHATSAPP")
twilio_client = Client(ACC_SID, AUTH_TOKEN) if ACC_SID else None

# --- AI CONFIG ---
model = YOLO('yolo11n.pt')
target_classes = [0, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23] 
state = {
    "active_video": None,
    "polygon_pts": [],
    "selected_feature": "tripwire",
    "is_monitoring": False,
    "current_status": {"alert": False, "msg": "STANDBY"},
    "last_alert_time": 0,
    "prev_centers": {},
    "agitation_score": {},
    "persistence_timer": 0
}

def send_whatsapp(msg):
    if not twilio_client: return
    try:
        twilio_client.messages.create(from_=WHATSAPP_FROM, body=f"🚨 ALERT: {msg}", to=TARGET_WHATSAPP)
    except Exception as e: print(f"Twilio Error: {e}")

def is_red_shirt(crop):
    if crop.size == 0: return False
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    mask1 = cv2.inRange(hsv, (0, 70, 50), (10, 255, 255))
    mask2 = cv2.inRange(hsv, (160, 70, 50), (180, 255, 255))
    mask = cv2.bitwise_or(mask1, mask2)
    return (np.sum(mask > 0) / (crop.shape[0] * crop.shape[1] * 3)) > 0.15

def generate_frames():
    while True:
        if not state["active_video"]:
            time.sleep(0.1); continue
        
        cap = cv2.VideoCapture(state["active_video"])
        while cap.isOpened():
            success, frame = cap.read()
            if not success: break

            if state["is_monitoring"]:
                results = model.track(frame, persist=True, classes=target_classes, verbose=False, imgsz=320)
                alert_frame = False
                msg = "Normal Operation"

                if results[0].boxes.id is not None:
                    boxes = results[0].boxes.xyxy.cpu().numpy()
                    track_ids = results[0].boxes.id.int().cpu().numpy()
                    cls_ids = results[0].boxes.cls.int().cpu().numpy()

                    if state["selected_feature"] == "zone" and len(track_ids) >= 5:
                        alert_frame, msg = True, "High Density Crowd"

                    for box, tid, cid in zip(boxes, track_ids, cls_ids):
                        x1, y1, x2, y2 = map(int, box)
                        cx, cy = (x1 + x2) // 2, y2

                        # 1. Red Shirt Search
                        if is_red_shirt(frame[y1:y1+(y2-y1)//3, x1:x2]):
                            alert_frame, msg = True, "Suspect (Red Shirt) Spotted"

                        # 2. Boundary Logic
                        if len(state["polygon_pts"]) >= 2:
                            dist = cv2.pointPolygonTest(np.array(state["polygon_pts"], np.int32), (cx, cy), True)
                            if abs(dist) < 20: alert_frame, msg = True, f"{model.names[cid].upper()} Breach"

                        # 3. Conflict Logic
                        if tid in state["prev_centers"]:
                            px, py = state["prev_centers"][tid]
                            speed = np.sqrt((cx-px)**2 + (cy-py)**2)
                            state["agitation_score"][tid] = state["agitation_score"].get(tid, 0) + (1 if speed > 16 else -0.1)
                            if state["agitation_score"][tid] > 4: alert_frame, msg = True, "Conflict Detected"
                        
                        state["prev_centers"][tid] = (cx, cy)
                        cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)

                if alert_frame:
                    state["persistence_timer"] = 60
                    if time.time() - state["last_alert_time"] > 30:
                        send_whatsapp(msg); state["last_alert_time"] = time.time()
                else:
                    state["persistence_timer"] = max(0, state["persistence_timer"] - 1)

                state["current_status"] = {"alert": state["persistence_timer"] > 0, "msg": msg}
                if len(state["polygon_pts"]) > 1:
                    cv2.polylines(frame, [np.array(state["polygon_pts"], np.int32)], False, (0, 255, 255), 2)

            _, buffer = cv2.imencode('.jpg', frame)
            yield (b'--frame\r\n' b'Content-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')
        cap.release()

@app.route('/')
def index(): return render_template('index.html')

@app.route('/upload', methods=['POST'])
def upload():
    file = request.files['video']
    path = os.path.join("uploads", file.filename)
    if not os.path.exists("uploads"): os.makedirs("uploads")
    file.save(path); state["active_video"] = path
    return jsonify({"status": "ready_to_draw"})

@app.route('/start', methods=['POST'])
def start():
    data = request.json
    state.update({"selected_feature": data['feature'], "polygon_pts": data['points'], "is_monitoring": True})
    return jsonify({"status": "ok"})

@app.route('/get_status')
def get_status(): return jsonify(state["current_status"])

@app.route('/video_feed')
def video_feed(): return Response(generate_frames(), mimetype='multipart/x-mixed-replace; boundary=frame')

if __name__ == '__main__': app.run(debug=True, port=5000)