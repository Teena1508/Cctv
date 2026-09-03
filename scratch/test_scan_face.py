import requests
import json
import cv2
import numpy as np
import base64

# Generate dummy image
img = np.zeros((480, 640, 3), dtype=np.uint8)
cv2.rectangle(img, (200, 100), (440, 380), (200, 200, 200), -1)
cv2.circle(img, (320, 200), 50, (150, 150, 150), -1)

_, buffer = cv2.imencode('.jpg', img)
img_bytes = buffer.tobytes()
b64_str = "data:image/jpeg;base64," + base64.b64encode(img_bytes).decode('utf-8')

targets = [{"name": "Test User", "imageSrc": b64_str}]

response = requests.post(
    "http://localhost:8002/api/scan-face",
    files={"file": ("frame.jpg", img_bytes, "image/jpeg")},
    data={"targets": json.dumps(targets)}
)

print("Status:", response.status_code)
print("Response:", response.json())
