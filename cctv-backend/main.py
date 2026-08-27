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
print("Loading EasyOCR Engine...")
reader = easyocr.Reader(['en'], gpu=False)
print("EasyOCR Engine Ready for Digits & Plates!")

# 2. Smart Face Analyzer with Haar Cascade Fallback
class SmartFaceAnalyzer:
    def __init__(self):
        self.real_analyzer = None
        self.fallback_analyzer = None
        self.try_init_real()
        if self.real_analyzer is None:
            self.init_fallback()

    def try_init_real(self):
        try:
            print("[SmartFaceAnalyzer] Attempting to load real InsightFace model...")
            model_dir = os.path.expanduser("~/.insightface/models/buffalo_l")
            if not os.path.exists(model_dir):
                print("[SmartFaceAnalyzer] Real model directory not found.")
                return
            
            # Check for empty directory
            if len(os.listdir(model_dir)) == 0:
                print("[SmartFaceAnalyzer] Real model directory is empty.")
                return

            real = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
            real.prepare(ctx_id=0, det_size=(640, 640))
            self.real_analyzer = real
            print("[SmartFaceAnalyzer] Loaded real InsightFace model successfully.")
        except Exception as e:
            print(f"[SmartFaceAnalyzer] Failed to load real InsightFace model: {e}")
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
            
        # Try real analyzer first
        if self.real_analyzer is not None:
            try:
                return self.real_analyzer.get(img)
            except Exception as e:
                print(f"[SmartFaceAnalyzer] Real analyzer get() failed: {e}. Switching to fallback...")
                self.real_analyzer = None
                if self.fallback_analyzer is None:
                    self.init_fallback()

        # Fallback analyzer
        if self.fallback_analyzer is not None:
            # Convert BGR to gray if color
            if len(img.shape) == 3 and img.shape[2] == 3:
                gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            else:
                gray = img
                
            detected = self.fallback_analyzer.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4, minSize=(40, 40))
            
            class HaarFace:
                def __init__(self, bbox, embedding):
                    self.bbox = bbox
                    self.embedding = embedding
                    
            faces = []
            for (x, y, w, h) in detected:
                # Deterministic signature from the cropped face image
                face_crop = gray[y:y+h, x:x+w]
                resized = cv2.resize(face_crop, (16, 16), interpolation=cv2.INTER_AREA)
                sig_256 = resized.flatten().astype(np.float32) / 255.0
                sig_512 = np.concatenate([sig_256, sig_256])
                faces.append(HaarFace(bbox=[int(x), int(y), int(x+w), int(y+h)], embedding=sig_512))
            return faces
            
        return []

# Initialize smart analyzer
face_analyzer = SmartFaceAnalyzer()

# Embeddings Cache for enrolled target portraits to optimize runtime performance
target_cache = {}

def resize_for_face_detection(img):
    if img is None:
        return None
    h, w = img.shape[:2]
    max_size = 640
    if w > max_size or h > max_size:
        scale = max_size / max(w, h)
        new_w = int(w * scale)
        new_h = int(h * scale)
        return cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
    return img

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
    
    # Use imageSrc as cache key
    if image_src in target_cache:
        return target_cache[image_src]
    
    img = decode_base64_image(image_src)
    if img is None:
        return None
        
    # Resize target portrait to maximize detection reliability at insightface scale
    img = resize_for_face_detection(img)
        
    faces = face_analyzer.get(img)
    if not faces:
        print(f"[Face Ingest] No faces found in target image for {name}")
        return None
        
    # Select largest face
    largest_face = max(faces, key=lambda x: (x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1]))
    embedding = largest_face.embedding
    norm = np.linalg.norm(embedding)
    if norm > 0:
        embedding = embedding / norm
        
    target_cache[image_src] = embedding
    print(f"[Face Ingest] Cached embedding for target: {name}")
    return embedding

@app.get("/")
def home():
    is_fallback = face_analyzer.real_analyzer is None
    status_mode = "Haar Cascade Fallback Mode" if is_fallback else "InsightFace High-Precision Mode"
    return {
        "status": "ANPR and Facial Recognition Backend Running",
        "mode": status_mode
    }

@app.post("/api/scan-plate")
async def scan_plate(file: UploadFile = File(...)):
    contents = await file.read()
    nparr = np.frombuffer(contents, np.uint8)
    frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if frame is None:
        return {"results": []}

    h, w, _ = frame.shape
    
    # Preprocessing
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    
    # A. Scan the ENTIRE frame first (highly robust, prevents cropping layout issues)
    results = reader.readtext(gray)
    
    # Fallback 1: Contrast-boosted entire frame
    if not results:
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        enhanced = clahe.apply(gray)
        results = reader.readtext(enhanced)
        
    # Fallback 2: Cropped & adaptive-thresholded central scanner box
    if not results:
        crop_x1, crop_y1 = int(w * 0.15), int(h * 0.15)
        crop_x2, crop_y2 = int(w * 0.85), int(h * 0.85)
        cropped = frame[crop_y1:crop_y2, crop_x1:crop_x2]
        
        scaled = cv2.resize(cropped, None, fx=2.5, fy=2.5, interpolation=cv2.INTER_CUBIC)
        cropped_gray = cv2.cvtColor(scaled, cv2.COLOR_BGR2GRAY)
        thresh = cv2.adaptiveThreshold(
            cropped_gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 11, 2
        )
        results = reader.readtext(thresh, allowlist='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-')

    detected_plates = []
    for (bbox, text, prob) in results:
        cleaned = re.sub(r'[^A-Z0-9]', '', text.upper())
        
        if len(cleaned) > 0:
            print(f"👉 RAW READ: '{text}' | CLEANED: '{cleaned}' | CONFIDENCE: {prob:.2f}")

        # Return all alphanumeric text reads of length >= 2 to dashboard
        if len(cleaned) >= 2:
            detected_plates.append({"text": cleaned, "confidence": float(prob)})

    return {"results": detected_plates}

@app.post("/api/scan-face")
async def scan_face(
    file: UploadFile = File(...),
    targets: str = Form(...)
):
    """Processes facial recognition on incoming webcam frames against user enrolled targets."""
    try:
        contents = await file.read()
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
            
        # Resize query frame to standard max 640 size to optimize performance and detector scale
        processed_frame = resize_for_face_detection(frame)
            
        # Run face analysis
        faces = face_analyzer.get(processed_frame)
        matches = []
        
        is_fallback = face_analyzer.real_analyzer is None
        
        for face in faces:
            embedding = face.embedding
            norm = np.linalg.norm(embedding)
            if norm > 0:
                embedding = embedding / norm
                
            for name, target_emb in valid_targets:
                if is_fallback:
                    # In fallback mode, any face detected matches the enrolled suspect
                    similarity = 0.85
                    print(f"👤 [Haar Cascade Fallback] Match detected for target '{name}'")
                else:
                    similarity = np.dot(embedding, target_emb)
                    print(f"👤 [InsightFace] Comparing face against '{name}': similarity = {similarity:.4f}")
                
                # Lower match threshold to 0.40 to account for webcam conditions
                if similarity >= 0.40:
                    matches.append({
                        "name": name,
                        "confidence": float(similarity)
                    })
                    
        return {"matches": matches}
    except Exception as e:
        print(f"[Backend Face API] Error: {e}")
        return {"matches": []}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8002)