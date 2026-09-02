import os
import sys
import json
import time
import threading
from typing import List
from fastapi import FastAPI, Depends, WebSocket, WebSocketDisconnect, status, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
import redis
import paho.mqtt.client as mqtt
from pydantic import BaseModel
import cv2
import numpy as np
from database import init_db, get_db, Alert, SessionLocal

# Append workspace root directory to sys.path
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT_DIR not in sys.path:
    sys.path.append(ROOT_DIR)

from ingestion.stream import RTSPConnector
from ingestion.config import append_camera_config

def load_configured_location():
    try:
        import re
        central_dir = os.path.dirname(os.path.abspath(__file__))
        root_dir = os.path.dirname(central_dir)
        loc_file = os.path.join(root_dir, "dashboard", "src", "config", "location.js")
        if os.path.exists(loc_file):
            with open(loc_file, "r") as f:
                content = f.read()
            lat_match = re.search(r"lat\s*:\s*([\d\.-]+)", content)
            lng_match = re.search(r"lng\s*:\s*([\d\.-]+)", content)
            if lat_match and lng_match:
                return float(lat_match.group(1)), float(lng_match.group(1))
    except Exception as e:
        print(f"[Central Location Ingest] Error reading location.js: {e}")
    return 28.6139, 77.2090

# FastAPI App setup
app = FastAPI(title="Central Surveillance Management Hub", version="2.0.0")

# CORS configurations
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Redis Configuration
REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", 6379))
redis_client = None

# MQTT Configuration
MQTT_BROKER = os.getenv("MQTT_BROKER", "localhost")
MQTT_PORT = int(os.getenv("MQTT_PORT", 1883))

try:
    redis_client = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, db=0, decode_responses=True)
    # Enable Keyspace Notifications for Key Expirations (Ex)
    redis_client.config_set('notify-keyspace-events', 'Ex')
    print(f"[Central Redis] Connected to Redis cache at {REDIS_HOST}:{REDIS_PORT} and keyspace expirations enabled.")
except Exception as e:
    print(f"[Central Redis] WARNING: Failed to connect to Redis: {e}")

