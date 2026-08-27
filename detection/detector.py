import time
import threading
import logging

logger = logging.getLogger("Detector")

class ObjectDetector:
    def __init__(self, connector):
        self.connector = connector
        self._running = False
        self._thread = None

    def start(self):
        """Starts the downstream detection processing loop."""
        if self._running:
            logger.warning("Detector is already running.")
            return
        
        self._running = True
        self._thread = threading.Thread(target=self._detection_loop, name="Detector-Loop", daemon=True)
        self._thread.start()
        logger.info("Downstream Detector thread started.")

    def stop(self):
        """Stops the detector processing thread."""
        self._running = False
        if self._thread:
            self._thread.join(timeout=3)
            self._thread = None
        logger.info("Downstream Detector thread stopped.")

    def _detection_loop(self):
        while self._running:
            # Attempt to pull a frame from the queue with a timeout
            frame = self.connector.get_frame(block=True, timeout=1.0)
            if frame is not None:
                # Simulate running detection analytics on frame
                logger.info(f"Analytics Processed: Received frame of shape {frame.shape}. (Camera status: {self.connector.status})")
                time.sleep(0.05)  # Simulate small processing time
            else:
                logger.info("No frames currently in queue. Analytics waiting...")
                time.sleep(0.5)
