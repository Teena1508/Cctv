import os
import yaml

def load_config(config_path="config.yaml") -> dict:
    """Read config.yaml file if it exists, returning a dictionary."""
    if not os.path.exists(config_path):
        return {"cameras": []}
    
    with open(config_path, "r") as f:
        try:
            config = yaml.safe_load(f)
            if not config or "cameras" not in config:
                return {"cameras": []}
            return config
        except Exception:
            return {"cameras": []}

def save_config(config: dict, config_path="config.yaml"):
    """Write config dictionary to config.yaml."""
    with open(config_path, "w") as f:
        yaml.safe_dump(config, f, default_flow_style=False, sort_keys=False)

def append_camera_config(camera_id, ip_address, rtsp_url, status="active", config_path="config.yaml"):
    """
    Appends or updates a camera configuration inside config.yaml.
    Guarantees no duplicate ID collisions.
    """
    config = load_config(config_path)
    if "cameras" not in config or config["cameras"] is None:
        config["cameras"] = []

    # Check for existing camera with same ID to update it
    existing_idx = None
    for idx, cam in enumerate(config["cameras"]):
        if cam.get("id") == camera_id:
            existing_idx = idx
            break

    cam_entry = {
        "id": camera_id,
        "ip": ip_address,
        "rtsp_url": rtsp_url,
        "status": status
    }

    if existing_idx is not None:
        config["cameras"][existing_idx] = cam_entry
    else:
        config["cameras"].append(cam_entry)

    save_config(config, config_path)
