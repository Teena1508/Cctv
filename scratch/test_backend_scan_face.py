import requests
import json
import cv2

BACKEND_URL = "http://localhost:8002"

with open('debug_frames/latest_debug.jpg', 'rb') as f:
    img_bytes = f.read()

files = {'file': ('frame.jpg', img_bytes, 'image/jpeg')}
targets = [{"name": "Teena", "imageSrc": "data:image/jpeg;base64,"}]
data = {'targets': json.dumps([]), 'frame_id': '9999', 'timestamp': '12345.0'}

res = requests.post(f"{BACKEND_URL}/api/scan-face", files=files, data=data).json()
print("Scan Face Response (empty targets):", json.dumps(res, indent=2))
