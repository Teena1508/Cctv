import os
import sys
import unittest
from unittest.mock import MagicMock, patch
import numpy as np

# Set PYTHONPATH
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT_DIR not in sys.path:
    sys.path.append(ROOT_DIR)
sys.path.append(os.path.join(ROOT_DIR, "central"))

from fastapi.testclient import TestClient
from central.main import app

class TestConnectEndpoint(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.config_path = os.path.join(ROOT_DIR, "config.yaml")
        self.cameras_path = os.path.join(ROOT_DIR, "cameras.yaml")
        
        # Cleanup files if they exist to keep test pristine
        for path in [self.config_path, self.cameras_path]:
            if os.path.exists(path):
                os.remove(path)

    def tearDown(self):
        for path in [self.config_path, self.cameras_path]:
            if os.path.exists(path):
                os.remove(path)

    @patch("ingestion.stream.RTSPConnector.validate_connection")
    @patch("ingestion.stream.RTSPConnector.start")
    def test_connect_camera_endpoint_success(self, mock_start, mock_validate):
        # Configure mock validation to succeed
        mock_validate.return_value = True
        
        req_payload = {
            "camera_id": "CAM_TEST_PORT",
            "ip_address": "192.168.1.105",
            "port": 554,
            "rtsp_path": "h264_stream",
            "username": "admin",
            "password": "passwords",
            "target_slot": "Camera Slot 2"
        }
        
        res = self.client.post("/api/v1/connect-camera", json=req_payload)
        
        self.assertEqual(res.status_code, 200)
        json_data = res.json()
        self.assertEqual(json_data["status"], "success")
        self.assertEqual(json_data["camera_id"], "CAM_TEST_PORT")
        
        # Assert background reader started
        mock_start.assert_called_once()
        
        # Assert config and cameras YAML files were updated
        self.assertTrue(os.path.exists(self.config_path))
        self.assertTrue(os.path.exists(self.cameras_path))

    @patch("ingestion.stream.RTSPConnector.validate_connection")
    def test_connect_camera_endpoint_failure(self, mock_validate):
        # Configure mock validation to fail (e.g. timeout or bad credentials)
        mock_validate.return_value = False
        
        req_payload = {
            "camera_id": "CAM_TEST_FAIL",
            "ip_address": "192.168.1.99",
            "port": 554,
            "target_slot": "Camera Slot 2"
        }
        
        res = self.client.post("/api/v1/connect-camera", json=req_payload)
        
        self.assertEqual(res.status_code, 400)
        json_data = res.json()
        self.assertIn("Failed to ping IP stream", json_data["detail"])


if __name__ == "__main__":
    unittest.main()
