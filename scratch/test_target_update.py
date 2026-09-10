import requests
import json
import cv2
import numpy as np
import base64

BACKEND_URL = "http://localhost:8002"

# 1. Create solid target image
img = np.full((300, 300, 3), (200, 180, 160), dtype=np.uint8)
cv2.circle(img, (150, 150), 80, (120, 100, 80), -1)

_, img_enc = cv2.imencode('.jpg', img)
b64_str = "data:image/jpeg;base64," + base64.b64encode(img_enc.tobytes()).decode()

targets = [{"name": "Test_Target_Teena", "imageSrc": b64_str}]

files = {'file': ('frame.jpg', img_enc.tobytes(), 'image/jpeg')}
data = {'targets': json.dumps(targets), 'frame_id': '1', 'timestamp': '12345.0'}

res = requests.post(f"{BACKEND_URL}/api/scan-face", files=files, data=data).json()
print("Scan Face Response:", res)
