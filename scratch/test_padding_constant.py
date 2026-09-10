import cv2
import numpy as np
import insightface
from insightface.app import FaceAnalysis

app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
app.prepare(ctx_id=0, det_size=(640, 640))

img = cv2.imread('debug_frames/latest_debug.jpg')
faces = app.get(img)
face0_emb = faces[0].embedding / np.linalg.norm(faces[0].embedding)

bbox = faces[0].bbox.astype(int)
x1, y1, x2, y2 = max(0, bbox[0]), max(0, bbox[1]), min(img.shape[1], bbox[2]), min(img.shape[0], bbox[3])
crop = img[y1:y2, x1:x2]

h, w = crop.shape[:2]
pad_h, pad_w = max(100, h), max(100, w)
padded_constant = cv2.copyMakeBorder(crop, pad_h, pad_h, pad_w, pad_w, cv2.BORDER_CONSTANT, value=[128, 128, 128])
const_faces = app.get(padded_constant)
print(f"App.get() on CONSTANT padded crop found {len(const_faces)} faces.")

if const_faces:
    # Pick face closest to center of padded image
    center_x, center_y = padded_constant.shape[1] / 2.0, padded_constant.shape[0] / 2.0
    best_face = min(const_faces, key=lambda f: ( (f.bbox[0]+f.bbox[2])/2.0 - center_x )**2 + ( (f.bbox[1]+f.bbox[3])/2.0 - center_y )**2 )
    const_emb = best_face.embedding / np.linalg.norm(best_face.embedding)
    sim_const = float(np.dot(face0_emb, const_emb))
    print(f"Similarity between Face 0 embedding and CONSTANT Padded Center Face embedding: {sim_const:.4f}")
