import cv2
import numpy as np

img = cv2.imread('debug_frames/latest_debug.jpg')
print(f"Loaded frame shape: {img.shape}")

hog = cv2.HOGDescriptor()
hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())

rects, weights = hog.detectMultiScale(img, winStride=(8, 8), padding=(8, 8), scale=1.05)
print(f"HOG default people detector found {len(rects)} people.")
for idx, (x, y, w, h) in enumerate(rects):
    weight = weights[idx] if idx < len(weights) else 0.0
    print(f" Person {idx}: x={x}, y={y}, w={w}, h={h}, weight={weight}")
