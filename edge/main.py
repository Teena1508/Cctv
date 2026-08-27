import os
import cv2
import json
import time
import paho.mqtt.client as mqtt
from ultralytics import YOLO

# Environment Configuration
MQTT_BROKER = os.getenv("MQTT_BROKER", "localhost")
MQTT_PORT = int(os.getenv("MQTT_PORT", 1883))
MQTT_TOPIC = os.getenv("MQTT_TOPIC", "surveillance/edge/detections")
RTSP_URL = os.getenv("RTSP_URL", "0")  # Defaults to system camera 0
NODE_ID = os.getenv("NODE_ID", "edge-node-alpha")

def main():
    print(f"[{NODE_ID}] Initializing Edge processing Node...")

    # MQTT Client Setup
    client = mqtt.Client(client_id=f"{NODE_ID}-publisher")
    try:
        client.connect(MQTT_BROKER, MQTT_PORT, 60)
        client.loop_start()
        print(f"[{NODE_ID}] Connected to MQTT Broker at {MQTT_BROKER}:{MQTT_PORT}")
    except Exception as e:
        print(f"[{NODE_ID}] ERROR: Cannot connect to MQTT Broker: {e}")
        return

    # YOLO Model initialization (YOLOv8 Nano for Edge constraints)
    print(f"[{NODE_ID}] Loading YOLO object detection model...")
    try:
        model = YOLO("yolov8n.pt")
    except Exception as e:
        print(f"[{NODE_ID}] WARNING: YOLO loading failed, falling back to simulated inference. Details: {e}")
        model = None

    # RTSP Ingestion / Video capture
    cap_source = int(RTSP_URL) if RTSP_URL.isdigit() else RTSP_URL
    cap = cv2.VideoCapture(cap_source)
    use_simulation = not cap.isOpened()

    if use_simulation:
        print(f"[{NODE_ID}] Video capture source unavailable. Operating in simulated inference mode.")
    else:
        print(f"[{NODE_ID}] Video capture initialized on source: {RTSP_URL}")

    frame_id = 0
    try:
        while True:
            detections = []
            timestamp = time.time()

            if not use_simulation:
                ret, frame = cap.read()
                if not ret:
                    print(f"[{NODE_ID}] End of stream or stream read error. Re-trying...")
                    time.sleep(2.0)
                    continue

                if model:
                    # Run YOLOv8 object detection
                    results = model(frame, verbose=False)[0]
                    for box in results.boxes:
                        class_id = int(box.cls[0])
                        class_name = results.names[class_id]
                        confidence = float(box.conf[0])
                        bbox = box.xyxy[0].tolist()  # [xmin, ymin, xmax, ymax]
                        
                        detections.append({
                            "class": class_name,
                            "confidence": round(confidence, 3),
                            "bbox": [round(coord, 1) for coord in bbox]
                        })
                frame_id += 1
            else:
                # Simulated frame rate and detections (1 FPS)
                time.sleep(1.0)
                frame_id += 1
                detections = [
                    {
                        "class": "person",
                        "confidence": 0.94,
                        "bbox": [120.5, 80.0, 240.2, 380.0]
                    },
                    {
                        "class": "backpack",
                        "confidence": 0.81,
                        "bbox": [130.0, 140.0, 210.0, 260.0]
                    }
                ]

            # Construct telemetry message
            payload = {
                "node_id": NODE_ID,
                "frame_id": frame_id,
                "timestamp": timestamp,
                "detections": detections
            }

            # Publish to broker
            client.publish(MQTT_TOPIC, json.dumps(payload))
            print(f"[{NODE_ID}] Published Frame #{frame_id} detections: {[d['class'] for d in detections]}")

    except KeyboardInterrupt:
        print(f"[{NODE_ID}] Shutting down Edge Node gracefully...")
    finally:
        if not use_simulation:
            cap.release()
        client.loop_stop()
        client.disconnect()

if __name__ == "__main__":
    main()
