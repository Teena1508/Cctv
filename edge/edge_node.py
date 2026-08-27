#!/usr/bin/env python3
"""
3-Tier AI Surveillance Platform: Edge Processing Node
======================================================
This service connects to an RTSP camera stream (falling back to a local video file, 
webcam, or synthetic frame generator), performs YOLOv8 object detection targeting 
persons and vehicles at 10 FPS, checks if detections lie within a polygon Region of 
Interest (ROI), crops the detection, encodes it in base64, and publishes to Mosquitto MQTT.

NVIDIA JETSON TENSORRT DEPLOYMENT GUIDE (CUDA-Accelerated Edge)
===============================================================
Running deep learning models at the edge on Jetson devices (Nano, Xavier, Orin) 
requires bypassing standard CPU PyTorch execution to utilize onboard CUDA/TensorRT cores.

1. Dependencies Installation on Jetson:
   - Make sure JetPack (L4T) is installed on the Jetson.
   - Install TensorRT and its Python bindings (pre-bundled with JetPack or installable via apt):
     $ sudo apt-get update && sudo apt-get install -y python3-libnvinfer python3-libnvinfer-dev
   - Install OpenCV with CUDA support (standard JetPack OpenCV builds include this).

2. Exporting YOLOv8 to TensorRT engine format:
   Using Ultralytics, export the PyTorch model (.pt) to a TensorRT engine (.engine) 
   directly on the target Jetson device to compile it specifically for its GPU architecture:
     $ pip install ultralytics
     $ python3 -c "from ultralytics import YOLO; model = YOLO('yolov8n.pt'); model.export(format='engine', device=0, half=True)"
     
   This creates 'yolov8n.engine' compiled with FP16 half-precision optimization.

3. Modifying Model Loader in this script:
   - Change: `model = YOLO("yolov8n.pt")`
   - To:     `model = YOLO("yolov8n.engine")`
   Ultralytics will automatically use the TensorRT C++ backend (via tensorrt package and CUDA) 
   for inference, achieving up to 5x-10x latency reductions.
"""

import os
import sys
import time
import json
import base64
import cv2
import numpy as np
import paho.mqtt.client as mqtt
from ultralytics import YOLO

# Environmental Configurations
MQTT_BROKER = os.getenv("MQTT_BROKER", "localhost")
MQTT_PORT = int(os.getenv("MQTT_PORT", 1883))
MQTT_TOPIC = os.getenv("MQTT_TOPIC", "surveillance/edge/events")
CAMERA_ID = os.getenv("CAMERA_ID", "cam-main-entrance")

# Video Ingestion inputs
RTSP_URL = os.getenv("RTSP_URL", "")
LOCAL_VIDEO = os.getenv("LOCAL_VIDEO", "sample_video.mp4")

# Detection settings
TARGET_FPS = 10
CONFIDENCE_THRESHOLD = 0.45

# COCO Dataset Classes of interest
# 0: person, 2: car, 3: motorcycle, 5: bus, 7: truck
TARGET_CLASSES = [0, 2, 3, 5, 7]

# Normalized Polygon ROI coordinates: [[x_pct, y_pct], ...]
# This defines a trapezoidal courtyard/entryway zone
ROI_POLYGON_NORMALIZED = [
    [0.15, 0.25],  # Top-left
    [0.85, 0.25],  # Top-right
    [0.95, 0.85],  # Bottom-right
    [0.05, 0.85]   # Bottom-left
]

def on_connect(client, userdata, flags, rc):
    if rc == 0:
        print(f"[MQTT] Connected successfully to Mosquitto broker on {MQTT_BROKER}:{MQTT_PORT}")
    else:
        print(f"[MQTT] Connection failed with error code {rc}")

