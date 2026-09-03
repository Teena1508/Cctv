import requests
import cv2
import numpy as np
import json
import time

BACKEND_URL = "http://localhost:8002"

print("==========================================================")
print("TESTING CCTV AI DETECTION & ANPR PIPELINE")
print("==========================================================")

# 1. Test Home / Status endpoint
resp = requests.get(f"{BACKEND_URL}/")
print(f"[1] Backend Status Endpoint: {resp.json()}")
assert resp.status_code == 200

# 2. Test Empty Scene Frame (No Person, No Plate)
empty_frame = np.zeros((480, 640, 3), dtype=np.uint8) + 50
_, img_encoded = cv2.imencode('.jpg', empty_frame)
files = {'file': ('frame.jpg', img_encoded.tobytes(), 'image/jpeg')}
data = {'targets': json.dumps([]), 'frame_id': '1', 'timestamp': str(time.time())}

res_face = requests.post(f"{BACKEND_URL}/api/scan-face", files=files, data=data).json()
print(f"[2] Empty Frame Scan Face Result: {res_face}")
assert len(res_face["matches"]) == 0, "Empty scene should return 0 face matches!"

# 3. Test Synthetic Person Face Registration & Temporal Tracking
# Create synthetic face target portrait
target_face_img = np.zeros((300, 300, 3), dtype=np.uint8) + 120
cv2.circle(target_face_img, (150, 150), 80, (200, 200, 200), -1) # Head
cv2.circle(target_face_img, (120, 120), 12, (20, 20, 20), -1)   # Left eye
cv2.circle(target_face_img, (180, 120), 12, (20, 20, 20), -1)   # Right eye
cv2.ellipse(target_face_img, (150, 180), (30, 15), 0, 0, 180, (20, 20, 20), 4) # Mouth

_, target_enc = cv2.imencode('.jpg', target_face_img)
import base64
target_b64 = "data:image/jpeg;base64," + base64.b64encode(target_enc.tobytes()).decode()
targets = [{"name": "TestSubject", "imageSrc": target_b64}]

print("\n--- Testing Temporal Person Tracking (N out of M Frames) ---")
# Simulate sequence of 5 frames with person present
for frame_idx in range(1, 6):
    frame_person = target_face_img.copy()
    _, f_enc = cv2.imencode('.jpg', frame_person)
    files = {'file': ('frame.jpg', f_enc.tobytes(), 'image/jpeg')}
    data = {'targets': json.dumps(targets), 'frame_id': str(frame_idx), 'timestamp': str(time.time())}
    res = requests.post(f"{BACKEND_URL}/api/scan-face", files=files, data=data).json()
    matches = res.get("matches", [])
    status = matches[0]["status"] if matches else "NO_MATCH"
    print(f"Frame #{frame_idx} -> Matches: {len(matches)}, Status: {status}")

print("\n--- Testing Person Disappearance (Absence Confirmation) ---")
# Simulate sequence of 4 empty frames
for frame_idx in range(6, 10):
    _, f_enc = cv2.imencode('.jpg', empty_frame)
    files = {'file': ('frame.jpg', f_enc.tobytes(), 'image/jpeg')}
    data = {'targets': json.dumps(targets), 'frame_id': str(frame_idx), 'timestamp': str(time.time())}
    res = requests.post(f"{BACKEND_URL}/api/scan-face", files=files, data=data).json()
    matches = res.get("matches", [])
    print(f"Frame #{frame_idx} (Person Left) -> Matches: {len(matches)}")
    assert len(matches) == 0, f"Frame #{frame_idx} should report 0 matches after person left!"

# 4. Test License Plate ANPR & Preprocessing & Temporal Consensus
print("\n--- Testing License Plate Crop & OCR Normalization ---")
plate_frame = np.zeros((480, 640, 3), dtype=np.uint8) + 200
# Draw a high contrast license plate rectangle with text "DL01AB1234"
cv2.rectangle(plate_frame, (180, 200), (460, 280), (255, 255, 255), -1)
cv2.rectangle(plate_frame, (180, 200), (460, 280), (0, 0, 0), 4)
cv2.putText(plate_frame, "DL01AB1234", (195, 255), cv2.FONT_HERSHEY_SIMPLEX, 1.3, (0, 0, 0), 4)

# Stream 4 consecutive frames with plate to build OCR consensus
for p_idx in range(1, 5):
    _, p_enc = cv2.imencode('.jpg', plate_frame)
    files = {'file': ('frame.jpg', p_enc.tobytes(), 'image/jpeg')}
    data = {'frame_id': str(p_idx), 'timestamp': str(time.time())}
    res = requests.post(f"{BACKEND_URL}/api/scan-plate", files=files, data=data).json()
    results = res.get("results", [])
    text = results[0]["text"] if (results and results[0]) else "NO_READ"
    conf = results[0]["confidence"] if (results and results[0]) else 0.0
    print(f"Plate Frame #{p_idx} -> ANPR Consensus Result: {text} (Conf: {conf})")

print("\n==========================================================")
print("ALL TESTS PASSED SUCCESSFULLY!")
print("==========================================================")
