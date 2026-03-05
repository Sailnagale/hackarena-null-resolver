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

state = {
    "video": None,
    "monitor": False,
    "feature": "master",
    "color": "red",
    "points": [],
    "last_alert": 0,
    "status": {"alert": False, "msg": "", "time": ""}
}

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


def generate_frames():

    while True:

        if not state["monitor"] or state["video"] is None:
            time.sleep(0.1)
            continue

        cap=cv2.VideoCapture(state["video"])

        while cap.isOpened() and state["monitor"]:

            ret,frame=cap.read()

            if not ret:
                break

            results=model.track(frame,persist=True,classes=[0],verbose=False)

            pts=np.array(state["points"],np.int32)

            if len(pts)>1:
                cv2.polylines(frame,[pts],False,(0,255,255),2)

            if results[0].boxes.id is not None:

                for box in results[0].boxes.xyxy.cpu().numpy():

                    x1,y1,x2,y2=map(int,box)

                    cx=int((x1+x2)/2)
                    cy=y2

                    torso=frame[y1:y1+(y2-y1)//3,x1:x2]

                    color_match=check_color(torso,state["color"])

                    is_alert=False

                    if state["feature"]=="master" and color_match:
                        is_alert=True

                    elif state["feature"]=="tripwire":

                        if len(pts)>1:

                            dist=cv2.pointPolygonTest(pts,(cx,cy),True)

                            if abs(dist)<20:
                                is_alert=True

                    if is_alert:

                        cv2.rectangle(frame,(x1,y1),(x2,y2),(0,0,255),3)

                        if time.time()-state["last_alert"]>2:

                            state["last_alert"]=time.time()

                            state["status"]={
                                "alert":True,
                                "msg":f"{state['feature'].upper()} ALERT",
                                "time":datetime.now().strftime("%H:%M:%S")
                            }

                    else:

                        cv2.rectangle(frame,(x1,y1),(x2,y2),(0,255,0),2)

            ret,buffer=cv2.imencode('.jpg',frame)

            frame=buffer.tobytes()

            yield(b'--frame\r\n'
                  b'Content-Type: image/jpeg\r\n\r\n'+frame+b'\r\n')

        cap.release()


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