import requests
import cv2
import numpy as np
import json
import base64
import time

BACKEND_URL = "http://localhost:8002"

# Generate a synthetic face using OpenCV with clear facial features
img = np.full((480, 640, 3), (230, 230, 230), dtype=np.uint8)

# Head outline
cv2.ellipse(img, (320, 240), (100, 140), 0, 0, 360, (180, 180, 180), -1)
cv2.ellipse(img, (320, 240), (100, 140), 0, 0, 360, (50, 50, 50), 3)

# Eyes
cv2.circle(img, (280, 210), 16, (255, 255, 255), -1)
cv2.circle(img, (360, 210), 16, (255, 255, 255), -1)
cv2.circle(img, (280, 210), 8, (20, 20, 20), -1)
cv2.circle(img, (360, 210), 8, (20, 20, 20), -1)

# Nose
pts = np.array([[320, 220], [310, 260], [330, 260]], np.int32)
cv2.polylines(img, [pts], True, (50, 50, 50), 2)

# Mouth
cv2.ellipse(img, (320, 290), (35, 15), 0, 0, 180, (40, 40, 40), 4)

_, img_enc = cv2.imencode('.jpg', img)
face_b64 = "data:image/jpeg;base64," + base64.b64encode(img_enc.tobytes()).decode()
targets = [{"name": "Teena", "imageSrc": face_b64}]

print("--- Testing Real Target Enrollment & Face Matching ---")
for f_idx in range(1, 6):
    files = {'file': ('frame.jpg', img_enc.tobytes(), 'image/jpeg')}
    data = {'targets': json.dumps(targets), 'frame_id': str(f_idx), 'timestamp': str(time.time())}
    res = requests.post(f"{BACKEND_URL}/api/scan-face", files=files, data=data).json()
    matches = res.get("matches", [])
    print(f"Face Frame #{f_idx} -> Matches: {len(matches)}, Res: {matches}")
