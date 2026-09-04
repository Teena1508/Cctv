#!/usr/bin/env python3
import requests
import json
import cv2
import numpy as np
import base64
import time
import os

BACKEND_URL = "http://localhost:8002"
IMG_PATH = "/Users/teenamunjal/.gemini/antigravity-ide/brain/d47a8497-01fd-4445-aaa2-b7fc78db952f/multi_face_test_photo_1788528578206.png"

print("==========================================================")
print("TESTING MULTI-FACE SPATIAL TRACKING & ASSOCIATION")
print("==========================================================")

if not os.path.exists(IMG_PATH):
    print(f"Error: Test photo '{IMG_PATH}' not found.")
    exit(1)

base_img = cv2.imread(IMG_PATH)
assert base_img is not None, "Failed to load test image"

# Target portrait setup
_, target_enc = cv2.imencode('.jpg', base_img[350:520, 360:440])
target_b64 = "data:image/jpeg;base64," + base64.b64encode(target_enc.tobytes()).decode()
targets = [{"name": "Enrolled Target", "imageSrc": target_b64}]

# -------------------------------------------------------------------------
# Test Multi-Frame Sequence with 2 Moving Faces
# -------------------------------------------------------------------------
tracked_history = {}

for frame_idx in range(1, 5):
    tx, ty = (frame_idx - 1) * 3, (frame_idx - 1) * 2
    M = np.float32([[1, 0, tx], [0, 1, ty]])
    shifted_img = cv2.warpAffine(base_img, M, (base_img.shape[1], base_img.shape[0]))
    
    _, buffer = cv2.imencode('.jpg', shifted_img)
    files = {'file': ('frame.jpg', buffer.tobytes(), 'image/jpeg')}
    data = {'targets': json.dumps(targets), 'frame_id': str(frame_idx), 'timestamp': str(time.time())}
    
    res = requests.post(f"{BACKEND_URL}/api/scan-face", files=files, data=data).json()
    matches = res.get('matches', [])
    
    print(f"\n[Frame #{frame_idx}] Detected Matches Count: {len(matches)}")
    assert len(matches) == 2, f"Frame #{frame_idx} expected 2 matches, got {len(matches)}"
    
    frame_track_ids = [m["track_id"] for m in matches]
    assert len(set(frame_track_ids)) == 2, f"Frame #{frame_idx} track IDs must be unique per face!"

    for m in matches:
        t_id = m["track_id"]
        bbox = m["bbox"]
        name = m["name"]
        print(f"  -> Track: {t_id} | Name: '{name}' | BBox: {bbox} | Status: {m.get('status')}")
        
        if t_id not in tracked_history:
            tracked_history[t_id] = []
        tracked_history[t_id].append(bbox)

# Verify track continuity
print("\n--- Track Continuity Verification ---")
for t_id, bboxes in tracked_history.items():
    print(f"Track {t_id}: tracked across {len(bboxes)} frames -> Initial BBox: {bboxes[0]} -> Final BBox: {bboxes[-1]}")
    assert len(bboxes) == 4, f"Track {t_id} lost frames during sequence!"

print("\n==========================================================")
print("✅ MULTI-FACE SPATIAL TRACKING VERIFIED SUCCESSFULLY!")
print("==========================================================")
