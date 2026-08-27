import os
from pymilvus import MilvusClient, DataType

class FaceSearcher:
    def __init__(self, host="localhost", port=19530, collection_name="watchlist_faces"):
        self.uri = f"http://{host}:{port}"
        self.collection_name = collection_name
        self.client = None
        self.connect()

    def connect(self):
        try:
            self.client = MilvusClient(uri=self.uri)
            print(f"[Fog Milvus] Connected to Milvus standalone at {self.uri}")
            self._init_collection()
        except Exception as e:
            print(f"[Fog Milvus] ERROR: Failed to connect to Milvus: {e}")

    def _init_collection(self):
        if not self.client:
            return
        
        try:
            # Check if collection exists
            if self.client.has_collection(self.collection_name):
                print(f"[Fog Milvus] Collection '{self.collection_name}' already exists.")
                return

            print(f"[Fog Milvus] Creating collection '{self.collection_name}'...")
            # Prepare Schema
            schema = self.client.create_schema(
                auto_id=True,
                enable_dynamic_field=True,
                description="Facial Recognition Vector Database"
            )
            # Add primary key field
            schema.add_field(field_name="id", datatype=DataType.INT64, is_primary=True)
            # Add vector field (512 dimensions for InsightFace ArcFace models)
            schema.add_field(field_name="vector", datatype=DataType.FLOAT_VECTOR, dim=512)
            # Add identity metadata field
            schema.add_field(field_name="name", datatype=DataType.VARCHAR, max_length=100)
            
            # Index configuration
            index_params = self.client.prepare_index_params()
            index_params.add_index(
                field_name="vector",
                metric_type="COSINE",
                index_type="IVF_FLAT",
                params={"nlist": 128}
            )

            self.client.create_collection(
                collection_name=self.collection_name,
                schema=schema,
                index_params=index_params
            )
            print(f"[Fog Milvus] Collection '{self.collection_name}' initialized successfully.")
        except Exception as e:
            print(f"[Fog Milvus] ERROR: Collection initialization failed: {e}")

    def register_face(self, name, vector):
        """Registers a face vector into the Milvus vector database."""
        if not self.client:
            print("[Fog Milvus] Client not connected.")
            return None
        
        try:
            data = [{"vector": vector, "name": name}]
            res = self.client.insert(collection_name=self.collection_name, data=data)
            print(f"[Fog Milvus] Registered identity '{name}' successfully.")
            return res
        except Exception as e:
            print(f"[Fog Milvus] ERROR: Failed to register face: {e}")
            return None

    def search_face(self, vector, threshold=0.6):
        """Searches for a matching face vector above threshold similarity."""
        if not self.client:
            print("[Fog Milvus] Client not connected.")
            return None

        try:
            search_params = {"metric_type": "COSINE", "params": {"nprobe": 10}}
            res = self.client.search(
                collection_name=self.collection_name,
                data=[vector],
                limit=1,
                output_fields=["name"],
                search_params=search_params
            )
            
            if res and len(res[0]) > 0:
                match = res[0][0]
                similarity = match["distance"]  # Cosine similarity range [-1, 1]
                if similarity >= threshold:
                    return {
                        "name": match["entity"]["name"],
                        "confidence": similarity,
                        "match": True
                    }
            return {"name": "Unknown", "confidence": 0.0, "match": False}
        except Exception as e:
            print(f"[Fog Milvus] ERROR: Vector search failed: {e}")
            return {"name": "Unknown", "confidence": 0.0, "match": False}
