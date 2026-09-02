import os
import json
import base64
import re
from fastapi import FastAPI, File, UploadFile, Form
from fastapi.middleware.cors import CORSMiddleware
import cv2
import numpy as np
import easyocr
import insightface
from insightface.app import FaceAnalysis

app = FastAPI()

# Enable CORS for React dashboard
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 1. Initialize EasyOCR Reader (loads models once on startup)
print("[ANPR Engine] Loading EasyOCR Engine...")
reader = easyocr.Reader(['en'], gpu=False)
print("[ANPR Engine] EasyOCR Engine Ready for Digits & Plates!")

# 2. Smart Face Analyzer with Robust InsightFace & Haar Fallback
class SmartFaceAnalyzer:
    def __init__(self):
        self.real_analyzer = None
        self.fallback_analyzer = None
        self.try_init_real()
        if self.real_analyzer is None:
            self.init_fallback()

    def try_init_real(self):
        try:
            print("[SmartFaceAnalyzer] Initializing InsightFace Buffalo_L model...")
            real = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
            real.prepare(ctx_id=0, det_size=(480, 480))
            self.real_analyzer = real
            print("[SmartFaceAnalyzer] Loaded InsightFace model successfully.")
        except Exception as e:
            print(f"[SmartFaceAnalyzer] Could not load InsightFace model directly: {e}. Trying buffalo_sc...")
            try:
                real = FaceAnalysis(name='buffalo_sc', providers=['CPUExecutionProvider'])
                real.prepare(ctx_id=0, det_size=(480, 480))
                self.real_analyzer = real
                print("[SmartFaceAnalyzer] Loaded InsightFace buffalo_sc successfully.")
            except Exception as ex:
                print(f"[SmartFaceAnalyzer] InsightFace initialization failed: {ex}")
                self.real_analyzer = None

    def init_fallback(self):
        print("[SmartFaceAnalyzer] Initializing OpenCV Haar Cascade face detector fallback...")
        self.fallback_analyzer = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
        if self.fallback_analyzer.empty():
            print("[SmartFaceAnalyzer] ERROR: Failed to load Haar Cascade XML!")
        else:
            print("[SmartFaceAnalyzer] Fallback face detector initialized successfully.")

    def get(self, img):
        if img is None:
            return []
            
        # Try real InsightFace analyzer first
        if self.real_analyzer is not None:
            try:
                return self.real_analyzer.get(img)
            except Exception as e:
                print(f"[SmartFaceAnalyzer] InsightFace get() error: {e}. Attempting fallback...")
                self.real_analyzer = None
                if self.fallback_analyzer is None:
                    self.init_fallback()

        # Fallback Haar Cascade detector
        if self.fallback_analyzer is not None:
            if len(img.shape) == 3 and img.shape[2] == 3:
                gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            else:
                gray = img
                
            detected = self.fallback_analyzer.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4, minSize=(40, 40))
            
            class HaarFace:
                def __init__(self, bbox, embedding):
                    self.bbox = bbox
                    self.embedding = embedding
                    self.det_score = 0.90
                    
            faces = []
            for (x, y, w, h) in detected:
                face_crop = gray[y:y+h, x:x+w]
                resized = cv2.resize(face_crop, (16, 16), interpolation=cv2.INTER_AREA)
                sig_256 = resized.flatten().astype(np.float32) / 255.0
                sig_512 = np.concatenate([sig_256, sig_256])
                faces.append(HaarFace(bbox=np.array([int(x), int(y), int(x+w), int(y+h)]), embedding=sig_512))
            return faces
            
        return []

# Initialize smart analyzer
face_analyzer = SmartFaceAnalyzer()

# Embeddings Cache for enrolled target portraits to optimize runtime performance
target_cache = {}

def resize_for_face_detection(img, max_size=640):
    if img is None:
        return None, 1.0
    h, w = img.shape[:2]
    if w > max_size or h > max_size:
        scale = max_size / max(w, h)
        new_w = int(w * scale)
        new_h = int(h * scale)
        return cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA), scale
    return img, 1.0