# =========================================================================
# WebSockets Broadcast Manager
# =========================================================================
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        print(f"[Central WS] Client connected. Active: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            print(f"[Central WS] Client disconnected. Active: {len(self.active_connections)}")

    def broadcast_sync(self, message: dict):
        """Synchronous broadcast wrapper for calling from background threads."""
        import asyncio
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
                
        async def run_broadcast():
            for connection in self.active_connections:
                try:
                    await connection.send_json(message)
                except Exception as e:
                    print(f"[Central WS] Broadcast error: {e}")
        
        loop.run_until_complete(run_broadcast())
        loop.close()

manager = ConnectionManager()

# =========================================================================
# Redis TTL Escalation Handler (Expired keys listener)
# =========================================================================
def escalate_alert(alert_id: int):
    """Checks PostgreSQL if the alert was acknowledged; if not, triggers escalation."""
    print(f"[Escalation Engine] Expiry triggered for alert #{alert_id}. Evaluating status...")
    db = SessionLocal()
    try:
        alert = db.query(Alert).filter(Alert.id == alert_id).first()
        if alert and alert.status == "PENDING":
            print(f"[Escalation Engine] WARNING: Alert #{alert_id} not acknowledged. Escalating to command!")
            alert.status = "ESCALATED_TO_COMMAND"
            db.commit()
            
            # Broadcast the secondary escalation trigger to WebSockets
            escalation_payload = {
                "event_type": "ESCALATION_TO_COMMAND",
                "alert_id": alert.id,
                "camera_id": alert.node_id,
                "original_event": alert.event_type,
                "details": f"CRITICAL SECURITY ESCALATION: '{alert.event_type}' alert not acknowledged within 60 seconds.",
                "severity": "CRITICAL",
                "timestamp": str(alert.timestamp)
            }
            manager.broadcast_sync(escalation_payload)
        else:
            print(f"[Escalation Engine] Alert #{alert_id} is already acknowledged or processed.")
    except Exception as e:
        print(f"[Escalation Engine] ERROR updating alert status: {e}")
    finally:
        db.close()

def redis_expired_listener():
    """Background listener for Redis Key Expirations."""
    if not redis_client:
        return
        
    pubsub = redis_client.pubsub()
    # Subscribe to keyevent expired channel
    pubsub.subscribe("__keyevent@0__:expired")
    print("[Escalation Engine] Listening for Redis expired keyspace events...")
    
    for message in pubsub.listen():
        try:
            if message['type'] == 'message':
                key = message['data']
                # Expired key pattern: escalation:pending:{alert_id}
                if key.startswith("escalation:pending:"):
                    alert_id = int(key.split(":")[-1])
                    escalate_alert(alert_id)
        except Exception as e:
            print(f"[Escalation Engine] Listener error: {e}")
            time.sleep(1)

# =========================================================================
# MQTT Ingestion Subscriber
# =========================================================================
def save_mqtt_alert(payload: dict):
    """Processes MQTT payload, saves to database, and triggers Redis TTL timers if high priority."""
    camera_id = payload.get("camera_id", "unknown-cam")
    event_type = payload.get("event_type", "UNKNOWN_EVENT")
    confidence = payload.get("confidence", 0.0)
    details = payload.get("details", "")
    
    # Evaluate priority: Weapon or FRS matches are categorized as HIGH_PRIORITY
    is_high_priority = "MATCH" in event_type or "WEAPON" in event_type or payload.get("severity") in ["HIGH", "CRITICAL", "HIGH_PRIORITY"]
    severity = "HIGH_PRIORITY" if is_high_priority else "INFO"

    db = SessionLocal()
    try:
        fallback_lat, fallback_lng = load_configured_location()
        # Save to database
        db_alert = Alert(
            node_id=camera_id,
            event_type=event_type,
            severity=severity,
            details=details,
            status="PENDING",
            lat=payload.get("lat") if payload.get("lat") is not None else fallback_lat,
            lng=payload.get("lng") if payload.get("lng") is not None else fallback_lng,
            extra_info=f"Confidence: {confidence:.2f}"
        )
        db.add(db_alert)
        db.commit()
        db.refresh(db_alert)
        
        print(f"[MQTT Ingestion] Saved alert #{db_alert.id} ({event_type}) in database.")

        # If high priority, launch Redis TTL tracking (60s expiration)
        if is_high_priority and redis_client:
            redis_key = f"escalation:pending:{db_alert.id}"
            redis_client.setex(redis_key, 60, "pending")
            print(f"[MQTT Ingestion] Launched 60s Redis TTL timer for alert #{db_alert.id}.")

        # Broadcast payload via WebSockets
        ws_payload = {
            "id": db_alert.id,
            "camera_id": db_alert.node_id,
            "event_type": db_alert.event_type,
            "severity": db_alert.severity,
            "details": db_alert.details,
            "status": db_alert.status,
            "lat": db_alert.lat,
            "lng": db_alert.lng,
            "timestamp": str(db_alert.timestamp)
        }
        manager.broadcast_sync(ws_payload)

    except Exception as e:
        print(f"[MQTT Ingestion] ERROR saving alert: {e}")
    finally:
        db.close()

def on_mqtt_message(client, userdata, msg):
    try:
        payload = json.loads(msg.payload.decode('utf-8'))
        save_mqtt_alert(payload)
    except Exception as e:
        print(f"[MQTT Ingestion] ERROR parsing MQTT JSON: {e}")

def mqtt_subscriber():
    """Background listener for MQTT alerts topic."""
    MQTT_TOPIC = "surveillance/fog/alerts"
    client = mqtt.Client(client_id="central-subscriber-hub")
    client.on_message = on_mqtt_message
    
    print(f"[MQTT Ingestion] Connecting to MQTT broker at {MQTT_BROKER}...")
    for i in range(10):
        try:
            client.connect(MQTT_BROKER, MQTT_PORT, 60)
            client.subscribe(MQTT_TOPIC)
            print(f"[MQTT Ingestion] Subscribed to topic '{MQTT_TOPIC}' successfully.")
            client.loop_forever()
            break
        except Exception as e:
            print(f"[MQTT Ingestion] Connection attempt {i+1}/10 failed: {e}")
            time.sleep(3)

# =========================================================================
# Startup Event
# =========================================================================
@app.on_event("startup")
def startup_event():
    # Setup PostgreSQL tables
    init_db()
    
    # Launch background thread for Redis expired keys keyspace notifications
    t_redis = threading.Thread(target=redis_expired_listener, daemon=True)
    t_redis.start()
    
    # Launch background thread for MQTT consumer
    t_mqtt = threading.Thread(target=mqtt_subscriber, daemon=True)
    t_mqtt.start()

# =========================================================================
# REST Endpoints & WebSockets
# =========================================================================
class AcknowledgeResponse(BaseModel):
    status: str
    message: str

@app.get("/")
def read_root():
    return {"status": "online", "service": "Central API & Escalation Hub"}

def gen_frames():
    camera = cv2.VideoCapture(0)
    if not camera.isOpened():
        print("[Video Feed] Error: Could not open webcam.")
        # Generate a fallback text frame
        placeholder = np.zeros((480, 640, 3), dtype=np.uint8)
        cv2.putText(placeholder, "Webcam Access Failed / No Webcam", (50, 240), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2)
        _, jpeg = cv2.imencode('.jpg', placeholder)
        frame = jpeg.tobytes()
        yield (b'--frame\r\n'
               b'Content-Type: image/jpeg\r\n\r\n' + frame + b'\r\n')
        return

    try:
        while True:
            success, frame = camera.read()
            if not success:
                time.sleep(0.03)
                continue
            
            ret, buffer = cv2.imencode('.jpg', frame)
            if not ret:
                continue
                
            frame_bytes = buffer.tobytes()
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')
            time.sleep(0.03)
    except Exception as e:
        print(f"[Video Feed] Generator exception: {e}")
    finally:
        camera.release()
        print("[Video Feed] Camera released.")

@app.get("/video_feed")
def video_feed():
    return StreamingResponse(gen_frames(), media_type="multipart/x-mixed-replace; boundary=frame")

@app.post("/api/alerts/{alert_id}/acknowledge", response_model=AcknowledgeResponse)
def acknowledge_alert(alert_id: int, db: Session = Depends(get_db)):
    """Acknowledges an alert, preventing escalation TTL and updating status."""
    alert = db.query(Alert).filter(Alert.id == alert_id).first()
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
        
    if alert.status == "ACKNOWLEDGED":
        return {"status": "success", "message": "Alert is already acknowledged."}
        
    # Update DB Status
    alert.status = "ACKNOWLEDGED"
    db.commit()
    
    # Remove from Redis to block escalation
    if redis_client:
        redis_key = f"escalation:pending:{alert_id}"
        try:
            redis_client.delete(redis_key)
        except Exception as e:
            print(f"[Central Redis] Error deleting key: {e}")
        
    # Broadcast status change to WebSockets
    ack_payload = {
        "event_type": "ALERT_ACKNOWLEDGED",
        "alert_id": alert_id,
        "camera_id": alert.node_id,
        "status": "ACKNOWLEDGED"
    }
    
    # Notify active dashboard listeners
    try:
        manager.broadcast_sync(ack_payload)
    except Exception as e:
        print(f"[Central WS] Error broadcasting status change: {e}")
            
    print(f"[Central API] Alert #{alert_id} acknowledged. Prevented escalation.")
    return {"status": "success", "message": f"Alert #{alert_id} acknowledged successfully."}

@app.get("/api/alerts", response_model=List[dict])
def get_alerts(limit: int = 50, db: Session = Depends(get_db)):
    alerts = db.query(Alert).order_by(Alert.timestamp.desc()).limit(limit).all()
    return [
        {
            "id": a.id,
            "camera_id": a.node_id,
            "event_type": a.event_type,
            "severity": a.severity,
            "details": a.details,
            "status": a.status,
            "lat": a.lat,
            "lng": a.lng,
            "timestamp": str(a.timestamp)
        } for a in alerts
    ]

@app.websocket("/ws/alerts")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            # Keep WebSocket alive
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        print(f"[Central WS] Connection exception: {e}")
        manager.disconnect(websocket)

# =========================================================================
# IP CCTV Camera Ingestion Endpoint
# =========================================================================
class ConnectCameraRequest(BaseModel):
    camera_id: str
    ip_address: str
    port: int = 554
    rtsp_path: str = ""
    username: str = ""
    password: str = ""
    target_slot: str = "Camera Slot 2"

active_connectors = {}

@app.post("/api/v1/connect-camera")
def connect_camera(req: ConnectCameraRequest):
    print(f"[Central API] Connecting to camera {req.camera_id} at {req.ip_address}:{req.port}")
    
    connector = RTSPConnector(
        ip_address=req.ip_address,
        port=req.port,
        username=req.username,
        password=req.password,
        rtsp_path=req.rtsp_path,
        camera_id=req.camera_id
    )
    
    # Validate connection probe
    is_valid = connector.validate_connection(timeout=3)
    if not is_valid:
        raise HTTPException(
            status_code=400, 
            detail="Failed to ping IP stream. Check RTSP credentials/network"
        )
    
    # If valid, append the IP parameters to config.yaml and cameras.yaml in the root folder
    config_path = os.path.join(ROOT_DIR, "config.yaml")
    cameras_path = os.path.join(ROOT_DIR, "cameras.yaml")
    
    try:
        append_camera_config(req.camera_id, req.ip_address, connector.rtsp_url, config_path=config_path)
        append_camera_config(req.camera_id, req.ip_address, connector.rtsp_url, config_path=cameras_path)
    except Exception as e:
        print(f"[Central API] Failed to update config files: {e}")
        
    # Stop existing connector on this slot if any
    slot = req.target_slot
    if slot in active_connectors:
        print(f"[Central API] Stopping existing camera on slot {slot}")
        try:
            active_connectors[slot].stop()
        except Exception:
            pass
            
    # Start background reader thread for that camera slot
    connector.start()
    active_connectors[slot] = connector
    
    return {
        "status": "success",
        "message": f"Camera {req.camera_id} connected & streaming successfully in slot {slot}",
        "camera_id": req.camera_id,
        "rtsp_url": connector.rtsp_url
    }

def gen_rtsp_frames(connector):
    try:
        while True:
            frame = connector.get_frame(block=True, timeout=1.0)
            if frame is not None:
                ret, buffer = cv2.imencode('.jpg', frame)
                if ret:
                    yield (b'--frame\r\n'
                           b'Content-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')
            else:
                # If no frame, sleep a tiny bit to avoid busy loop
                time.sleep(0.03)
    except Exception as e:
        print(f"[Video Feed Ingestion] Slot stream generator exception: {e}")

@app.get("/video_feed_slot/{camera_slot}")
def video_feed_slot(camera_slot: str):
    if camera_slot not in active_connectors:
        raise HTTPException(status_code=404, detail="Camera slot not connected")
    connector = active_connectors[camera_slot]
    return StreamingResponse(gen_rtsp_frames(connector), media_type="multipart/x-mixed-replace; boundary=frame")

# =========================================================================
# AI Scanning Endpoints (Face & Plate Recognition)
# =========================================================================
from fastapi import File, Form, UploadFile

@app.post("/api/scan-face")
async def scan_face(
    file: UploadFile = File(...),
    targets: str = Form(...)
):
    """Processes facial recognition on incoming webcam frames."""
    try:
        # Read uploaded image bytes
        contents = await file.read()
        nparr = np.frombuffer(contents, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if frame is None:
            return {"matches": []}

        # Convert BGR (OpenCV format) to RGB for facial recognition processing
        rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        
        # Parse targets payload sent from React
        try:
            target_list = json.loads(targets)
        except Exception:
            target_list = []

        matches = []
        # TODO: Replace/extend this section with your facial recognition engine (e.g. face_recognition / dlib / insightface)
        # Example:
        # face_locations = face_recognition.face_locations(rgb_frame)
        # face_encodings = face_recognition.face_encodings(rgb_frame, face_locations)

        return {"matches": matches}
    except Exception as e:
        print(f"[Central Face API] Error: {e}")
        return {"matches": []}

@app.post("/api/scan-plate")
async def scan_plate(file: UploadFile = File(...)):
    """Processes license plate recognition on incoming webcam frames."""
    try:
        contents = await file.read()
        nparr = np.frombuffer(contents, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if frame is None:
            return {"results": []}

        # TODO: Replace/extend this section with your ANPR engine (e.g., EasyOCR / PaddleOCR / OpenALPR)
        results = []
        return {"results": results}
    except Exception as e:
        print(f"[Central ANPR API] Error: {e}")
        return {"results": []}