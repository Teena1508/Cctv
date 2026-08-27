from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
import cv2
import numpy as np
import easyocr
import re

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

print("Loading EasyOCR Engine...")
# Enabled digits and uppercase letters for fast, short-number detection
reader = easyocr.Reader(['en'], gpu=False)
print("EasyOCR Engine Ready for Digits & Plates!")

@app.post("/api/scan-plate")
async def scan_plate(file: UploadFile = File(...)):
    contents = await file.read()
    nparr = np.frombuffer(contents, np.uint8)
    frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if frame is None:
        return {"results": []}

    h, w, _ = frame.shape
    
    # 1. Focus on the central camera area
    crop_x1, crop_y1 = int(w * 0.15), int(h * 0.15)
    crop_x2, crop_y2 = int(w * 0.85), int(h * 0.85)
    cropped = frame[crop_y1:crop_y2, crop_x1:crop_x2]

    # 2. Preprocess frame: Upscale + Grayscale + Adaptive Thresholding (Crisp B&W)
    scaled = cv2.resize(cropped, None, fx=2.5, fy=2.5, interpolation=cv2.INTER_CUBIC)
    gray = cv2.cvtColor(scaled, cv2.COLOR_BGR2GRAY)
    
    # High contrast binarization (makes simple text like '1234' pop against paper/background)
    thresh = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 11, 2
    )

    # 3. OCR Inference with allowlist for letters and numbers
    results = reader.readtext(thresh, allowlist='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-')
    
    # Fallback scan on grayscale if threshold misses
    if not results:
        results = reader.readtext(gray)

    detected_plates = []
    for (bbox, text, prob) in results:
        cleaned = re.sub(r'[^A-Z0-9]', '', text.upper())
        
        # Log everything to terminal so you can monitor scans
        if len(cleaned) > 0:
            print(f"👉 RAW READ: '{text}' | CLEANED: '{cleaned}' | CONFIDENCE: {prob:.2f}")

        # Lower threshold to accept short numbers like '1234'
        if len(cleaned) >= 2 and prob > 0.15:
            detected_plates.append({"text": cleaned, "confidence": float(prob)})

    return {"results": detected_plates}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8002)