def decode_base64_image(image_src):
    try:
        if "," in image_src:
            header, encoded = image_src.split(",", 1)
        else:
            encoded = image_src
        img_data = base64.b64decode(encoded)
        nparr = np.frombuffer(img_data, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        return img
    except Exception as e:
        print(f"Error decoding base64 image: {e}")
        return None

def get_target_embedding(target):
    name = target.get("name", "Unknown")
    image_src = target.get("imageSrc", "")
    if not image_src:
        return None
    
    if image_src in target_cache:
        return target_cache[image_src]
    
    img = decode_base64_image(image_src)
    if img is None:
        return None
        
    resized_img, _ = resize_for_face_detection(img)
    faces = face_analyzer.get(resized_img)

    # Fallback to contrast-enhanced image if dim
    if not faces and resized_img is not None and len(resized_img.shape) == 3:
        lab = cv2.cvtColor(resized_img, cv2.COLOR_BGR2LAB)
        l, a, b = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
        cl = clahe.apply(l)
        enhanced_lab = cv2.merge((cl, a, b))
        enhanced_bgr = cv2.cvtColor(enhanced_lab, cv2.COLOR_LAB2BGR)
        faces = face_analyzer.get(enhanced_bgr)

    if not faces:
        print(f"[Face Ingest] ⚠️ No faces found in enrolled target image for '{name}'")
        return None
        
    # Select largest face
    largest_face = max(faces, key=lambda x: (x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1]))
    embedding = largest_face.embedding
    norm = np.linalg.norm(embedding)
    if norm > 0:
        embedding = embedding / norm
        
    target_cache[image_src] = embedding
    print(f"[Face Ingest] ✅ Cached embedding for target: '{name}'")
    return embedding

def locate_license_plate_candidates(frame):
    """
    Extracts candidate license plate regions using Sobel vertical edge detection,
    morphological closing, and rectangular aspect ratio filtering.
    """
    if frame is None:
        return []
        
    h, w = frame.shape[:2]
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    
    # Smooth image to preserve edges while removing high frequency noise
    blur = cv2.bilateralFilter(gray, 9, 75, 75)
    
    # Sobel X derivative to accentuate vertical text edges
    sobel_x = cv2.Sobel(blur, cv2.CV_8U, 1, 0, ksize=3)
    
    # Otsu thresholding
    _, thresh = cv2.threshold(sobel_x, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    
    # Morphological closing to group characters into plate shapes
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (21, 5))
    closed = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)
    
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    candidates = []
    for cnt in contours:
        x, y, cw, ch = cv2.boundingRect(cnt)
        if cw < 30 or ch < 10 or cw > w * 0.95 or ch > h * 0.95:
            continue
        aspect_ratio = float(cw) / float(ch)
        area = cw * ch
        # Typical license plate aspect ratio is between 1.8 and 6.5
        if 1.8 <= aspect_ratio <= 6.5 and 400 <= area <= (w * h * 0.5):
            pad_x = int(cw * 0.08)
            pad_y = int(ch * 0.15)
            x1 = max(0, x - pad_x)
            y1 = max(0, y - pad_y)
            x2 = min(w, x + cw + pad_x)
            y2 = min(h, y + ch + pad_y)
            crop = frame[y1:y2, x1:x2]
            if crop.size > 0:
                candidates.append({
                    "bbox": [x1, y1, x2, y2],
                    "crop": crop
                })
    return candidates

@app.get("/")
def home():
    is_fallback = face_analyzer.real_analyzer is None
    status_mode = "Haar Cascade Fallback Mode" if is_fallback else "InsightFace High-Precision Mode"
    return {
        "status": "ANPR and Facial Recognition Backend Running",
        "mode": status_mode
    }

