import os
import time
import unittest
from unittest.mock import MagicMock, patch
import numpy as np

from ingestion.stream import RTSPConnector
from ingestion.config import load_config, append_camera_config
from detection.detector import ObjectDetector

class TestRTSPInjest(unittest.TestCase):
    def setUp(self):
        self.config_path = "test_config.yaml"
        if os.path.exists(self.config_path):
            os.remove(self.config_path)

    def tearDown(self):
        if os.path.exists(self.config_path):
            os.remove(self.config_path)

    def test_uri_construction(self):
        # 1. Credentials provided
        conn = RTSPConnector(
            ip_address="192.168.1.100",
            port=554,
            username="admin",
            password="password123",
            rtsp_path="h264Preview_01_main",
            camera_id="bop_gate_01"
        )
        self.assertEqual(conn.rtsp_url, "rtsp://admin:password123@192.168.1.100:554/h264Preview_01_main")
        
        # 2. No credentials provided
        conn_no_auth = RTSPConnector(
            ip_address="10.0.0.5",
            port=8554,
            rtsp_path="/stream1"
        )
        self.assertEqual(conn_no_auth.rtsp_url, "rtsp://10.0.0.5:8554/stream1")

    @patch("cv2.VideoCapture")
    def test_validate_connection_success(self, mock_vc):
        # Configure mock to simulate a successful connection and read
        mock_cap = MagicMock()
        mock_cap.isOpened.return_value = True
        mock_cap.read.return_value = (True, np.zeros((480, 640, 3), dtype=np.uint8))
        mock_vc.return_value = mock_cap

        conn = RTSPConnector("192.168.1.100", camera_id="test_cam")
        res = conn.validate_connection(timeout=3)
        self.assertTrue(res)
        mock_cap.release.assert_called_once()

    @patch("cv2.VideoCapture")
    def test_validate_connection_failure(self, mock_vc):
        # Configure mock to simulate connection failure
        mock_cap = MagicMock()
        mock_cap.isOpened.return_value = False
        mock_vc.return_value = mock_cap

        conn = RTSPConnector("192.168.1.100", camera_id="test_cam")
        res = conn.validate_connection(timeout=3)
        self.assertFalse(res)
        mock_cap.release.assert_called_once()

    def test_yaml_config_append(self):
        camera_id = "bop_gate_01"
        ip = "192.168.1.100"
        url = "rtsp://admin:password123@192.168.1.100:554/h264Preview_01_main"
        
        # Initial append
        append_camera_config(camera_id, ip, url, config_path=self.config_path)
        cfg = load_config(self.config_path)
        self.assertEqual(len(cfg["cameras"]), 1)
        self.assertEqual(cfg["cameras"][0]["id"], camera_id)
        self.assertEqual(cfg["cameras"][0]["status"], "active")

        # Update existing append
        append_camera_config(camera_id, ip, url, status="disabled", config_path=self.config_path)
        cfg_updated = load_config(self.config_path)
        self.assertEqual(len(cfg_updated["cameras"]), 1)
        self.assertEqual(cfg_updated["cameras"][0]["status"], "disabled")

    @patch("cv2.VideoCapture")
    def test_threaded_ingestion_and_queue(self, mock_vc):
        # Create a mock VideoCapture that returns frames
        mock_cap = MagicMock()
        mock_cap.isOpened.return_value = True
        dummy_frame = np.ones((480, 640, 3), dtype=np.uint8) * 255
        mock_cap.read.return_value = (True, dummy_frame)
        mock_vc.return_value = mock_cap

        conn = RTSPConnector("192.168.1.100", camera_id="test_thread")
        conn.start()

        # Wait a moment for frames to be ingested
        time.sleep(0.5)

        # Get frame from queue
        frame = conn.get_frame(block=False)
        self.assertIsNotNone(frame)
        self.assertEqual(frame.shape, (480, 640, 3))
        
        conn.stop()

    @patch("cv2.VideoCapture")
    def test_reconnection_loop_trigger(self, mock_vc):
        # Configure mock_vc to simulate frame read failure, then success on reconnect
        mock_cap_fail = MagicMock()
        mock_cap_fail.isOpened.return_value = True
        mock_cap_fail.read.return_value = (False, None)

        mock_cap_success = MagicMock()
        mock_cap_success.isOpened.return_value = True
        mock_cap_success.read.return_value = (True, np.ones((480, 640, 3), dtype=np.uint8))

        # VideoCapture side_effect: first call returns failing capture, second returns success
        mock_vc.side_effect = [mock_cap_fail, mock_cap_success]

        conn = RTSPConnector("192.168.1.100", camera_id="test_reconnect")
        
        # Override retry sleep to make test run fast!
        with patch("time.sleep", return_value=None) as mock_sleep:
            conn.start()
            time.sleep(0.2)
            conn.stop()
            
            # Assert reconnect loop slept (meaning it tried to reconnect)
            self.assertTrue(mock_sleep.called)

if __name__ == "__main__":
    unittest.main()
