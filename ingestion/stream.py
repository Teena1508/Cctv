import os
import time
import queue
import threading
import logging
import cv2

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger("RTSPConnector")

class RTSPConnector:
    def __init__(self, ip_address, port=554, username="", password="", rtsp_path="", camera_id=""):
        self.ip_address = ip_address
        self.port = port
        self.username = username
        self.password = password
        self.rtsp_path = rtsp_path.lstrip('/')
        self.camera_id = camera_id or f"cam_{ip_address.replace('.', '_')}"
        
        # Build RTSP URI
        if self.username and self.password:
            self.rtsp_url = f"rtsp://{self.username}:{self.password}@{self.ip_address}:{self.port}/{self.rtsp_path}"
        else:
            self.rtsp_url = f"rtsp://{self.ip_address}:{self.port}/{self.rtsp_path}"
            
        self._queue = queue.Queue(maxsize=2)
        self._running = False
        self._thread = None
        self.status = "inactive"

    def validate_connection(self, timeout=5) -> bool:
        """
        Probe the RTSP connection by attempting to open and capture a single frame.
        Gracefully handles connection timeouts and credential errors.
        """
        logger.info(f"[{self.camera_id}] Probing connection to {self.ip_address}:{self.port} (timeout={timeout}s)...")
        
        # Set FFmpeg transport to TCP and set connection timeout (in microseconds)
        original_env = os.environ.get("OPENCV_FFMPEG_CAPTURE_OPTIONS")
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = f"rtsp_transport;tcp|timeout;{timeout * 1000000}"
        
        cap = None
        try:
            cap = cv2.VideoCapture(self.rtsp_url)
            if not cap.isOpened():
                logger.warning(f"[{self.camera_id}] Capture source failed to open during probe.")
                return False
            
            ret, frame = cap.read()
            if ret and frame is not None:
                logger.info(f"[{self.camera_id}] Probe successful. Connection validated.")
                return True
            else:
                logger.warning(f"[{self.camera_id}] Probe failed. Opened but unable to read frame.")
                return False
        except cv2.error as e:
            logger.error(f"[{self.camera_id}] OpenCV Error during probe: {e}")
            return False
        except Exception as e:
            logger.error(f"[{self.camera_id}] Unexpected error during probe: {e}")
            return False
        finally:
            if cap is not None:
                cap.release()
            # Restore environment variable
            if original_env is not None:
                os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = original_env
            else:
                os.environ.pop("OPENCV_FFMPEG_CAPTURE_OPTIONS", None)

    def start(self):
        """Start threaded ingestion."""
        if self._running:
            logger.warning(f"[{self.camera_id}] Ingestion thread is already running.")
            return
        
        self._running = True
        self.status = "active"
        self._thread = threading.Thread(target=self._ingestion_loop, name=f"RTSP-Ingest-{self.camera_id}", daemon=True)
        self._thread.start()
        logger.info(f"[{self.camera_id}] Threaded ingestion started.")

    def stop(self):
        """Stop threaded ingestion and release all resources."""
        self._running = False
        self.status = "inactive"
        if self._thread:
            self._thread.join(timeout=3)
            self._thread = None
        logger.info(f"[{self.camera_id}] Ingestion thread stopped.")

    def _ingestion_loop(self):
        # Enforce TCP transport for downstream OpenCV connection
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"
        
        cap = None
        while self._running:
            if cap is None or not cap.isOpened():
                logger.info(f"[{self.camera_id}] Connecting to stream...")
                cap = cv2.VideoCapture(self.rtsp_url)
                if not cap.isOpened():
                    logger.error(f"[{self.camera_id}] Initial connection failed. Entering reconnection loop.")
                    self.status = "disconnected"
                    cap = self._reconnect_loop(cap)
                    if not self._running:
                        break

            try:
                ret, frame = cap.read()
                if not ret or frame is None:
                    logger.warning(f"[{self.camera_id}] Read returned None frame. Reconnection triggered.")
                    self.status = "disconnected"
                    cap = self._reconnect_loop(cap)
                    continue

                # Push to queue (keep size <= 2 by discarding oldest if full)
                if self._queue.full():
                    try:
                        self._queue.get_nowait()
                    except queue.Empty:
                        pass
                self._queue.put(frame)
                
            except cv2.error as e:
                logger.error(f"[{self.camera_id}] OpenCV error during loop frame read: {e}")
                self.status = "disconnected"
                cap = self._reconnect_loop(cap)
            except Exception as e:
                logger.error(f"[{self.camera_id}] Unexpected error in ingestion loop: {e}")
                self.status = "disconnected"
                cap = self._reconnect_loop(cap)
                time.sleep(1.0)
                
        if cap is not None:
            cap.release()

    def _reconnect_loop(self, cap):
        """Auto-reconnection loop. Retries connection every 3 seconds gracefully."""
        if cap is not None:
            try:
                cap.release()
            except Exception:
                pass
        
        retry_interval = 3
        while self._running:
            logger.info(f"[{self.camera_id}] Reconnecting in {retry_interval} seconds...")
            time.sleep(retry_interval)
            
            try:
                new_cap = cv2.VideoCapture(self.rtsp_url)
                if new_cap.isOpened():
                    # Confirm read success
                    ret, frame = new_cap.read()
                    if ret and frame is not None:
                        logger.info(f"[{self.camera_id}] Reconnected successfully.")
                        self.status = "active"
                        return new_cap
                    else:
                        new_cap.release()
            except cv2.error as e:
                logger.error(f"[{self.camera_id}] Reconnection attempt failed with OpenCV error: {e}")
            except Exception as e:
                logger.error(f"[{self.camera_id}] Reconnection attempt failed: {e}")
                
        return None

    def get_frame(self, block=True, timeout=None):
        """
        Thread-safe extraction of the latest frame from the ingestion queue.
        Returns None if queue is empty.
        """
        try:
            return self._queue.get(block=block, timeout=timeout)
        except queue.Empty:
            return None
