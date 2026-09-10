import cv2
import numpy as np
import insightface
from insightface.app import FaceAnalysis

img = cv2.imread('debug_frames/latest_debug.jpg')
print(f"Loaded frame shape: {img.shape}")

app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
app.prepare(ctx_id=0, det_size=(640, 640))

def resize_for_face_detection(img, max_size=640):
    if img is None:
        return None, 1.0
    h, w = img.shape[:2]
    if w > max_size or h > max_size:
        scale = max_size / float(max(w, h))
        new_w = int(w * scale)
        new_h = int(h * scale)
        return cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA), scale
    return img, 1.0

def is_valid_face_crop(img, x, y, w, h):
    if img is None:
        return False, "img is None"
    img_h, img_w = img.shape[:2]
    if w < 15 or h < 15 or x < 0 or y < 0 or (x + w) > img_w or (y + h) > img_h:
        return False, f"boundary out: w={w}, h={h}, x={x}, y={y}, img_w={img_w}, img_h={img_h}"
    aspect = float(w) / float(h)
    if aspect < 0.35 or aspect > 2.0:
        return False, f"aspect ratio fail: {aspect}"

    crop = img[y:y+h, x:x+w]
    if crop.size == 0:
        return False, "crop size 0"
    if len(crop.shape) == 3:
        try:
            ycrcb = cv2.cvtColor(crop, cv2.COLOR_BGR2YCrCb)
            mask = cv2.inRange(ycrcb, (0, 133, 77), (255, 173, 127))
            skin_ratio = np.sum(mask > 0) / float(mask.size)
            if skin_ratio < 0.02:
                return False, f"skin ratio fail: {skin_ratio:.4f}"
        except Exception as e:
            pass
    return True, "valid"

processed_frame, scale = resize_for_face_detection(img, max_size=640)
print(f"Processed frame shape: {processed_frame.shape}, scale: {scale}")

faces = app.get(processed_frame)
print(f"Faces detected on processed frame: {len(faces)}")
for idx, f in enumerate(faces):
    det_score = getattr(f, 'det_score', 0.88)
    raw_bbox = f.bbox.tolist()
    rx1, ry1, rx2, ry2 = int(raw_bbox[0]), int(raw_bbox[1]), int(raw_bbox[2]), int(raw_bbox[3])
    rw, rh = rx2 - rx1, ry2 - ry1
    valid, reason = is_valid_face_crop(processed_frame, rx1, ry1, rw, rh)
    print(f" Face {idx}: det_score={det_score:.3f}, bbox=[{rx1},{ry1},{rx2},{ry2}], rw={rw}, rh={rh}, valid={valid}, reason={reason}")

