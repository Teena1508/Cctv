import cv2
import numpy as np
import base64
import insightface
from insightface.app import FaceAnalysis

app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
app.prepare(ctx_id=0, det_size=(640, 640))
rec_model = app.models['recognition']

img = cv2.imread('debug_frames/latest_debug.jpg')
faces = app.get(img)
print(f"Total detected faces: {len(faces)}")

# Face 0 is Teena
face0_emb = faces[0].embedding / np.linalg.norm(faces[0].embedding)

# Simulate enrolled target 'Teena'
threshold = 0.38

for idx, f in enumerate(faces):
    emb = f.embedding / np.linalg.norm(f.embedding)
    sim = float(np.dot(emb, face0_emb))
    if sim >= threshold:
        decision = "Teena (TARGET - GREEN BOX)"
    else:
        decision = "UNAUTHORIZED PERSON (RED BOX)"
    print(f"Face {idx}: bbox={f.bbox.astype(int)}, Cosine Sim = {sim:.4f} => Decision: {decision}")
