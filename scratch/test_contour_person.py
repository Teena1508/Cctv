import cv2
import numpy as np

def detect_human_presence_contour(frame):
    if frame is None:
        return []
    h, w = frame.shape[:2]
    scale = 320.0 / float(max(w, h))
    small = cv2.resize(frame, (int(w * scale), int(h * scale)))
    sh, sw = small.shape[:2]

    ycrcb = cv2.cvtColor(small, cv2.COLOR_BGR2YCrCb)
    mask = cv2.inRange(ycrcb, (0, 130, 75), (255, 175, 130))

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    mask_closed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

    contours, _ = cv2.findContours(mask_closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    people = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area > (sw * sh * 0.012):
            x, y, cw, ch = cv2.boundingRect(cnt)
            orig_bbox = [
                int(x / scale),
                int(y / scale),
                int((x + cw) / scale),
                int((y + ch) / scale)
            ]
            people.append({
                "name": "UNAUTHORIZED PERSON",
                "confidence": 0.82,
                "bbox": orig_bbox
            })
            break
    return people

img = cv2.imread('debug_frames/latest_debug.jpg')
res = detect_human_presence_contour(img)
print("Contour person detection result:", res)
