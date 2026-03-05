import os
import cv2
import time
import numpy as np
from datetime import datetime
from flask import Flask, render_template, Response, request, jsonify, send_from_directory
from ultralytics import YOLO
from dotenv import load_dotenv
from twilio.rest import Client

load_dotenv()

ACC_SID=os.getenv("TWILIO_ACCOUNT_SID")
AUTH_TOKEN=os.getenv("TWILIO_AUTH_TOKEN")
WHATSAPP_FROM=os.getenv("TWILIO_WHATSAPP_FROM")
TARGET_WHATSAPP=os.getenv("TARGET_WHATSAPP")

twilio_client=Client(ACC_SID,AUTH_TOKEN)

app=Flask(__name__)

UPLOAD_FOLDER="uploads"
os.makedirs(UPLOAD_FOLDER,exist_ok=True)

model=YOLO("yolo11n.pt")

state={
"video":None,
"monitor":False,
"feature":"master",
"color":"red",
"points":[],
"status":{"alert":False,"msg":"","time":""}
}

prev_centers={}
agitation_score={}
last_whatsapp=0


def check_color(crop,color):

    if crop is None or crop.size==0:
        return False

    hsv=cv2.cvtColor(crop,cv2.COLOR_BGR2HSV)

    ranges={
    "red":[((0,100,100),(10,255,255)),((160,100,100),(180,255,255))],
    "blue":[((100,150,0),(140,255,255))],
    "green":[((35,100,100),(85,255,255))]
    }

    target=ranges.get(color,ranges["red"])

    mask=None

    for low,high in target:

        m=cv2.inRange(hsv,np.array(low),np.array(high))

        mask=cv2.bitwise_or(mask,m) if mask is not None else m

    ratio=np.sum(mask>0)/(crop.shape[0]*crop.shape[1])

    return ratio>0.15


def send_whatsapp(msg):

    global last_whatsapp

    if time.time()-last_whatsapp<30:
        return

    try:

        twilio_client.messages.create(
        from_=WHATSAPP_FROM,
        body="🚨 CCTV ALERT: "+msg,
        to=TARGET_WHATSAPP)

        last_whatsapp=time.time()

    except:
        pass


def generate_frames():

    cap=cv2.VideoCapture(state["video"])

    while cap.isOpened():

        if not state["monitor"]:
            time.sleep(0.1)
            continue

        ret,frame=cap.read()

        if not ret:
            cap.set(cv2.CAP_PROP_POS_FRAMES,0)
            continue

        results=model.track(frame,persist=True,classes=[0],verbose=False)

        alert_msg=None
        red_present=False

        pts=np.array(state["points"],np.int32)

        if len(pts)>1:
            cv2.polylines(frame,[pts],False,(0,255,255),3)

        if results[0].boxes.id is not None:

            boxes=results[0].boxes.xyxy.cpu().numpy()
            ids=results[0].boxes.id.int().cpu().numpy()

            if len(ids)>=5:
                alert_msg="Crowd Detected"

            for box,tid in zip(boxes,ids):

                x1,y1,x2,y2=map(int,box)

                cx=(x1+x2)//2
                cy=y2

                torso=frame[y1:y1+(y2-y1)//3,x1:x2]

                color_match=check_color(torso,state["color"])

                if color_match:
                    red_present=True
                    alert_msg="Target Person Detected"

                if state["feature"]=="tripwire" and len(pts)>1:

                    dist=cv2.pointPolygonTest(pts,(cx,cy),True)

                    if abs(dist)<20:
                        alert_msg="Tripwire Breach"

                if not red_present:

                    if tid in prev_centers:

                        px,py=prev_centers[tid]

                        speed=((cx-px)**2+(cy-py)**2)**0.5

                        if speed>10:
                            agitation_score[tid]=agitation_score.get(tid,0)+1

                        if agitation_score.get(tid,0)>3:
                            alert_msg="Physical Conflict Detected"

                prev_centers[tid]=(cx,cy)

                color=(0,0,255) if color_match else (0,255,0)

                cv2.rectangle(frame,(x1,y1),(x2,y2),color,2)

        if alert_msg:

            state["status"]={
            "alert":True,
            "msg":alert_msg,
            "time":datetime.now().strftime("%H:%M:%S")
            }

            send_whatsapp(alert_msg)

        ret,buffer=cv2.imencode(".jpg",frame)

        frame=buffer.tobytes()

        yield(b'--frame\r\n'
        b'Content-Type: image/jpeg\r\n\r\n'+frame+b'\r\n')


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
def serve(name):
    return send_from_directory(UPLOAD_FOLDER,name)


@app.route("/start",methods=["POST"])
def start():

    data=request.json

    state["feature"]=data["feature"]
    state["points"]=data["points"]
    state["color"]=data["color"]
    state["monitor"]=True

    return jsonify({"status":"started"})


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