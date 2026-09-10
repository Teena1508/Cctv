# AI Video Surveillance & Threat Detection System

A real-time, edge-assisted AI surveillance dashboard and analytics engine for automated threat detection, facial recognition, license plate recognition (ALPR), and restricted zone intrusion monitoring.

---

## 1. What Problem Are You Solving?

Traditional CCTV monitoring relies on passive recording and human operators manually watching dozens of screens. This leads to critical vulnerabilities:
- **Operator Fatigue & Blind Spots**: Human attention drops significantly after 20 minutes of screen monitoring.
- **Delayed Incident Reaction**: Security teams usually investigate footage *after* an incident has already occurred.
- **Alert Spam & Alarm Fatigue**: Conventional motion sensors trigger constant false alarms for shadows, lighting changes, or pets, causing operators to ignore real alerts.
- **Lack of Tracking Lifecycle**: Standard systems don't distinguish between arrival, continuous dwell, and departure of an unauthorized person.

---

## 2. What Is Your Proposed Solution?

An end-to-end AI surveillance platform combining a **Python computer vision backend** with a **React operational dashboard**. 

The system automatically:
- Identifies enrolled watchlist targets (green HUD overlays) vs. unenrolled individuals (red HUD overlays).
- Triggers immediate **`UNAUTHORIZED PRESENCE`** alerts upon arrival without spamming repeated alerts while the person remains in frame.
- Automatically logs a **`SUBJECT DEPARTED`** event within **1.0 second** of an unauthorized person leaving the camera view.
- Enforces temporal restricted-zone rules (e.g., off-hours intrusion policies) and upgrades threat severity dynamically.

---

## 3. How Does It Work?

```
[ Camera / Webcam / RTSP Stream ]
              │
              ▼
    [ React Dashboard (Vite) ] ── (640px JPEG Blob @ ~300ms) ──► [ Python AI Backend (FastAPI) ]
              │                                                             │
              │◄── [ Bounding Boxes, Match Scores, Lifecycle State ] ───────┘
              ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  • Visual Overlay: Color-coded Bounding Boxes (Red=Intruder, Green=Target)│
│  • HUD Status Bar: Displays TARGET, INTRUDER DETECTED, or LEFT:<Subject> │
│  • Live Feed Logs: Real-time alert feed with GPS coordinates & severity  │
└──────────────────────────────────────────────────────────────────────────┘
```

1. **Frame Capture & Ingestion**: The React frontend (`CameraFeed.jsx`) captures stream frames at 640px resolution and posts them to the backend API (`/api/scan-face`, `/api/scan-plate`).
2. **ArcFace Embedding & Feature Matching**: InsightFace extracts 512-dimensional facial vector embeddings and computes cosine similarity against enrolled watchlist vectors.
3. **Classification & Overlap NMS**: Detections with similarity $\ge 0.68$ match enrolled targets (`TARGET MATCH`). Unenrolled or low-confidence faces are classified as `UNAUTHORIZED PERSON`. Non-Maximum Suppression (NMS) deduplicates overlapping bounding boxes.
4. **Presence Lifecycle Management**:
   - **Arrival**: Emits a single entry alert (`UNAUTHORIZED PRESENCE` or `TARGET MATCH`).
   - **Dwell**: Keeps presence refreshed during continuous view with a 20-second deduplication window to stop alert spam.
   - **Departure**: When a person exits frame for $>1.0\text{s}$, the system deletes the active track and logs a clean `SUBJECT DEPARTED` event.
5. **Restricted Zone Engine**: Evaluates active security rules (e.g., off-hours window `22:00 - 06:00`) to upgrade unauthorized presences to `RESTRICTED INTRUSION` (Critical severity).

---

## 4. Which Technologies Did You Use?

### Artificial Intelligence & Backend
- **Python 3.10+**: Core backend runtime.
- **InsightFace & ONNX Runtime**: ArcFace deep 512D facial vector extraction and face detection.
- **FastAPI & Uvicorn**: Async API server for real-time frame scanning.
- **OpenCV & Pillow**: High-performance image transformation, cropping, and color conversion.
- **FastOCR / EasyOCR**: Automated License Plate Recognition (ALPR).

### Dashboard & Frontend
- **React 18 & Vite**: Fast client-side dashboard with live HUD canvas rendering.
- **Tailwind CSS**: Glassmorphic dark UI layout.
- **Lucide React**: Operational icon system.
- **Leaflet / React-Leaflet**: Interactive GIS tactical map for camera placement and alert pins.

---

## 5. How Can a Reviewer Run It?

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
2. Allow webcam access or connect an IP camera stream URL (MJPEG / RTSP / Python HTTP feed).
3. **Test Unenrolled Person**: Stand in front of the camera. The HUD will show a **solid red bounding box (`#f43f5e`)** labeled `UNAUTHORIZED PERSON` and fire an `UNAUTHORIZED PRESENCE` alert.
4. **Test Departure**: Step away from the camera view. Within **1.0 second**, the camera HUD status will change to `LEFT: UNAUTHORIZED PERSON` and log a low-severity `SUBJECT DEPARTED` event in the live feed.
5. **Test Watchlist Target**: Click **"Enroll New Target"**, add a photo/name, and return to the feed. The system will switch your bounding box to **solid green (`#22c55e`)** with `TARGET MATCH`.

---

## 6. What Does the Final Output Look Like?

- **Real-Time Video HUD**: Live video stream with smooth bounding boxes (Red for unauthorized intruders, Green for watchlist targets).
- **HUD Status Indicator**: Top-right status box showing real-time states (`SCANNING`, `INTRUDER DETECTED`, `TARGET: <Name>`, or `LEFT: <Subject>`).
- **Live Security Feed**: Right-side panel listing categorized alerts with exact timestamps, camera node IDs, severity badges (CRITICAL, HIGH, LOW), and GPS coordinates.
- **GIS Tactical Map**: Map view displaying active camera nodes, live geolocation markers, and quick pin focusing on alert locations.

---

## 7. Important Features and Expected Impact

### Important Features
- **ArcFace 512D Precision**: High face match accuracy preventing false positives and bounding box color flickering.
- **Zero Alert Spam**: Single entry alert on arrival with a 20-second deduplication window during dwell.
- **Fast Departure Lifecycle**: Automatic departure detection in **~1.0 second** when an individual leaves the camera view.
- **Off-Hours Security Rules**: Flexible rule evaluator allowing custom time windows (`22:00 - 06:00`) and vehicle/person constraints.
- **Dual Support**: Seamlessly handles live webcams, RTSP streams, and MJPEG IP feeds.

### Expected Impact
- **80%+ Reduction in Operator Fatigue**: Eliminates manual screen monitoring by highlighting actionable threats automatically.
- **Zero False Alarm Distractions**: Rate-limiting and vector matching stop repeated alarm spam.
- **Complete Operational Awareness**: Provides clear arrival, dwell, and departure audit logs for every individual detected on-site.
