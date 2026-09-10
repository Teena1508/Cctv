import requests
import json
import cv2
import numpy as np

# Create dummy image
img = np.zeros((480, 640, 3), dtype=np.uint8)
cv2.ellipse(img, (320, 240), (80, 100), 0, 0, 360, (200, 180, 150), -1)
cv2.circle(img, (290, 210), 10, (50, 50, 50), -1)
cv2.circle(img, (350, 210), 10, (50, 50, 50), -1)
_, buf = cv2.imencode('.jpg', img)

files = {'file': ('frame.jpg', buf.tobytes(), 'image/jpeg')}
data = {'targets': json.dumps([]), 'frame_id': '1', 'timestamp': '12345.6'}

try:
    res = requests.post('http://localhost:8002/api/scan-face', files=files, data=data)
    print("Status code:", res.status_code)
    print("Response JSON:", res.json())
except Exception as e:
    print("Error calling backend:", e)
