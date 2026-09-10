import cv2
import numpy as np
import base64
import insightface
from insightface.app import FaceAnalysis

app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
app.prepare(ctx_id=0, det_size=(640, 640))
rec_model = app.models['recognition']

# 1. Load latest_debug.jpg (4 faces)
img = cv2.imread('debug_frames/latest_debug.jpg')
faces = app.get(img)
print(f"Total detected faces in test scene: {len(faces)}")

# Enroll Face 0 as target 'Teena' using tight crop
bbox0 = faces[0].bbox.astype(int)
crop0 = img[max(0, bbox0[1]):min(img.shape[0], bbox0[3]), max(0, bbox0[0]):min(img.shape[1], bbox0[2])]
_, enc0 = cv2.imencode('.jpg', crop0)
b64_0 = "data:image/jpeg;base64," + base64.b64encode(enc0.tobytes()).decode()

# Target embedding extractor
def get_target_embedding_test(image_src):
    if "," in image_src:
        _, encoded = image_src.split(",", 1)
    else:
        encoded = image_src
    img_data = base64.b64decode(encoded)
    nparr = np.frombuffer(img_data, np.uint8)
    raw_img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if raw_img is None:
        return None

    faces = app.get(raw_img)
    if not faces:
        h, w = raw_img.shape[:2]
        pad_h, pad_w = max(100, h), max(100, w)
        padded = cv2.copyMakeBorder(raw_img, pad_h, pad_h, pad_w, pad_w, cv2.BORDER_CONSTANT, value=[128, 128, 128])
        faces = app.get(padded)

    if faces:
        best_face = min(faces, key=lambda f: (( (f.bbox[0]+f.bbox[2])/2.0 - raw_img.shape[1]/2.0 )**2 + ( (f.bbox[1]+f.bbox[3])/2.0 - raw_img.shape[0]/2.0 )**2))
        emb = best_face.embedding
        norm = np.linalg.norm(emb)
        return emb / norm if norm > 0 else None

    # Fallback to direct 112x112 ArcFace
    crop_112 = cv2.resize(raw_img, (112, 112))
    feat = rec_model.get_feat(crop_112).flatten()
    norm = np.linalg.norm(feat)
    return feat / norm if norm > 0 else None

target_emb = get_target_embedding_test(b64_0)
print(f"Target 'Teena' enrolled successfully. Vector shape: {target_emb.shape}")

# Now match all 4 faces in frame against target 'Teena'
for idx, f in enumerate(faces):
    emb = f.embedding / np.linalg.norm(f.embedding)
    sim = float(np.dot(emb, target_emb))
    is_match = sim >= 0.25
    match_name = "Teena" if is_match else "UNAUTHORIZED PERSON"
    print(f"Face {idx}: bbox={f.bbox.astype(int)}, Cosine Sim with 'Teena' = {sim:.4f} => Decision: {match_name}")
