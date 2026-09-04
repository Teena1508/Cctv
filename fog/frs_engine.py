#!/usr/bin/env python3
import os
import sys
import time
import json
import base64
import shutil
import cv2
import numpy as np
import paho.mqtt.client as mqtt
from pymilvus import MilvusClient, DataType
import insightface
from insightface.app import FaceAnalysis
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

# Environmental Configurations
MQTT_BROKER = os.getenv("MQTT_BROKER", "localhost")
MQTT_PORT = int(os.getenv("MQTT_PORT", 1883))
MQTT_SUB_TOPIC = os.getenv("MQTT_SUB_TOPIC", "surveillance/edge/events")
MQTT_PUB_TOPIC = os.getenv("MQTT_PUB_TOPIC", "surveillance/fog/alerts")

MILVUS_HOST = os.getenv("MILVUS_HOST", "localhost")
MILVUS_PORT = int(os.getenv("MILVUS_PORT", 19530))
COLLECTION_NAME = "watchlist_faces"

# FRS Engine settings
MATCH_THRESHOLD = 0.80

class FRSEngine:
    def __init__(self):
        self.milvus_uri = f"http://{MILVUS_HOST}:{MILVUS_PORT}"
        self.milvus_client = None
        self.face_analyzer = None
        
        self.connect_milvus()
        self.init_insightface()
        self.setup_mqtt()

    def connect_milvus(self):
        print(f"[Milvus] Connecting to database at {self.milvus_uri}...")
        try:
            self.milvus_client = MilvusClient(uri=self.milvus_uri)
            print("[Milvus] Connected successfully.")
            self._init_collection()
        except Exception as e:
            print(f"[Milvus] FATAL: Failed to connect to Milvus: {e}")
            sys.exit(1)

    def _init_collection(self):
        try:
            if self.milvus_client.has_collection(COLLECTION_NAME):
                # Inspect collection schema to see if we need to migrate/recreate it
                try:
                    desc = self.milvus_client.describe_collection(COLLECTION_NAME)
                    fields = desc.get("fields", []) if isinstance(desc, dict) else getattr(desc, "fields", [])
                    has_subject_id = False
                    for field in fields:
                        name_val = field.get("name") if isinstance(field, dict) else getattr(field, "name", None)
                        if name_val == "subject_id":
                            has_subject_id = True
                            break
                    if has_subject_id:
                        print(f"[Milvus] Schema mismatch ('subject_id' field present). Dropping and recreating '{COLLECTION_NAME}'...")
                        self.milvus_client.drop_collection(COLLECTION_NAME)
                    else:
                        print(f"[Milvus] Collection '{COLLECTION_NAME}' already exists with correct schema.")
                        return
                except Exception as ex:
                    print(f"[Milvus] Error describing collection, dropping and recreating: {ex}")
                    try:
                        self.milvus_client.drop_collection(COLLECTION_NAME)
                    except Exception:
                        pass

            print(f"[Milvus] Creating collection '{COLLECTION_NAME}'...")
            schema = self.milvus_client.create_schema(
                auto_id=True,
                enable_dynamic_field=True,
                description="Watchlist Facial Recognition System"
            )
            schema.add_field(field_name="id", datatype=DataType.INT64, is_primary=True)
            schema.add_field(field_name="vector", datatype=DataType.FLOAT_VECTOR, dim=512)
            schema.add_field(field_name="name", datatype=DataType.VARCHAR, max_length=100)

            index_params = self.milvus_client.prepare_index_params()
            index_params.add_index(
                field_name="vector",
                metric_type="COSINE",
                index_type="IVF_FLAT",
                params={"nlist": 128}
            )

            self.milvus_client.create_collection(
                collection_name=COLLECTION_NAME,
                schema=schema,
                index_params=index_params
            )
            print(f"[Milvus] Collection '{COLLECTION_NAME}' initialized successfully.")
        except Exception as e:
            print(f"[Milvus] ERROR initializing collection: {e}")
            raise e

    def init_insightface(self):
        print("[InsightFace] Initializing Buffalo_L analysis app...")
        try:
            model_dir = os.path.expanduser("~/.insightface/models/buffalo_l")
            if not os.path.exists(model_dir):
                raise FileNotFoundError("Buffalo_L model directory not found, using Mock Face Analyzer")
            self.face_analyzer = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
            self.face_analyzer.prepare(ctx_id=0, det_size=(640, 640))
            print("[InsightFace] Model analysis initialized.")
        except Exception as e:
            print(f"[InsightFace] WARNING: Failed to load real InsightFace model ({e}). Using mock face analyzer fallback.")
            class MockFace:
                def __init__(self):
                    self.bbox = [0, 0, 100, 100]
                    self.embedding = np.random.randn(512)

            class MockFaceAnalysis:
                def __init__(self):
                    pass
                def get(self, img):
                    return []
            
            self.face_analyzer = MockFaceAnalysis()

    def enroll_subject(self, name: str, image_path: str):
        print(f"[Ingestion] Registering '{name}' from: {image_path}")
        if not os.path.exists(image_path):
            print(f"[Ingestion] ERROR: File '{image_path}' not found.")
            return False

        img = cv2.imread(image_path)
        if img is None:
            print(f"[Ingestion] ERROR: Failed to parse image at {image_path}")
            return False

        faces = self.face_analyzer.get(img)
        if not faces:
            print(f"[Ingestion] ERROR: No faces detected in image: {image_path}")
            return False

        # Pick largest face
        largest_face = max(faces, key=lambda x: (x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1]))
        embedding = largest_face.embedding
        
        # L2 normalize
        norm = np.linalg.norm(embedding)
        if norm > 0:
            embedding = embedding / norm

        try:
            data = [{
                "vector": embedding.tolist(),
                "name": name
            }]
            res = self.milvus_client.insert(collection_name=COLLECTION_NAME, data=data)
            print(f"[Ingestion] Subject '{name}' enrolled. Milvus response: {res}")
            return True
        except Exception as e:
            print(f"[Ingestion] ERROR: Milvus write failure for '{name}': {e}")
            return False

    def setup_mqtt(self):
        print(f"[MQTT] Preparing client for broker {MQTT_BROKER}:{MQTT_PORT}...")
        self.mqtt_client = mqtt.Client(client_id="frs-engine-fog")
        self.mqtt_client.on_message = self.on_mqtt_message
        
        try:
            self.mqtt_client.connect(MQTT_BROKER, MQTT_PORT, 60)
            self.mqtt_client.subscribe(MQTT_SUB_TOPIC)
            print(f"[MQTT] Connected and subscribed to '{MQTT_SUB_TOPIC}'")
        except Exception as e:
            print(f"[MQTT] ERROR during setup: {e}")

    def on_mqtt_message(self, client, userdata, msg):
        try:
            payload = json.loads(msg.payload.decode('utf-8'))
            camera_id = payload.get("camera_id")
            timestamp = payload.get("timestamp", time.time())
            crop_base64 = payload.get("crop_base64")

            if not crop_base64:
                return

            img_data = base64.b64decode(crop_base64)
            nparr = np.frombuffer(img_data, np.uint8)
            crop_img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

            if crop_img is None or crop_img.size == 0:
                return

            faces = self.face_analyzer.get(crop_img)
            if not faces:
                return

            for face in faces:
                embedding = getattr(face, 'embedding', None)
                if embedding is None:
                    continue

                norm = np.linalg.norm(embedding)
                if norm > 0:
                    embedding = embedding / norm

                search_params = {"metric_type": "COSINE", "params": {"nprobe": 10}}
                search_res = self.milvus_client.search(
                    collection_name=COLLECTION_NAME,
                    data=[embedding.tolist()],
                    limit=1,
                    output_fields=["name"],
                    search_params=search_params
                )

                if search_res and len(search_res[0]) > 0:
                    match = search_res[0][0]
                    similarity = match["distance"]
                    name = match["entity"]["name"]

                    print(f"[Matcher] Match found: '{name}' (Similarity: {similarity:.4f})")

                    if similarity >= MATCH_THRESHOLD:
                        alert_payload = {
                            "camera_id": camera_id,
                            "timestamp": timestamp,
                            "event_type": "WANTED_PERSON_MATCH",
                            "subject_name": name,
                            "confidence": round(float(similarity), 3),
                            "details": f"Wanted suspect '{name}' spotted inside Region of Interest.",
                            "severity": "HIGH_PRIORITY"
                        }
                        
                        self.mqtt_client.publish(MQTT_PUB_TOPIC, json.dumps(alert_payload))
                        print(f"[Matcher] ALERT generated and sent to '{MQTT_PUB_TOPIC}' for match: {name}")

        except Exception as e:
            print(f"[Fog Event] Matcher loop exception: {e}")

