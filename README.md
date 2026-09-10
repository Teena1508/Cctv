# AI-Video-Surveillance

A real-time, edge-assisted AI surveillance dashboard and analytics engine for automated threat detection, facial recognition, license plate recognition (ALPR), and restricted zone intrusion monitoring using existing CCTV infrastructure.

---

## 1. Project Information

- **Project Title:** AI-Video-Surveillance
- **PS ID:** SIH2026-DEMO-001
- **PS Title:** AI-Based Intelligent Video Analytics Platform for Border Surveillance using existing CCTV Infrastructure.
- **Category:** Software
- **Theme:** Blockchain & Cybersecurity

---

## 2. Problem Statement

Traditional CCTV monitoring relies on passive recording and human operators manually watching dozens of screens. This leads to critical security vulnerabilities:
- **Operator Fatigue & Blind Spots:** Human attention drops significantly after 20 minutes of screen monitoring.
- **Delayed Incident Reaction:** Security teams usually investigate footage *after* a security incident or intrusion has already occurred.
- **Alert Spam & Alarm Fatigue:** Conventional motion sensors trigger constant false alarms for shadows, lighting changes, or animals, causing operators to ignore real alerts.
- **Lack of Tracking Lifecycle:** Standard systems don't distinguish between arrival, continuous dwell, and departure of an unauthorized person across critical border or perimeter zones.

---

## 3. Proposed Solution

An end-to-end AI-based intelligent video analytics platform that integrates existing CCTV infrastructure with a **Python computer vision AI backend** and a **React operational dashboard**.

The system automatically:
- Identifies enrolled watchlist targets (green HUD overlays) vs. unenrolled unauthorized individuals (red HUD overlays) in real time.
- Triggers immediate **`UNAUTHORIZED PRESENCE`** alerts upon arrival without spamming repeated alerts while the person remains in frame.
- Automatically logs a **`SUBJECT DEPARTED`** event when an unauthorized person leaves the camera view.
- Enforces temporal restricted-zone rules (e.g., off-hours border intrusion policies) and upgrades threat severity dynamically to `CRITICAL`.
- Operates both connected to a high-precision Python backend (InsightFace ArcFace 512D) and standalone in the browser via TensorFlow.js.

---

## 4. Key Features

- **Real-Time Video HUD & Visual Bounding Boxes:** Color-coded overlays distinguishing enrolled targets (`TARGET MATCH`) from unauthorized individuals (`UNAUTHORIZED PERSON`).
- **ArcFace 512D Facial & License Plate Recognition:** High-precision facial vector extraction and Automated License Plate Recognition (ALPR).
- **Presence Lifecycle Management:** Tracks arrival (`UNAUTHORIZED PRESENCE`), suppresses duplicate dwell alerts, and detects departure (`SUBJECT DEPARTED`).
- **Restricted Zone & Temporal Rule Engine:** Configurable time windows and perimeter security constraints (e.g., 24/7 or off-hours intrusion monitoring).
- **GIS Tactical Operations Map:** Interactive Leaflet map displaying active camera nodes, live geolocation markers, and quick pin focusing on security alerts.
- **Dual Engine Architecture:** Works seamlessly connected to the Python AI backend or standalone using browser-based TensorFlow.js COCO-SSD object detection.

---

## 5. System Architecture & High-Level Flow

```text
User / Security Operator
  │
  ▼
Frontend (React Operational Dashboard)
  │
  ▼
Backend API (FastAPI Computer Vision Engine)
  │
  ├───► Database (Vector Store / Watchlist Registry / Audit Logs)
  │
  ▼
Machine Learning Model (ArcFace 512D / YOLOv8 / COCO-SSD)
  │
  ▼
Prediction / Threat Detection & Alert Result
  │
  ▼
Frontend (Live Bounding Boxes, HUD Status & GIS Map Pins)
```

### Detailed Pipeline Flow:
1. **Frame Capture & Ingestion:** React frontend (`CameraFeed.jsx`) captures video stream frames and sends them to the backend API (`/api/scan-face`, `/api/scan-plate`).
2. **Feature Extraction & Matching:** InsightFace / ONNX Runtime extracts 512-dimensional facial vector embeddings and computes cosine similarity against enrolled watchlist vectors.
3. **Classification & Overlap NMS:** Detections with similarity $\ge 0.72$ match enrolled targets. Unenrolled faces are classified as `UNAUTHORIZED PERSON`. Non-Maximum Suppression (NMS) deduplicates overlapping bounding boxes.
4. **Presence Lifecycle Management:** Manages arrival, continuous dwell anti-spam deduplication, and departure logging.

---

## 6. Technologies Used

- **Programming Languages:** Python 3.10+, JavaScript (ES6+), HTML5, CSS3
- **Frontend:** React 18, Vite, Tailwind CSS, Lucide React, Leaflet / React-Leaflet, Mapbox GL
- **Backend API:** Python, FastAPI, Uvicorn, WebSockets, Pydantic, SQLAlchemy
- **AI / ML Technologies:** PyTorch, YOLOv8 (Ultralytics), InsightFace (ArcFace 512D Embeddings), ONNX Runtime, OpenCV, TensorFlow.js / COCO-SSD, EasyOCR
- **Databases & Vector Search:** PostgreSQL, Milvus, Redis
- **Messaging & Protocols:** MQTT (`paho-mqtt`), WebSockets, RTSP, REST APIs
- **Hardware / Input Sources:** RTSP IP Surveillance Cameras, USB / Integrated Webcams, Edge Processing Nodes
- **Deployment & Dev Tools:** Docker, Docker Compose, Git, Vercel

---

## 7. How to Run Locally

### Prerequisites
- Python 3.10 or higher
- Node.js 18+ and `npm`

### Step 1: Start the AI Backend
```bash
# Navigate to backend directory
cd cctv-backend

# Install dependencies (if not already installed)
pip install -r requirements.txt

# Start the server (runs on http://localhost:8002)
python main.py
```

### Step 2: Start the Operations Dashboard
```bash
# Open a new terminal and navigate to dashboard directory
cd dashboard

# Install npm dependencies
npm install

# Launch Vite dev server (runs on http://localhost:5173)
npm run dev
```

### Step 3: Test Real-Time Detection
1. Open `http://localhost:5173` in your browser.
2. Allow webcam access or connect an IP camera stream URL.
3. **Unenrolled Person Test:** Stand in front of the camera. The HUD will show a solid red bounding box labeled `UNAUTHORIZED PERSON` and trigger an `UNAUTHORIZED PRESENCE` alert.
4. **Target Match Test:** Click **"Watchlist & Rules"**, enroll a target photo/name, and return to the feed. The bounding box will switch to solid green labeled `TARGET MATCH`.
