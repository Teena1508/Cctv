from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
import cv2
import numpy as np
import easyocr
import re

app = FastAPI()

# Enable CORS for React frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize EasyOCR Reader (loads models once on startup)
print("Loading EasyOCR model into memory...")
reader = easyocr.Reader(['en'], gpu=False)
print("EasyOCR Engine Ready!")

@app.get("/")
def home():
    return {"status": "ANPR Backend Running"}

@app.post("/api/scan-plate")
async def scan_plate(file: UploadFile = File(...)):
    contents = await file.read()
    nparr = np.frombuffer(contents, np.uint8)
    frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    # Pre-processing (Grayscale + Contrast Boost)
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)

    # Run OCR inference
    results = reader.readtext(enhanced)

    detected_plates = []
    for (bbox, text, prob) in results:
        cleaned = re.sub(r'[^A-Z0-9]', '', text.upper())
        if len(cleaned) >= 3 and prob > 0.35:
            detected_plates.append({"text": cleaned, "confidence": float(prob)})

    return {"results": detected_plates}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8002)