# =========================================================================
# FastAPI Fog Ingestion Server Wrapper
# =========================================================================
fastapi_app = FastAPI(title="Fog AI Inference Node", version="1.0.0")

fastapi_app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

engine = None

@fastapi_app.on_event("startup")
def startup():
    global engine
    engine = FRSEngine()
    # Run the MQTT loop asynchronously in the background
    engine.mqtt_client.loop_start()
    print("[Fog Server] FRS Background MQTT Client loop started.")

@fastapi_app.get("/")
def index():
    return {"status": "online", "service": "Fog Inference Engine"}

@fastapi_app.post("/api/watchlist/enroll")
async def enroll_watchlist_api(
    name: str = Form(...),
    file: UploadFile = File(...)
):
    """Multipart form endpoint to enroll missing/wanted subject portraits into Milvus FRS."""
    print(f"[Fog API] Received enrollment request for {name}")
    
    # Save the uploaded file temporarily
    temp_dir = "/tmp/watchlist_uploads"
    os.makedirs(temp_dir, exist_ok=True)
    temp_path = os.path.join(temp_dir, file.filename)
    
    try:
        with open(temp_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        success = engine.enroll_subject(name, temp_path)
        
        if success:
            return {"status": "success", "message": f"Successfully enrolled subject '{name}' into watchlist."}
        else:
            raise HTTPException(status_code=400, detail="No faces detected or Milvus insertion failed.")
            
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Enrollment failed: {str(e)}")
    finally:
        # Clean up temp file
        if os.path.exists(temp_path):
            os.remove(temp_path)

if __name__ == "__main__":
    uvicorn.run(fastapi_app, host="0.0.0.0", port=8001)
