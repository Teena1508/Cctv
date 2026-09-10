import sys
import os
import cv2
import numpy as np
import base64
import json
from fastapi.testclient import TestClient

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.append(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cctv-backend"))

import main as cctv_main

client = TestClient(cctv_main.app)

def test_unauthorized_person_classification():
    print("\n--- TESTING UNAUTHORIZED PERSON CLASSIFICATION ---")
    
    # Create synthetic face image
    face_img = np.full((300, 300, 3), (200, 200, 200), dtype=np.uint8)
    cv2.circle(face_img, (150, 150), 80, (140, 160, 200), -1) # face oval
    cv2.circle(face_img, (120, 130), 10, (50, 50, 50), -1)   # eye left
    cv2.circle(face_img, (180, 130), 10, (50, 50, 50), -1)   # eye right
    cv2.ellipse(face_img, (150, 180), (30, 15), 0, 0, 180, (50, 50, 50), 3) # mouth
    
    _, face_buf = cv2.imencode('.jpg', face_img)
    face_bytes = face_buf.tobytes()
    
    # Target enrolled with dummy image
    targets = [{"name": "John Doe", "imageSrc": "data:image/jpeg;base64," + base64.b64encode(face_bytes).decode('utf-8')}]
    
    response = client.post(
        "/api/scan-face",
        files={"file": ("frame.jpg", face_bytes, "image/jpeg")},
        data={"targets": json.dumps(targets), "frame_id": "1", "timestamp": "1234567.0"}
    )
    
    assert response.status_code == 200
    res_data = response.json()
    print("API Scan-Face Response:", res_data)
    print("✅ Endpoint successfully responded without errors.")

if __name__ == '__main__':
    test_unauthorized_person_classification()
