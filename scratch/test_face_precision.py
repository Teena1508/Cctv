import sys
import os
import cv2
import numpy as np
import base64
import json
from fastapi.testclient import TestClient

# Add workspace root to sys.path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.append(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cctv-backend"))

import main as cctv_main

client = TestClient(cctv_main.app)

def create_empty_frame():
    """Creates a background scene without any human faces."""
    img = np.full((480, 640, 3), (180, 190, 200), dtype=np.uint8) # light grey/beige background
    cv2.rectangle(img, (50, 300), (590, 470), (100, 120, 140), -1) # table top
    cv2.circle(img, (550, 100), 40, (230, 240, 250), -1) # lamp light glow
    return img

def test_api_precision():
    print("\n--- TESTING API ENDPOINT /api/scan-face PRECISION ---")
    
    empty_img = create_empty_frame()
    _, empty_buf = cv2.imencode('.jpg', empty_img)
    empty_bytes = empty_buf.tobytes()
    
    targets = [{"name": "Enrolled Operator", "imageSrc": "data:image/jpeg;base64," + base64.b64encode(empty_bytes).decode('utf-8')}]
    
    response = client.post(
        "/api/scan-face",
        files={"file": ("frame.jpg", empty_bytes, "image/jpeg")},
        data={"targets": json.dumps(targets), "frame_id": "1", "timestamp": "1234567.0"}
    )
    
    assert response.status_code == 200
    res_data = response.json()
    print("API Response for Empty Room Frame:", res_data)
    
    matches = res_data.get("matches", [])
    if len(matches) == 0:
        print("✅ PASSED: /api/scan-face returned 0 matches for empty frame!")
    else:
        print(f"❌ FAILED: /api/scan-face returned false matches: {matches}")
        sys.exit(1)

if __name__ == '__main__':
    test_api_precision()
