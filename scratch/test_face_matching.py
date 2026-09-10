import cv2
import numpy as np
import insightface
from insightface.app import FaceAnalysis

app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
app.prepare(ctx_id=0, det_size=(640, 640))

rec_model = app.models['recognition']

img1 = cv2.imread('debug_frames/latest_debug.jpg')
if img1 is None:
    print("latest_debug.jpg not found")
    exit(1)

faces1 = app.get(img1)
print(f"Detected {len(faces1)} faces in latest_debug.jpg")

if faces1:
    emb1 = faces1[0].embedding
    norm1 = np.linalg.norm(emb1)
    emb1 = emb1 / norm1

    # Compare face 0 with all faces in same image
    for idx, f in enumerate(faces1):
        emb2 = f.embedding
        norm2 = np.linalg.norm(emb2)
        emb2 = emb2 / norm2
        sim = float(np.dot(emb1, emb2))
        print(f"Similarity Face 0 vs Face {idx}: {sim:.4f}")

    # Now crop face 0 and pass to rec_model directly to see similarity between crop vs full detection
    bbox = faces1[0].bbox.astype(int)
    x1, y1, x2, y2 = max(0, bbox[0]), max(0, bbox[1]), min(img1.shape[1], bbox[2]), min(img1.shape[0], bbox[3])
    crop = img1[y1:y2, x1:x2]
    crop_112 = cv2.resize(crop, (112, 112))
    feat_crop = rec_model.get_feat(crop_112).flatten()
    feat_crop = feat_crop / np.linalg.norm(feat_crop)

    sim_crop = float(np.dot(emb1, feat_crop))
    print(f"Similarity Full Detection Embedding vs Raw Crop ArcFace Embedding: {sim_crop:.4f}")
