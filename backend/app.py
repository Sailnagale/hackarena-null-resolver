import os, cv2, time, json, numpy as np
from flask import Flask, render_template, Response, request, jsonify
from ultralytics import YOLO
from datetime import datetime
from twilio.rest import Client
from dotenv import load_dotenv

load_dotenv()
app = Flask(__name__)

# --- CONFIG ---
ACC_SID = os.getenv("TWILIO_ACCOUNT_SID")
AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN")
WHATSAPP_FROM = os.getenv("TWILIO_WHATSAPP_FROM")
TARGET_WHATSAPP = os.getenv("TARGET_WHATSAPP")
twilio_client = Client(ACC_SID, AUTH_TOKEN) if ACC_SID else None

# Core AI Model
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
    """Dispatches WhatsApp alerts via Twilio API."""
    if not twilio_client: return
    try:
        twilio_client.messages.create(from_=WHATSAPP_FROM, body=f"🚨 ALERT: {msg}", to=TARGET_WHATSAPP)
    except Exception as e: print(f"Twilio Error: {e}")

def is_red_shirt(crop):
    """Detects red-colored clothing in the torso region."""
    if crop.size == 0: return False
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    mask1 = cv2.inRange(hsv, (0, 70, 50), (10, 255, 255))
    mask2 = cv2.inRange(hsv, (160, 70, 50), (180, 255, 255))
    mask = cv2.bitwise_or(mask1, mask2)
    return (np.count_nonzero(mask) / (crop.shape[0] * crop.shape[1])) > 0.18

def generate_frames():
    """Main processing loop for frame-by-frame AI analysis."""
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
                active_threats = []

                if results[0].boxes.id is not None:
                    boxes = results[0].boxes.xyxy.cpu().numpy()
                    track_ids = results[0].boxes.id.int().cpu().numpy()
                    cls_ids = results[0].boxes.cls.int().cpu().numpy()

                    # 1. Background Feature: Crowd Density
                    if len(track_ids) >= 5:
                        alert_frame = True
                        active_threats.append("High Density Crowd")

                    for box, tid, cid in zip(boxes, track_ids, cls_ids):
                        x1, y1, x2, y2 = map(int, box)
                        cx, cy = (x1 + x2) // 2, y2

                        # 2. Background Feature: Suspect (Red Shirt)
                        torso = frame[y1 + 10 : y1 + (y2-y1)//2, x1 + 5 : x2 - 5]
                        if is_red_shirt(torso):
                            alert_frame = True
                            active_threats.append("Suspect (Red Shirt)")

                        # 3. Mode-Specific Boundary Logic
                        if len(state["polygon_pts"]) >= 2:
                            dist = cv2.pointPolygonTest(np.array(state["polygon_pts"], np.int32), (cx, cy), True)
                            
                            # TRIPWIRE: Only fence requires area check; tripwire uses proximity
                            if state["selected_feature"] == "tripwire":
                                if abs(dist) < 20: 
                                    alert_frame = True
                                    active_threats.append(f"{model.names[cid].upper()} Crossing")
                            # INTRUSION/ZONE: Require center point to be INSIDE the polygon
                            else:
                                if dist >= 0:
                                    alert_frame = True
                                    active_threats.append(f"{model.names[cid].upper()} Breach")

                        # 4. Background Feature: Conflict / Agitation
                        if tid in state["prev_centers"]:
                            px, py = state["prev_centers"][tid]
                            speed = np.sqrt((cx-px)**2 + (cy-py)**2)
                            state["agitation_score"][tid] = state["agitation_score"].get(tid, 0) + (1.5 if speed > 16 else -0.2)
                            if state["agitation_score"][tid] > 4: 
                                alert_frame = True
                                active_threats.append("Conflict")
                        
                        state["prev_centers"][tid] = (cx, cy)
                        cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 0, 255) if alert_frame else (0, 255, 0), 2)

                # UI Status Update & Notification
                msg = " | ".join(set(active_threats)) if active_threats else "Normal Operation"
                if alert_frame:
                    state["persistence_timer"] = 60
                    if time.time() - state["last_alert_time"] > 30:
                        send_whatsapp(msg); state["last_alert_time"] = time.time()
                else:
                    state["persistence_timer"] = max(0, state["persistence_timer"] - 1)

                state["current_status"] = {"alert": state["persistence_timer"] > 0, "msg": msg}
                
                # Visual Boundary Drawing
                if len(state["polygon_pts"]) > 1:
                    is_closed = state["selected_feature"] != "tripwire"
                    cv2.polylines(frame, [np.array(state["polygon_pts"], np.int32)], is_closed, (0, 255, 255), 2)

            _, buffer = cv2.imencode('.jpg', frame)
            yield (b'--frame\r\n' b'Content-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')
        cap.release()

@app.route('/')
def index(): return render_template('index.html')

@app.route('/upload', methods=['POST'])
def upload():
    """Handles video file uploads and ensures correct directory structure."""
    if 'video' not in request.files:
        return jsonify({"error": "No file uploaded"}), 400
    
    file = request.files['video']
    upload_dir = os.path.join(os.getcwd(), "uploads")
    
    if not os.path.exists(upload_dir):
        os.makedirs(upload_dir)
        
    path = os.path.join(upload_dir, file.filename)
    file.save(path)
    state["active_video"] = path
    return jsonify({"status": "ready_to_draw", "filename": file.filename})

@app.route('/start', methods=['POST'])
def start():
    data = request.json
    state.update({"selected_feature": data['feature'], "polygon_pts": data['points'], "is_monitoring": True})
    return jsonify({"status": "ok"})

@app.route('/get_status')
def get_status(): return jsonify(state["current_status"])

@app.route('/video_feed')
def video_feed(): return Response(generate_frames(), mimetype='multipart/x-mixed-replace; boundary=frame')

if __name__ == '__main__': 
    app.run(debug=True, port=5000)