def main():
    print(f"[{CAMERA_ID}] Launching Edge Ingestion Node...")

    # Initialize MQTT client
    client = mqtt.Client(client_id=f"edge-{CAMERA_ID}")
    client.on_connect = on_connect
    try:
        client.connect(MQTT_BROKER, MQTT_PORT, 60)
        client.loop_start()
    except Exception as e:
        print(f"[MQTT] ERROR: Failed to connect to broker: {e}")
        # Continue execution; will try to reconnect automatically
    
    # Initialize YOLOv8 Model (downloads yolov8n.pt if not cached)
    print("[YOLO] Loading YOLOv8 model...")
    try:
        # NOTE: On Jetson, substitute with yolov8n.engine after compilation
        model = YOLO("yolov8n.pt")
        print("[YOLO] Model loaded successfully.")
    except Exception as e:
        print(f"[YOLO] FATAL: Error loading model: {e}")
        sys.exit(1)

    # Ingestion failover pipeline
    cap = None
    source_name = ""
    
    if RTSP_URL:
        print(f"[Video] Connecting to RTSP Stream: {RTSP_URL}")
        cap = cv2.VideoCapture(RTSP_URL)
        source_name = "RTSP"
    
    if cap is None or not cap.isOpened():
        if RTSP_URL:
            print("[Video] RTSP connection failed. Falling back to local video file...")
        
        if os.path.exists(LOCAL_VIDEO):
            print(f"[Video] Loading local video file: {LOCAL_VIDEO}")
            cap = cv2.VideoCapture(LOCAL_VIDEO)
            source_name = f"File ({LOCAL_VIDEO})"
        else:
            print(f"[Video] Local file '{LOCAL_VIDEO}' not found.")

    if cap is None or not cap.isOpened():
        print("[Video] Attempting webcam source (index 0) fallback...")
        cap = cv2.VideoCapture(0)
        source_name = "Webcam"

    use_synthetic = False
    if not cap.isOpened():
        print("[Video] WARNING: No camera or file sources opened. Running synthetic frame stream.")
        use_synthetic = True
        source_name = "Synthetic Frame Generator"

    print(f"[Video] Source pipelines initialized. Reading from: {source_name}")

    frame_interval = 1.0 / TARGET_FPS
    frame_counter = 0

    try:
        while True:
            start_time = time.time()
            frame = None
            
            if not use_synthetic:
                ret, frame = cap.read()
                if not ret:
                    print("[Video] Loop reset or stream disconnected. Rewinding...")
                    if "File" in source_name:
                        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                        continue
                    else:
                        time.sleep(2.0)
                        continue
            else:
                # Generate a mock synthetic gray image frame
                frame = np.ones((720, 1280, 3), dtype=np.uint8) * 40
                cv2.putText(frame, f"SYNTHETIC STREAM - {CAMERA_ID.upper()}", (50, 80), 
                            cv2.FONT_HERSHEY_SIMPLEX, 1, (200, 200, 200), 2)
                # Draw a clock
                cv2.putText(frame, time.strftime("%Y-%m-%d %H:%M:%S"), (50, 130), 
                            cv2.FONT_HERSHEY_SIMPLEX, 0.8, (100, 180, 100), 2)

            h, w = frame.shape[:2]
            
            # Map normalized ROI coordinates to absolute pixel coordinates
            poly_pts = np.array([[int(p[0] * w), int(p[1] * h)] for p in ROI_POLYGON_NORMALIZED], dtype=np.int32)

            # Perform object inference
            # We filter classes at the inference stage to save post-processing compute
            results = model(frame, classes=TARGET_CLASSES, conf=CONFIDENCE_THRESHOLD, verbose=False)
            
            if len(results) > 0:
                boxes = results[0].boxes
                for box in boxes:
                    class_id = int(box.cls[0])
                    class_name = results[0].names[class_id]
                    confidence = float(box.conf[0])
                    xyxy = box.xyxy[0].tolist()  # [xmin, ymin, xmax, ymax]
                    
                    xmin, ymin, xmax, ymax = xyxy
                    
                    # We evaluate the "feet" / bottom-center coordinate for spatial checking
                    bottom_center = (int((xmin + xmax) / 2), int(ymax))
                    
                    # Perform pointPolygonTest: returns >= 0 if inside or on the boundary
                    is_inside_roi = cv2.pointPolygonTest(poly_pts, bottom_center, False) >= 0
                    
                    if is_inside_roi:
                        event_type = f"ROI Entry: {class_name.capitalize()}"
                        print(f"[{CAMERA_ID}] Target '{class_name}' detected inside ROI! Conf: {confidence:.2f}")

                        # Extract cropped frame segment of the target
                        # Clamp crop coordinates to frame dimensions
                        ymin_c, ymax_c = max(0, int(ymin)), min(h, int(ymax))
                        xmin_c, xmax_c = max(0, int(xmin)), min(w, int(xmax))
                        
                        crop = frame[ymin_c:ymax_c, xmin_c:xmax_c]
                        
                        crop_base64 = ""
                        if crop.size > 0:
                            # Encode as JPEG
                            ret_enc, buffer = cv2.imencode('.jpg', crop, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
                            if ret_enc:
                                crop_base64 = base64.b64encode(buffer).decode('utf-8')
                        
                        # Generate telemetry payload
                        payload = {
                            "camera_id": CAMERA_ID,
                            "timestamp": time.time(),
                            "event_type": event_type,
                            "confidence": round(confidence, 3),
                            "crop_base64": crop_base64
                        }

                        # Publish alert event to Mosquitto
                        client.publish(MQTT_TOPIC, json.dumps(payload))
            
            # FPS Throttling Control
            elapsed = time.time() - start_time
            sleep_time = frame_interval - elapsed
            if sleep_time > 0:
                time.sleep(sleep_time)
            
            frame_counter += 1
            if frame_counter % 100 == 0:
                effective_fps = 1.0 / (time.time() - start_time)
                print(f"[{CAMERA_ID}] Node Processing Healthy. Effective Loop Speed: {effective_fps:.1f} FPS")

    except KeyboardInterrupt:
        print("[Edge] Shutting down Edge Node...")
    finally:
        if cap and cap.isOpened():
            cap.release()
        client.loop_stop()
        client.disconnect()

if __name__ == "__main__":
    main()
