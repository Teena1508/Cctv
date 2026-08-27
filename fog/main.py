import os
import json
import time
import random
import requests
import paho.mqtt.client as mqtt
from face_search import FaceSearcher

# Config
MQTT_BROKER = os.getenv("MQTT_BROKER", "localhost")
MQTT_PORT = int(os.getenv("MQTT_PORT", 1883))
MQTT_TOPIC = os.getenv("MQTT_TOPIC", "surveillance/edge/detections")
MILVUS_HOST = os.getenv("MILVUS_HOST", "localhost")
MILVUS_PORT = int(os.getenv("MILVUS_PORT", 19530))
CENTRAL_API_URL = os.getenv("CENTRAL_API_URL", "http://localhost:8000/api/alerts")
NODE_ID = os.getenv("NODE_ID", "fog-node-bravo")

# Keep track of person state for loitering anomaly detection (dwell time tracking)
person_dwell_times = {}

# Initialize Milvus FaceSearcher
print(f"[{NODE_ID}] Initializing Milvus Face Searcher...")
face_db = FaceSearcher(host=MILVUS_HOST, port=MILVUS_PORT)

# Seed database with mock profiles for testing if empty
def seed_mock_profiles():
    # Only seed if connected
    if face_db.client and face_db.client.has_collection(face_db.collection_name):
        try:
            # Check if database is empty
            stats = face_db.client.describe_collection(face_db.collection_name)
            res = face_db.client.query(collection_name=face_db.collection_name, filter="id >= 0", limit=1)
            if len(res) == 0:
                print(f"[{NODE_ID}] Seeding mock facial profiles into Milvus...")
                # Seed Suspect
                suspect_vector = [0.1] * 512
                suspect_vector[0] = 0.9  # Unique pattern
                face_db.register_face("Wanted Suspect (John Doe)", suspect_vector)
                
                # Seed Employee
                employee_vector = [0.2] * 512
                employee_vector[0] = 0.8
                face_db.register_face("Authorized Personnel (Jane Smith)", employee_vector)
        except Exception as e:
            print(f"[{NODE_ID}] Seeding mock profiles failed: {e}")

time.sleep(2)  # Give Milvus time to prepare
seed_mock_profiles()

def analyze_anomaly(detection, node_id):
    """Simple rule-based anomaly detection engine."""
    cls_name = detection["class"]
    
    # 1. Temporal Anomaly: Detection during off-hours (e.g., late night)
    curr_hour = time.localtime().tm_hour
    is_off_hours = curr_hour < 6 or curr_hour > 22
    
    # 2. Dwell Time Anomaly (Loitering):
    # Track duration an object of class 'person' is active in camera view
    now = time.time()
    if cls_name == "person":
        person_id = f"{node_id}-person-tracker"
        if person_id not in person_dwell_times:
            person_dwell_times[person_id] = now
        
        dwell_duration = now - person_dwell_times[person_id]
        if dwell_duration > 15.0:  # Exceeded 15 seconds dwell time
            return {
                "type": "Loitering",
                "severity": "MEDIUM",
                "details": f"Person observed loitering for {int(dwell_duration)} seconds."
            }
    
    if is_off_hours and cls_name in ["person", "car"]:
        return {
            "type": "Unauthorized Entry",
            "severity": "HIGH",
            "details": f"Detection of '{cls_name}' during off-hours ({curr_hour}:00)."
        }
        
    return None

def on_message(client, userdata, msg):
    try:
        payload = json.loads(msg.payload.decode())
        node_id = payload.get("node_id", "unknown-edge")
        detections = payload.get("detections", [])
        
        print(f"[{NODE_ID}] Processing MQTT frame from Edge: {node_id}")

        for det in detections:
            cls_name = det["class"]
            
            # Scenario: Facial recognition trigger
            face_result = None
            if cls_name == "person":
                # Simulated embedding vector lookup
                # In production, InsightFace extracts 512-dim embedding from cropped face image
                # Here we mock it: 10% chance it matches the "Wanted Suspect", 20% authorized employee, otherwise unknown
                mock_chance = random.random()
                if mock_chance < 0.1:
                    mock_embedding = [0.1] * 512
                    mock_embedding[0] = 0.9  # Wanted Suspect vector
                elif mock_chance < 0.3:
                    mock_embedding = [0.2] * 512
                    mock_embedding[0] = 0.8  # Authorized Personnel vector
                else:
                    mock_embedding = [random.uniform(-0.1, 0.1) for _ in range(512)]
                
                face_result = face_db.search_face(mock_embedding, threshold=0.8)
                print(f"[{NODE_ID}] Face recognition match: {face_result['name']} (Conf: {face_result['confidence']:.2f})")
            
            # Anomaly evaluation
            anomaly = analyze_anomaly(det, node_id)
            
            # Trigger escalation if face match is a Wanted Suspect or anomaly is detected
            is_escalated = False
            alert_reason = []
            severity = "INFO"

            if face_result and face_result["match"] and "Wanted Suspect" in face_result["name"]:
                is_escalated = True
                alert_reason.append("Suspect Match")
                severity = "CRITICAL"
            
            if anomaly:
                is_escalated = True
                alert_reason.append(anomaly["type"])
                if severity != "CRITICAL":
                    severity = anomaly["severity"]

            if is_escalated:
                alert_payload = {
                    "node_id": node_id,
                    "event_type": ", ".join(alert_reason),
                    "severity": severity,
                    "details": face_result["name"] if face_result else "No face matched",
                    "lat": 37.7749 + random.uniform(-0.01, 0.01),  # Simulated spatio-temporal location (SF default)
                    "lng": -122.4194 + random.uniform(-0.01, 0.01),
                    "extra_info": anomaly["details"] if anomaly else "No anomaly detailed."
                }
                
                # Post alert to central API HTTP handler
                try:
                    res = requests.post(CENTRAL_API_URL, json=alert_payload, timeout=2.0)
                    if res.status_code == 201 or res.status_code == 200:
                        print(f"[{NODE_ID}] Alert successfully escalated to Central backend: {alert_payload['event_type']}")
                    else:
                        print(f"[{NODE_ID}] Central backend rejected alert: {res.status_code} - {res.text}")
                except Exception as ex:
                    print(f"[{NODE_ID}] ERROR: Central backend unreachable: {ex}")

    except Exception as e:
        print(f"[{NODE_ID}] ERROR parsing message: {e}")

def main():
    client = mqtt.Client(client_id=f"{NODE_ID}-subscriber")
    client.on_message = on_message

    try:
        client.connect(MQTT_BROKER, MQTT_PORT, 60)
        client.subscribe(MQTT_TOPIC)
        print(f"[{NODE_ID}] Fog processing node listening on topic '{MQTT_TOPIC}'...")
        client.loop_forever()
    except KeyboardInterrupt:
        print(f"[{NODE_ID}] Shutting down...")
    except Exception as e:
        print(f"[{NODE_ID}] ERROR: MQTT loop failed: {e}")

if __name__ == "__main__":
    main()
