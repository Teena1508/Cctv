import cv2
import numpy as np
import base64
import json
import insightface
from insightface.app import FaceAnalysis

app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
app.prepare(ctx_id=0, det_size=(640, 640))

rec_model = app.models['recognition']

# Load latest_debug.jpg and crop face 0 as enrolled target photo
img = cv2.imread('debug_frames/latest_debug.jpg')
faces = app.get(img)
if not faces:
    print("No face detected in debug frame")
    exit(1)

# Extract real 512D ArcFace embedding of Face 0
face0 = faces[0]
face0_emb = face0.embedding / np.linalg.norm(face0.embedding)

# Crop face 0 to simulate webcam snapshot / uploaded photo
bbox = face0.bbox.astype(int)
x1, y1, x2, y2 = max(0, bbox[0]), max(0, bbox[1]), min(img.shape[1], bbox[2]), min(img.shape[0], bbox[3])
crop = img[y1:y2, x1:x2]

_, crop_enc = cv2.imencode('.jpg', crop)
crop_b64 = "data:image/jpeg;base64," + base64.b64encode(crop_enc.tobytes()).decode()

def decode_base64_image(image_src):
    if "," in image_src:
        _, encoded = image_src.split(",", 1)
    else:
        encoded = image_src
    img_data = base64.b64decode(encoded)
    nparr = np.frombuffer(img_data, np.uint8)
    return cv2.imdecode(nparr, cv2.IMREAD_COLOR)

# Test extracting embedding from tight crop
target_img = decode_base64_image(crop_b64)
det_faces = app.get(target_img)
print(f"Direct app.get() on tight crop found {len(det_faces)} faces.")

# Test face_align norm crop using landmarks or direct 112x112 ArcFace extraction
h, w = target_img.shape[:2]
padded = cv2.copyMakeBorder(target_img, h, h, w, w, cv2.BORDER_REFLECT)
padded_faces = app.get(padded)
print(f"App.get() on padded crop found {len(padded_faces)} faces.")

# Direct ArcFace recognition model on resized 112x112
crop_112 = cv2.resize(target_img, (112, 112))
direct_emb = rec_model.get_feat(crop_112).flatten()
direct_emb = direct_emb / np.linalg.norm(direct_emb)

sim_with_face0 = float(np.dot(face0_emb, direct_emb))
print(f"Similarity between Face 0 embedding and direct ArcFace crop embedding: {sim_with_face0:.4f}")

if padded_faces:
    padded_emb = padded_faces[0].embedding / np.linalg.norm(padded_faces[0].embedding)
    sim_padded = float(np.dot(face0_emb, padded_emb))
    print(f"Similarity between Face 0 embedding and Padded Face embedding: {sim_padded:.4f}")