@app.post("/api/scan-plate")
def scan_plate(file: UploadFile = File(...)):
    contents = file.file.read()
    nparr = np.frombuffer(contents, np.uint8)
    frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if frame is None:
        return {"results": []}

    h, w, _ = frame.shape
    detected_plates = []
    seen_texts = set()

    # Step 1: Candidate region localization via OpenCV Morphological ANPR Pipeline
    candidates = locate_license_plate_candidates(frame)
    for cand in candidates:
        crop = cand["crop"]
        bbox = cand["bbox"]
        
        # Scale up candidate crop slightly for OCR enhancement
        scaled_crop = cv2.resize(crop, (180, 60), interpolation=cv2.INTER_CUBIC)
        gray_crop = cv2.cvtColor(scaled_crop, cv2.COLOR_BGR2GRAY)
        
        ocr_results = reader.readtext(gray_crop)
        for (local_bbox, text, prob) in ocr_results:
            cleaned = re.sub(r'[^A-Z0-9]', '', text.upper())
            if len(cleaned) >= 2 and cleaned not in seen_texts:
                seen_texts.add(cleaned)
                detected_plates.append({
                    "text": cleaned,
                    "raw_text": text,
                    "confidence": float(prob),
                    "bbox": bbox
                })

    # Step 2: Single fallback scan on cropped central scanner box (320px) if no candidate crops were found
    if not detected_plates:
        crop_x1, crop_y1 = int(w * 0.15), int(h * 0.15)
        crop_x2, crop_y2 = int(w * 0.85), int(h * 0.85)
        cropped = frame[crop_y1:crop_y2, crop_x1:crop_x2]
        
        if cropped.size > 0:
            resized_scanner = cv2.resize(cropped, (320, 240), interpolation=cv2.INTER_AREA)
            gray_scanner = cv2.cvtColor(resized_scanner, cv2.COLOR_BGR2GRAY)
            results = reader.readtext(gray_scanner)

            for (b, text, prob) in results:
                cleaned = re.sub(r'[^A-Z0-9]', '', text.upper())
                if len(cleaned) >= 2 and cleaned not in seen_texts:
                    seen_texts.add(cleaned)
                    abs_bbox = [int(w * 0.2), int(h * 0.3), int(w * 0.8), int(h * 0.7)]
                    detected_plates.append({
                        "text": cleaned,
                        "raw_text": text,
                        "confidence": float(prob),
                        "bbox": abs_bbox
                    })

    return {"results": detected_plates}

@app.post("/api/scan-face")
def scan_face(
    file: UploadFile = File(...),
    targets: str = Form(...)
):
    """Processes facial recognition on incoming frames against enrolled targets."""
    try:
        contents = file.file.read()
        nparr = np.frombuffer(contents, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if frame is None:
            return {"matches": []}
            
        try:
            target_list = json.loads(targets)
        except Exception:
            target_list = []
            
        valid_targets = []
        for target in target_list:
            emb = get_target_embedding(target)
            if emb is not None:
                valid_targets.append((target.get("name", "Unknown"), emb))
                
        if not valid_targets:
            return {"matches": []}
            
        # Resize query frame to max 480 to optimize scale & speed
        processed_frame, scale = resize_for_face_detection(frame, max_size=480)
            
        faces = face_analyzer.get(processed_frame)
        matches = []
        is_fallback = face_analyzer.real_analyzer is None
        
        for face in faces:
            det_score = getattr(face, 'det_score', 1.0)
            if det_score is not None and det_score < 0.20:
                continue

            embedding = face.embedding
            norm = np.linalg.norm(embedding)
            if norm > 0:
                embedding = embedding / norm

            person_scores = {}
            for name, target_emb in valid_targets:
                similarity = float(np.dot(embedding, target_emb))
                person_scores[name] = max(person_scores.get(name, -1.0), similarity)

            scores = sorted([(name, sim) for name, sim in person_scores.items()], key=lambda x: x[1], reverse=True)

            if scores:
                top_name, top_sim = scores[0]
                threshold = 0.50 if is_fallback else 0.25
                
                margin_valid = True
                if len(scores) > 1 and not is_fallback:
                    second_name, second_sim = scores[1]
                    if second_sim > 0.20 and (top_sim - second_sim) < 0.03:
                        margin_valid = False

                if top_sim >= threshold and margin_valid:
                    # Rescale bounding box to original frame scale
                    raw_bbox = face.bbox.tolist() if hasattr(face.bbox, 'tolist') else list(face.bbox)
                    orig_bbox = [
                        int(raw_bbox[0] / scale),
                        int(raw_bbox[1] / scale),
                        int(raw_bbox[2] / scale),
                        int(raw_bbox[3] / scale)
                    ]
                    
                    matches.append({
                        "name": top_name,
                        "confidence": float(top_sim),
                        "bbox": orig_bbox
                    })

        return {"matches": matches}
    except Exception as e:
        print(f"[Backend Face API] Error: {e}")
        return {"matches": []}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8002)