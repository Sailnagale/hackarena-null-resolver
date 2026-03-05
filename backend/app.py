import os
import cv2
import time
import numpy as np
from datetime import datetime
from flask import Flask, render_template, Response, request, jsonify, send_from_directory
from ultralytics import YOLO

app = Flask(__name__)

UPLOAD_FOLDER = "uploads"
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

model = YOLO("yolo11n.pt")

# ---------------- SYSTEM STATE ----------------

state = {
    "video": None,
    "monitor": False,
    "feature": "master",
    "color": "red",
    "points": [],
    "last_alert": 0,
    "status": {"alert": False, "msg": "", "time": ""}
}

# movement tracking
prev_centers = {}
agitation_score = {}

alert_persistence_timer = 0


# ---------------- COLOR DETECTION ----------------

def check_color(crop, color):

    if crop is None or crop.size == 0:
        return False

    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)

    ranges = {
        "red":[((0,100,100),(10,255,255)),((160,100,100),(180,255,255))],
        "blue":[((100,150,0),(140,255,255))],
        "green":[((35,100,100),(85,255,255))]
    }

    target = ranges.get(color,ranges["red"])

    mask=None

    for low,high in target:

        m=cv2.inRange(hsv,np.array(low),np.array(high))

        mask=cv2.bitwise_or(mask,m) if mask is not None else m

    ratio=np.sum(mask>0)/(crop.shape[0]*crop.shape[1])

    return ratio>0.15


# ---------------- VIDEO ENGINE ----------------

def generate_frames():

    global alert_persistence_timer

    while True:

        if not state["monitor"] or state["video"] is None:
            time.sleep(0.1)
            continue

        cap=cv2.VideoCapture(state["video"])

        while cap.isOpened() and state["monitor"]:

            ret,frame=cap.read()

            if not ret:
                break

            results=model.track(frame,persist=True,classes=[0],verbose=False,imgsz=320)

            pts=np.array(state["points"],np.int32)

            if len(pts)>1:
                cv2.polylines(frame,[pts],False,(0,255,255),2)

            alert_this_frame=False
            current_msg="Normal Operation"

            red_person_detected=False

            if results[0].boxes.id is not None:

                boxes=results[0].boxes.xyxy.cpu().numpy()
                track_ids=results[0].boxes.id.int().cpu().numpy()

                # -------- CROWD DETECTION --------

                if len(track_ids) >= 5:

                    alert_this_frame=True
                    current_msg=f"Crowd Detected ({len(track_ids)})"

                for box,tid in zip(boxes,track_ids):

                    x1,y1,x2,y2=map(int,box)

                    cx=int((x1+x2)/2)
                    cy=y2

                    torso=frame[y1:y1+(y2-y1)//3,x1:x2]

                    color_match=check_color(torso,state["color"])

                    if color_match:
                        red_person_detected=True

                    is_alert=False

                    # ---------- MASTER MODE ----------

                    if state["feature"]=="master" and color_match:

                        is_alert=True
                        current_msg="Target Person Detected"

                    # ---------- TRIPWIRE ----------

                    if state["feature"]=="tripwire" and len(pts)>1:

                        dist=cv2.pointPolygonTest(pts,(cx,cy),True)

                        if abs(dist)<20:

                            is_alert=True
                            current_msg="Tripwire Breach"

                    # ---------- CONFLICT DETECTION ----------

                    if not red_person_detected:

                        if tid in prev_centers:

                            px,py=prev_centers[tid]

                            speed=np.sqrt((cx-px)**2+(cy-py)**2)

                            if speed>10:

                                agitation_score[tid]=agitation_score.get(tid,0)+1

                            else:

                                agitation_score[tid]=max(0,agitation_score.get(tid,0)-0.5)

                            if agitation_score.get(tid,0)>2:

                                is_alert=True
                                current_msg="Physical Conflict Detected"

                    prev_centers[tid]=(cx,cy)

                    # ---------- VISUALS ----------

                    color=(0,0,255) if color_match else (0,255,0)

                    cv2.rectangle(frame,(x1,y1),(x2,y2),color,2)

                    cv2.circle(frame,(cx,cy),4,(255,0,0),-1)

                    if is_alert:
                        alert_this_frame=True

            # ---------- ALERT PERSISTENCE ----------

            if alert_this_frame:
                alert_persistence_timer=90
            else:
                alert_persistence_timer=max(0,alert_persistence_timer-1)

            if alert_persistence_timer>0:

                state["status"]={
                    "alert":True,
                    "msg":current_msg,
                    "time":datetime.now().strftime("%H:%M:%S")
                }

            else:

                state["status"]["alert"]=False

            ret,buffer=cv2.imencode('.jpg',frame)

            frame=buffer.tobytes()

            yield(b'--frame\r\n'
                  b'Content-Type: image/jpeg\r\n\r\n'+frame+b'\r\n')

        cap.release()


# ---------------- ROUTES ----------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/upload",methods=["POST"])
def upload():

    file=request.files["video"]

    path=os.path.join(UPLOAD_FOLDER,file.filename)

    file.save(path)

    state["video"]=path

    return jsonify({"filename":file.filename})


@app.route("/uploads/<name>")
def serve_video(name):
    return send_from_directory(UPLOAD_FOLDER,name)


@app.route("/start",methods=["POST"])
def start():

    data=request.json

    state["feature"]=data["feature"]
    state["color"]=data["color"]
    state["points"]=data["points"]
    state["monitor"]=True
    state["last_alert"]=0

    return jsonify({"status":"ok"})


@app.route("/stop",methods=["POST"])
def stop():

    state["monitor"]=False

    return jsonify({"status":"stopped"})


@app.route("/status")
def status():
    return jsonify(state["status"])


@app.route("/video_feed")
def video_feed():
    return Response(generate_frames(),mimetype='multipart/x-mixed-replace; boundary=frame')


if __name__=="__main__":
    app.run(debug=True)