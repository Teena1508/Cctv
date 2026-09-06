import React, { useState, useEffect, useRef } from 'react';
import CameraFeed from './components/CameraFeed';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { CURRENT_NODE_LOCATION } from './config/location';

import {
  Shield, Bell, Radio, MapPin, UserPlus,
  AlertOctagon, RefreshCw, Layers, CheckCircle, Clock, Car, Camera, Trash2
} from 'lucide-react';

// Marker Icons Setup
const cameraIcon = new L.DivIcon({
  className: 'custom-camera-icon',
  html: `<div class="flex items-center justify-center w-8 h-8 rounded-full bg-slate-950 border-2 border-blue-500 shadow-2xl text-blue-400">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
      <circle cx="12" cy="13" r="4"/>
    </svg>
  </div>`,
  iconSize: [32, 32],
  iconAnchor: [16, 16],
  popupAnchor: [0, -16]
});

const userLocationIcon = new L.DivIcon({
  className: 'custom-user-icon',
  html: `<div class="relative flex items-center justify-center w-8 h-8 rounded-full bg-slate-950 border-2 border-cyan-400 shadow-2xl text-cyan-400">
    <span class="absolute w-12 h-12 rounded-full border border-cyan-400/30 animate-ping"></span>
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
      <line x1="8" y1="21" x2="16" y2="21"/>
      <line x1="12" y1="17" x2="12" y2="21"/>
    </svg>
  </div>`,
  iconSize: [32, 32],
  iconAnchor: [16, 16],
  popupAnchor: [0, -16]
});

const alertIcon = new L.DivIcon({
  className: 'custom-alert-icon',
  html: `<div class="relative flex items-center justify-center w-9 h-9 rounded-full bg-slate-950 border-2 border-rose-500 shadow-2xl text-rose-500">
    <span class="absolute w-14 h-14 rounded-full border-2 border-rose-500/50 animate-ping"></span>
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/>
      <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  </div>`,
  iconSize: [36, 36],
  iconAnchor: [18, 18],
  popupAnchor: [0, -18]
});


// Helper function to compress target photos into 256x256 JPEG base64 strings (~20 KB)
function compressTargetPortrait(imageSource, maxDim = 256) {
  return new Promise((resolve) => {
    if (!imageSource) {
      resolve(null);
      return;
    }
    const img = new Image();
    let blobUrl = null;
    if (typeof imageSource === 'string' && (imageSource.startsWith('http://') || imageSource.startsWith('https://'))) {
      img.crossOrigin = 'anonymous';
    }
    img.onload = () => {
      try {
        const offCanvas = document.createElement('canvas');
        offCanvas.width = maxDim;
        offCanvas.height = maxDim;
        const ctx = offCanvas.getContext('2d');
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, maxDim, maxDim);

        const srcW = img.naturalWidth || img.width || maxDim;
        const srcH = img.naturalHeight || img.height || maxDim;

        const cropW = Math.min(srcW, srcH);
        const cropH = cropW;
        const sx = (srcW - cropW) / 2;
        const sy = Math.max(0, (srcH - cropH) / 4);

        ctx.drawImage(img, sx, sy, cropW, cropH, 0, 0, maxDim, maxDim);
        const compressedBase64 = offCanvas.toDataURL('image/jpeg', 0.82);
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        resolve(compressedBase64);
      } catch (e) {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        resolve(typeof imageSource === 'string' ? imageSource : null);
      }
    };
    img.onerror = () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      resolve(typeof imageSource === 'string' ? imageSource : null);
    };
    if (typeof imageSource === 'string') {
      img.src = imageSource;
    } else {
      blobUrl = URL.createObjectURL(imageSource);
      img.src = blobUrl;
    }
  });
}

const isValidLatLng = (lat, lng) => {
  const nLat = Number(lat);
  const nLng = Number(lng);
  return !isNaN(nLat) && !isNaN(nLng) && isFinite(nLat) && isFinite(nLng) && nLat !== 0 && nLng !== 0;
};

// Helper component to center map dynamically & fix tile offset issues
function RecenterMap({ coords }) {
  const map = useMap();
  useEffect(() => {
    if (coords && coords.length === 2 && isValidLatLng(coords[0], coords[1])) {
      try {
        map.invalidateSize();
        map.setView(coords, 14, { animate: true });
      } catch (e) {
        console.warn("RecenterMap exception:", e);
      }
    }
  }, [coords, map]);
  return null;
}

function isTimeInWindow(now = new Date(), startTimeStr = '22:00', endTimeStr = '06:00') {
  if (!startTimeStr || !endTimeStr) return true;
  try {
    const nowMin = now.getHours() * 60 + now.getMinutes();

    const [sH, sM] = startTimeStr.split(':').map(Number);
    const [eH, eM] = endTimeStr.split(':').map(Number);
    const startMin = sH * 60 + sM;
    const endMin = eH * 60 + eM;

    if (startMin === endMin) return true; // All day / 24 hour restriction

    if (startMin < endMin) {
      // Same-day range (e.g. 08:00 to 18:00)
      return nowMin >= startMin && nowMin <= endMin;
    } else {
      // Overnight range (e.g. 22:00 to 06:00)
      return nowMin >= startMin || nowMin <= endMin;
    }
  } catch (e) {
    return true;
  }
}

const CENTRAL_API_BASE = import.meta.env.VITE_CENTRAL_API_URL || 'http://localhost:8000';
const AI_BACKEND_BASE = import.meta.env.VITE_AI_BACKEND_URL || 'http://localhost:8002';
const CENTRAL_API_URL = `${CENTRAL_API_BASE}/api/alerts`;
const CENTRAL_WS_URL = import.meta.env.VITE_CENTRAL_WS_URL || 'ws://localhost:8000/ws/alerts';

const safelyGetArray = (key) => {
  try {
    const saved = localStorage.getItem(key);
    if (!saved) return [];
    const parsed = JSON.parse(saved);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
};

export default function App() {
  const [activeTab, setActiveTab] = useState('FEEDS'); // 'FEEDS' | 'MAP' | 'RULES_WATCHLIST' | 'RECORDINGS'
  const [engineMode, setEngineMode] = useState('CLIENT-SIDE');
  const [alerts, setAlerts] = useState([]);
  const [localAlerts, setLocalAlerts] = useState(() => safelyGetArray('watchlist_alerts'));
  const [connected, setConnected] = useState(false);

  // Persist localAlerts in localStorage
  useEffect(() => {
    try {
      localStorage.setItem('watchlist_alerts', JSON.stringify(localAlerts));
    } catch (e) {
      console.warn("Failed to persist alerts in localStorage:", e);
    }
  }, [localAlerts]);

  // Watchlist & Enrollment states (Face + Plate)
  const [enrollForm, setEnrollForm] = useState({ name: '', targetPlate: '' });
  const [selectedFile, setSelectedFile] = useState(null);
  const [enrollStatus, setEnrollStatus] = useState({ loading: false, success: null, error: null });

  // Restricted Zone & Off-Hours Security Rules state
  const [restrictedRules, setRestrictedRules] = useState(() => {
    const saved = safelyGetArray('restricted_rules');
    if (saved.length > 0) return saved;
    return [
      {
        id: 'RULE_PERIMETER_NIGHT',
        name: 'Night Perimeter & Off-Hours Lock',
        cameraId: 'CAM_01',
        startTime: '22:00',
        endTime: '06:00',
        constraint: 'PERSON_OR_CAR',
        enabled: true
      },
      {
        id: 'RULE_UPTOWN_RESTRICTED',
        name: 'Uptown Restricted Area Watch',
        cameraId: 'CAM_02',
        startTime: '20:00',
        endTime: '07:00',
        constraint: 'PERSON_OR_CAR',
        enabled: true
      }
    ];
  });

  const [ruleForm, setRuleForm] = useState({
    name: '',
    cameraId: 'CAM_01',
    startTime: '22:00',
    endTime: '06:00',
    constraint: 'PERSON_OR_CAR'
  });
  const [ruleStatus, setRuleStatus] = useState({ success: null, error: null });

  useEffect(() => {
    try {
      localStorage.setItem('restricted_rules', JSON.stringify(restrictedRules));
    } catch (e) {
      console.warn("Failed to save restricted rules in localStorage:", e);
    }
  }, [restrictedRules]);

  const restrictedRulesRef = useRef(restrictedRules);
  useEffect(() => {
    restrictedRulesRef.current = restrictedRules;
  }, [restrictedRules]);

  const handleAddRule = (e) => {
    e.preventDefault();
    const designation = ruleForm.name.trim() || `Restricted Security Window (${ruleForm.startTime} - ${ruleForm.endTime})`;
    const startTime = ruleForm.startTime || '22:00';
    const endTime = ruleForm.endTime || '06:00';

    const newRule = {
      id: `RULE_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name: designation,
      cameraId: ruleForm.cameraId || 'ALL_CAMERAS',
      startTime: startTime,
      endTime: endTime,
      constraint: ruleForm.constraint || 'PERSON_OR_CAR',
      enabled: true
    };

    const updated = [...restrictedRules, newRule];
    setRestrictedRules(updated);
    restrictedRulesRef.current = updated;
    try {
      localStorage.setItem('restricted_rules', JSON.stringify(updated));
    } catch (storageErr) {
      console.warn("Storage error saving restricted rules:", storageErr);
    }

    setRuleStatus({ success: `✅ Rule '${newRule.name}' created & activated successfully (${startTime} - ${endTime})!`, error: null });
    setRuleForm({
      name: '',
      cameraId: 'CAM_01',
      startTime: '22:00',
      endTime: '06:00',
      constraint: 'PERSON_OR_CAR'
    });

    setTimeout(() => {
      setRuleStatus({ success: null, error: null });
    }, 4000);
  };

  const handleToggleRule = (ruleId) => {
    const updated = restrictedRules.map(r => r.id === ruleId ? { ...r, enabled: !r.enabled } : r);
    setRestrictedRules(updated);
    restrictedRulesRef.current = updated;
    try {
      localStorage.setItem('restricted_rules', JSON.stringify(updated));
    } catch (err) { }
  };

  const handleDeleteRule = (ruleId) => {
    const updated = restrictedRules.filter(r => r.id !== ruleId);
    setRestrictedRules(updated);
    restrictedRulesRef.current = updated;
    try {
      localStorage.setItem('restricted_rules', JSON.stringify(updated));
    } catch (err) { }
  };

  // Camera stream states
  const [connectedCameras, setConnectedCameras] = useState({});
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalForm, setModalForm] = useState({
    cameraId: '',
    ipAddress: '',
    port: '554',
    rtspPath: '',
    username: '',
    password: '',
    targetSlot: 'Camera Slot 2'
  });
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState(null);
  const [toastMessage, setToastMessage] = useState(null);

  // Dynamic Geolocation state (Tracks current physical laptop location)
  const defaultLat = Number(CURRENT_NODE_LOCATION.lat) || 28.6139;
  const defaultLng = Number(CURRENT_NODE_LOCATION.lng) || 77.2090;

  const [laptopLocation, setLaptopLocation] = useState([defaultLat, defaultLng]);
  const [mapCenter, setMapCenter] = useState([defaultLat, defaultLng]);
  const [locationSource, setLocationSource] = useState('CONFIG'); // 'GPS' | 'IP_GEOLOCATION' | 'CONFIG' | 'DRAGGED'
  const [gpsError, setGpsError] = useState(null);

  // Active watchlists initialized from localStorage safely
  const [enrolledTargets, setEnrolledTargets] = useState(() => {
    const list = safelyGetArray('watchlist_targets');
    return list.filter(t => t && t.imageSrc && !t.imageSrc.startsWith('blob:'));
  });

  const [enrolledPlates, setEnrolledPlates] = useState(() => safelyGetArray('watchlist_plates'));

  const ws = useRef(null);
  const [aiBackendOnline, setAiBackendOnline] = useState(true);
  const [aiBackendLabel, setAiBackendLabel] = useState('ONLINE (PYTHON BACKEND)');

  // Background health check for the AI Scan server on port 8002 (or deployed URL)
  useEffect(() => {
    const checkBackend = async () => {
      try {
        const res = await fetch(`${AI_BACKEND_BASE}/`);
        if (res.ok) {
          setAiBackendOnline(true);
          setAiBackendLabel('ONLINE (PYTHON BACKEND)');
        } else {
          setAiBackendOnline(true);
          setAiBackendLabel('ONLINE (BROWSER AI)');
        }
      } catch (e) {
        // Live deployment fallback to client-side browser AI
        setAiBackendOnline(true);
        setAiBackendLabel('ONLINE (BROWSER AI)');
      }
    };

    checkBackend();
    const interval = setInterval(checkBackend, 5000);
    return () => clearInterval(interval);
  }, []);

  // Update triggerGpsSync in App.jsx to try high accuracy, fallback to low accuracy, and display clear error notifications
  const triggerGpsSync = () => {
    setGpsError(null);
    setLocationSource('ACQUIRING GPS...');

    if (!('geolocation' in navigator)) {
      setLocationSource('STATIC NODE');
      setGpsError("Geolocation is not supported by your browser.");
      return;
    }

    const optionsHigh = { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 };
    const optionsLow = { enableHighAccuracy: false, timeout: 5000, maximumAge: 0 };

    const handleSuccess = (pos) => {
      const userCoords = [pos.coords.latitude, pos.coords.longitude];
      setLaptopLocation(userCoords);
      setMapCenter(userCoords);
      setLocationSource('GPS LOCK');
      setGpsError(null);
    };

    const handleIpFallback = (err) => {
      console.warn("Browser GPS failed, trying IP-based geolocation fallback:", err);

      let errorMsg = "GPS failed. Using IP fallback.";
      if (err.code === 1) {
        errorMsg = "GPS blocked. Please allow location permissions in your browser address bar.";
      } else if (err.code === 2) {
        errorMsg = "GPS unavailable. Check device settings.";
      } else if (err.code === 3) {
        errorMsg = "GPS timed out. Trying IP lookup.";
      }
      setGpsError(errorMsg);

      fetch('http://ip-api.com/json/')
        .then(res => res.json())
        .then(data => {
          if (data.lat && data.lon) {
            const userCoords = [data.lat, data.lon];
            setLaptopLocation(userCoords);
            setMapCenter(userCoords);
            setLocationSource('IP GEOLOCATION');
          } else {
            throw new Error("Invalid IP geo data");
          }
        })
        .catch(ipErr => {
          console.warn("IP Geolocation failed too, falling back to static config:", ipErr);
          setLaptopLocation([CURRENT_NODE_LOCATION.lat, CURRENT_NODE_LOCATION.lng]);
          setMapCenter([CURRENT_NODE_LOCATION.lat, CURRENT_NODE_LOCATION.lng]);
          setLocationSource('STATIC NODE');
        });
    };

    // Try high accuracy first
    navigator.geolocation.getCurrentPosition(
      handleSuccess,
      (errHigh) => {
        if (errHigh.code === 1) {
          // If permission is explicitly denied, don't try low accuracy, go to fallback
          handleIpFallback(errHigh);
        } else {
          console.warn("High accuracy GPS failed/timed out, retrying with low accuracy...", errHigh);
          navigator.geolocation.getCurrentPosition(
            handleSuccess,
            (errLow) => {
              handleIpFallback(errLow);
            },
            optionsLow
          );
        }
      },
      optionsHigh
    );
  };

  // Watch precise live GPS coordinates of device in real-time
  useEffect(() => {
    let watchId = null;
    if ('geolocation' in navigator) {
      // Use low accuracy watchPosition for continuous tracking on laptop to prevent constant timeouts/failures
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const userCoords = [pos.coords.latitude, pos.coords.longitude];
          setLaptopLocation(userCoords);
          setMapCenter(userCoords);
          setLocationSource('GPS LOCK');
          setGpsError(null);
        },
        (err) => {
          console.warn("watchPosition background tracking failed:", err);
        },
        { enableHighAccuracy: false, timeout: 15000, maximumAge: 10000 }
      );
    }

    // Trigger initial precise lookup
    triggerGpsSync();

    return () => {
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
      }
    };
  }, []);

  // CCTV Hardware registry using actual laptop location if fetched
  const cameras = [
    {
      id: 'CAM_01',
      name: 'LOCAL_LAPTOP_NODE',
      lat: laptopLocation ? laptopLocation[0] : CURRENT_NODE_LOCATION.lat,
      lng: laptopLocation ? laptopLocation[1] : CURRENT_NODE_LOCATION.lng,
      address: CURRENT_NODE_LOCATION.address
    },
    {
      id: 'CAM_02',
      name: 'UPTOWN_NODE',
      lat: laptopLocation ? laptopLocation[0] + 0.005 : CURRENT_NODE_LOCATION.lat + 0.005,
      lng: laptopLocation ? laptopLocation[1] + 0.005 : CURRENT_NODE_LOCATION.lng + 0.005,
      address: 'Fixed Node Slot 2'
    }
  ];

  const highlightCameraPin = (camId) => {
    const camera = cameras.find(c => c.id === camId);
    if (camera) {
      setMapCenter([camera.lat, camera.lng]);
    }
  };

  // HANDLER: Continuous Feed with Detection & Off-Hours Restricted Zone Rules Evaluator
  const handleDetection = (detection) => {
    const activeRestrictedRules = restrictedRulesRef.current.filter(r => r.enabled);
    const isUnauthorizedPerson = detection.subject === 'UNAUTHORIZED PERSON' || detection.eventType === 'UNAUTHORIZED PRESENCE';

    // 0. Departure Events: Log clean departure alerts when subjects leave camera frame
    if (detection.eventType === 'SUBJECT DEPARTED') {
      const currentCam = cameras.find(c => c.id === detection.cameraId) || cameras[0];
      const newAlert = {
        id: Date.now() + Math.random().toString(36).substring(2, 7),
        camera_id: currentCam.id,
        event_type: 'SUBJECT DEPARTED',
        severity: 'LOW',
        details: detection.details || `👋 Subject '${detection.subject}' departed camera feed on ${currentCam.id}`,
        subject: `DEPARTED: ${detection.subject}`,
        lat: currentCam.lat,
        lng: currentCam.lng,
        address: currentCam.address,
        timestamp: new Date().toLocaleTimeString()
      };
      setLocalAlerts(prev => [newAlert, ...prev]);
      return;
    }

    // 1. Silent Camera Mode: Allow detection if enrolled targets, enrolled plates, active restricted rules exist, OR if an un-enrolled intruder is detected!
    if (enrolledTargets.length === 0 && enrolledPlates.length === 0 && activeRestrictedRules.length === 0 && !isUnauthorizedPerson) {
      return;
    }

    // 2. High Precision Thresholding: Reject low-confidence or false positive OCR hits
    if (detection.confidence && detection.confidence < 0.15) {
      return;
    }

    // 3. Plate Matching Filter: If detecting a license plate, ensure it matches an enrolled target plate
    if (detection.eventType === 'PLATE MATCH') {
      const matchedPlate = enrolledPlates.find(
        p => p.toLowerCase().trim() === detection.subject?.toLowerCase().trim()
      );
      if (!matchedPlate) return;
    }

    // 4. Restricted Zone & Off-Hours Security Rule Evaluator
    const now = new Date();
    const activeRulesForCam = activeRestrictedRules.filter(r =>
      r.cameraId === 'ALL_CAMERAS' || r.cameraId === detection.cameraId
    );

    let isRestrictedIntrusion = false;
    let matchingRuleName = '';
    let matchingTimeWindow = '';

    for (const rule of activeRulesForCam) {
      if (isTimeInWindow(now, rule.startTime, rule.endTime)) {
        if (rule.constraint === 'PERSON_ONLY' && detection.eventType === 'PLATE MATCH') continue;
        if (rule.constraint === 'VEHICLE_ONLY' && (detection.eventType === 'TARGET MATCH' || isUnauthorizedPerson)) continue;

        isRestrictedIntrusion = true;
        matchingRuleName = rule.name;
        matchingTimeWindow = `${rule.startTime} - ${rule.endTime}`;
        break;
      }
    }

    // 5. Alert Trigger Policy Enforcement:
    // - Enrolled Targets (TARGET MATCH / PLATE MATCH): ALWAYS trigger alerts (every time, 24/7).
    // - Non-Enrolled Persons (UNAUTHORIZED PERSON): Trigger alerts ONLY during active restricted timings!
    if (isUnauthorizedPerson && !isRestrictedIntrusion) {
      return;
    }

    const currentCam = cameras.find(c => c.id === detection.cameraId) || cameras[0];

    const newAlert = {
      id: Date.now() + Math.random().toString(36).substring(2, 7),
      camera_id: currentCam.id,
      event_type: isRestrictedIntrusion && isUnauthorizedPerson
        ? 'RESTRICTED INTRUSION'
        : (isUnauthorizedPerson ? 'UNAUTHORIZED PRESENCE' : (detection.eventType || 'TARGET MATCH')),
      severity: (isRestrictedIntrusion || !isUnauthorizedPerson) ? 'CRITICAL' : 'HIGH',
      details: isRestrictedIntrusion && isUnauthorizedPerson
        ? `🚨 Off-Hours Restricted Intrusion: Rule '${matchingRuleName}' (${matchingTimeWindow}) triggered at ${currentCam.id}`
        : (detection.details || `Spotted on camera feed: ${detection.subject || 'UNAUTHORIZED PERSON'}`),
      subject: isRestrictedIntrusion && isUnauthorizedPerson
        ? `UNAUTHORIZED PRESENCE (${detection.subject || 'SUSPECT'})`
        : (detection.subject || 'UNAUTHORIZED PERSON'),
      lat: currentCam.lat,
      lng: currentCam.lng,
      address: currentCam.address,
      timestamp: new Date().toLocaleTimeString()
    };

    setLocalAlerts(prev => [newAlert, ...prev]);
  };

  useEffect(() => {
    if (engineMode === 'FOG-CLUSTER') {
      fetchHistoricalAlerts();
      connectWebSocket();
    } else {
      if (ws.current) {
        try { ws.current.close(); } catch (e) { }
        ws.current = null;
      }
      setConnected(false);
    }
    return () => {
      if (ws.current) {
        try { ws.current.close(); } catch (e) { }
        ws.current = null;
      }
    };
  }, [engineMode]);

  const fetchHistoricalAlerts = async () => {
    try {
      const res = await fetch(CENTRAL_API_URL);
      if (res.ok) {
        const data = await res.json();
        setAlerts(data);
      }
    } catch (e) {
      console.warn("Historical alerts endpoint unreachable.");
    }
  };

  const connectWebSocket = () => {
    ws.current = new WebSocket(CENTRAL_WS_URL);
    ws.current.onopen = () => setConnected(true);
    ws.current.onclose = () => {
      setConnected(false);
      if (engineMode === 'FOG-CLUSTER') {
        setTimeout(() => { if (engineMode === 'FOG-CLUSTER') connectWebSocket(); }, 5000);
      }
    };
  };

  const handleModalSubmit = async (e) => {
    e.preventDefault();
    if (!modalForm.cameraId || !modalForm.ipAddress) {
      setModalError("Camera ID and IP Address are required.");
      return;
    }

    setModalLoading(true);
    setModalError(null);

    try {
      const res = await fetch("http://localhost:8000/api/v1/connect-camera", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          camera_id: modalForm.cameraId,
          ip_address: modalForm.ipAddress,
          port: parseInt(modalForm.port) || 554,
          rtsp_path: modalForm.rtspPath,
          username: modalForm.username,
          password: modalForm.password,
          target_slot: modalForm.targetSlot
        })
      });

      const data = await res.json();
      if (res.ok) {
        setConnectedCameras(prev => ({
          ...prev,
          [modalForm.targetSlot]: {
            cameraId: modalForm.cameraId,
            ipAddress: modalForm.ipAddress,
            targetSlot: modalForm.targetSlot
          }
        }));
        setIsModalOpen(false);
        setToastMessage("Camera connected & streaming successfully!");
        setTimeout(() => setToastMessage(null), 4000);
        setModalForm({
          cameraId: '',
          ipAddress: '',
          port: '554',
          rtspPath: '',
          username: '',
          password: '',
          targetSlot: 'Camera Slot 2'
        });
      } else {
        setModalError(data.detail || "Failed to ping IP stream.");
      }
    } catch (err) {
      setModalError("Failed to connect to backend server.");
    } finally {
      setModalLoading(false);
    }
  };




  const handleEnrollSubmit = async (e) => {
    e.preventDefault();
    if (!enrollForm.name && !selectedFile && !enrollForm.targetPlate) {
      setEnrollStatus({ loading: false, success: null, error: "Please enter a subject name + photo OR a license plate number." });
      return;
    }

    setEnrollStatus({ loading: true, success: null, error: null });

    try {
      let updatedTargets = [...enrolledTargets];
      let updatedPlates = [...enrolledPlates];

      // Enroll Face Target with compressed Base64 encoding
      if (enrollForm.name && selectedFile) {
        const compressedImage = await compressTargetPortrait(selectedFile, 256);
        if (compressedImage) {
          const targetName = enrollForm.name.trim() || 'TARGET';
          const newTarget = {
            name: targetName,
            imageSrc: compressedImage
          };
          updatedTargets = [...updatedTargets.filter(t => t.name !== targetName), newTarget];
          setEnrolledTargets(updatedTargets);
          try {
            localStorage.setItem('watchlist_targets', JSON.stringify(updatedTargets));
          } catch (storageErr) {
            console.warn("LocalStorage error:", storageErr);
          }
        }
      }

      // Enroll License Plate Target
      if (enrollForm.targetPlate.trim()) {
        const cleanedPlate = enrollForm.targetPlate.trim().toUpperCase();
        if (!updatedPlates.includes(cleanedPlate)) {
          updatedPlates = [...updatedPlates, cleanedPlate];
          setEnrolledPlates(updatedPlates);
          try {
            localStorage.setItem('watchlist_plates', JSON.stringify(updatedPlates));
          } catch (storageErr) {
            console.warn("LocalStorage error:", storageErr);
          }
        }
      }

      setEnrollStatus({
        loading: false,
        success: `Target(s) enrolled & persisted successfully!`,
        error: null
      });

      setEnrollForm({ name: '', targetPlate: '' });
      setSelectedFile(null);
    } catch (err) {
      setEnrollStatus({ loading: false, success: null, error: "Failed to enroll target." });
    }
  };

  const handleSnapWebcamFace = async () => {
    const targetName = enrollForm.name.trim() || 'OPERATOR_SELF';
    setEnrollStatus({ loading: true, success: null, error: null });

    try {
      const videoEl = document.querySelector('video');
      if (!videoEl || videoEl.videoWidth === 0) {
        setEnrollStatus({ loading: false, success: null, error: "Webcam video feed not ready. Ensure camera is active." });
        return;
      }

      const snapCanvas = document.createElement('canvas');
      snapCanvas.width = 300;
      snapCanvas.height = 300;
      const ctx = snapCanvas.getContext('2d');

      const vw = videoEl.videoWidth;
      const vh = videoEl.videoHeight;
      const cropDim = Math.min(vw, vh) * 0.75;
      const sx = (vw - cropDim) / 2;
      const sy = (vh - cropDim) / 3;

      ctx.drawImage(videoEl, sx, sy, cropDim, cropDim, 0, 0, 300, 300);
      const compressedBase64 = snapCanvas.toDataURL('image/jpeg', 0.85);

      const newTarget = {
        name: targetName,
        imageSrc: compressedBase64
      };

      const updatedTargets = [...enrolledTargets.filter(t => t.name !== targetName), newTarget];
      setEnrolledTargets(updatedTargets);
      try {
        localStorage.setItem('watchlist_targets', JSON.stringify(updatedTargets));
      } catch (e) {
        console.warn("LocalStorage error:", e);
      }

      setEnrollStatus({
        loading: false,
        success: `✅ Snap captured! Registered '${targetName}' to Watchlist.`,
        error: null
      });
      setEnrollForm(prev => ({ ...prev, name: '' }));
    } catch (err) {
      setEnrollStatus({ loading: false, success: null, error: "Webcam snapshot failed." });
    }
  };

  const activeAlerts = engineMode === 'CLIENT-SIDE' ? localAlerts : alerts;

  return (
    <div className="bg-slate-950 text-slate-100 min-h-screen font-sans flex flex-col">
      <header className="border-b border-slate-900 bg-slate-900/60 backdrop-blur-md px-6 py-4 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <Shield className="w-8 h-8 text-blue-500" />
          <h1 className="text-xl font-bold tracking-tight bg-gradient-to-r from-slate-100 to-slate-400 bg-clip-text text-transparent">
            SECURE OPERATIONS CENTER (SOC) Hub
          </h1>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex bg-slate-950 p-1 rounded-lg border border-slate-800 gap-1">
            <button
              onClick={() => setEngineMode('CLIENT-SIDE')}
              className={`px-3 py-1 rounded-md text-xs font-bold transition-all ${engineMode === 'CLIENT-SIDE' ? 'bg-blue-600 text-white' : 'text-slate-400'}`}
            >
              CLIENT-SIDE ENGINE
            </button>
            <button
              onClick={() => {
                setEngineMode('FOG-CLUSTER');
                setIsModalOpen(true);
              }}
              className={`px-3 py-1 rounded-md text-xs font-bold transition-all ${engineMode === 'FOG-CLUSTER' ? 'bg-blue-600 text-white' : 'text-slate-400'}`}
            >
              ADD IP CAMERA / FOG
            </button>
          </div>

          <div className={`px-4 py-1.5 rounded-full border text-xs font-semibold flex items-center gap-2 ${aiBackendOnline ? 'bg-emerald-950/30 border-emerald-800/50 text-emerald-400' : 'bg-rose-950/30 border-rose-800/50 text-rose-400'}`}>
            <span className={`w-2.5 h-2.5 rounded-full ${aiBackendOnline ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`}></span>
            AI SERVER: {aiBackendLabel}
          </div>

          <div className="px-4 py-1.5 rounded-full border text-xs font-semibold flex items-center gap-2 bg-cyan-950/30 border-cyan-800/50 text-cyan-400">
            <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-pulse"></span>
            {engineMode === 'CLIENT-SIDE' ? 'CLIENT ENGINE: ACTIVE' : connected ? 'BROKER: ONLINE' : 'BROKER: OFFLINE'}
          </div>
        </div>
      </header>

      {/* Primary SOC Navigation Bar */}
      <nav className="border-b border-slate-900 bg-slate-950/80 px-6 py-2 flex items-center justify-between sticky top-[65px] z-40">
        <div className="flex gap-2 font-mono text-xs font-bold">
          <button
            onClick={() => setActiveTab('FEEDS')}
            className={`px-4 py-2 rounded-lg flex items-center gap-2 transition-all cursor-pointer ${activeTab === 'FEEDS' ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/50' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'}`}
          >
            <Radio className="w-4 h-4" />
            📹 LIVE CAMERAS
          </button>
          <button
            onClick={() => setActiveTab('MAP')}
            className={`px-4 py-2 rounded-lg flex items-center gap-2 transition-all cursor-pointer ${activeTab === 'MAP' ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/50' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'}`}
          >
            <Layers className="w-4 h-4" />
            🗺️ LIVE MAP
          </button>
          <button
            onClick={() => setActiveTab('RULES_WATCHLIST')}
            className={`px-4 py-2 rounded-lg flex items-center gap-2 transition-all cursor-pointer ${activeTab === 'RULES_WATCHLIST' ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/50' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'}`}
          >
            <UserPlus className="w-4 h-4" />
            📋 WATCHLIST & RULES
          </button>
          <button
            onClick={() => setActiveTab('RECORDINGS')}
            className={`px-4 py-2 rounded-lg flex items-center gap-2 transition-all cursor-pointer ${activeTab === 'RECORDINGS' ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/50' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'}`}
          >
            <Bell className="w-4 h-4" />
            🎥 ALERTS & RECORDINGS ({activeAlerts.length})
          </button>
        </div>

        <div className="text-xs font-mono text-slate-500 hidden md:block">
          STATUS: <span className="text-emerald-400 font-bold">OPERATIONAL</span>
        </div>
      </nav>

      {/* Main Container */}
      <div className="flex-1 p-6 overflow-y-auto min-h-[calc(100vh-130px)]">
        {/* TAB 1: LIVE CAMERAS VIEW */}
        {activeTab === 'FEEDS' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 h-full">
            {/* Center Main Feed - Big Fixed Landscape */}
            <div className="lg:col-span-8 flex flex-col gap-4">
              <h2 className="text-sm font-semibold tracking-wider text-slate-400 uppercase flex items-center gap-2">
                <Radio className="w-4 h-4 text-blue-400" />
                Primary Camera Feed
              </h2>
              <div className="bg-slate-950 border border-slate-900 rounded-2xl overflow-hidden p-2 flex flex-col items-center justify-center">
                <CameraFeed
                  cameraId="CAM_01"
                  cameraName="LOCAL_LAPTOP_NODE"
                  latitude={laptopLocation ? laptopLocation[0] : CURRENT_NODE_LOCATION.lat}
                  longitude={laptopLocation ? laptopLocation[1] : CURRENT_NODE_LOCATION.lng}
                  enrolledTargets={enrolledTargets}
                  enrolledPlates={enrolledPlates}
                  onDetection={handleDetection}
                  onLocationClick={() => setActiveTab('MAP')}
                />
              </div>

              {engineMode === 'FOG-CLUSTER' && connectedCameras['Camera Slot 2'] && (
                <div className="bg-slate-950 border border-slate-900 rounded-2xl overflow-hidden p-2 flex flex-col items-center justify-center mt-2">
                  <CameraFeed
                    cameraId={connectedCameras['Camera Slot 2'].cameraId}
                    cameraName="UPTOWN_NODE"
                    latitude={laptopLocation ? laptopLocation[0] + 0.005 : CURRENT_NODE_LOCATION.lat + 0.005}
                    longitude={laptopLocation ? laptopLocation[1] + 0.005 : CURRENT_NODE_LOCATION.lng + 0.005}
                    streamUrl={`http://localhost:8000/video_feed_slot/${encodeURIComponent('Camera Slot 2')}`}
                    enrolledTargets={enrolledTargets}
                    enrolledPlates={enrolledPlates}
                    onDetection={handleDetection}
                    onLocationClick={() => setActiveTab('MAP')}
                  />
                </div>
              )}
            </div>

            {/* Quick Live Alerts Feed */}
            <div className="lg:col-span-4 flex flex-col gap-4">
              <div className="flex items-center justify-between border-b border-slate-900 pb-2">
                <h2 className="text-sm font-semibold tracking-wider text-slate-400 uppercase flex items-center gap-2">
                  <Bell className="w-4 h-4 text-blue-400" />
                  Live Detection Alerts
                </h2>
                <button
                  onClick={() => setActiveTab('RECORDINGS')}
                  className="text-[11px] text-blue-400 hover:text-blue-300 font-bold uppercase tracking-wider cursor-pointer"
                >
                  View All & Recordings →
                </button>
              </div>

              <div className="space-y-3 overflow-y-auto max-h-[75vh] pr-1">
                {activeAlerts.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-48 border border-dashed border-slate-800 rounded-xl text-slate-500 text-sm gap-2">
                    <AlertOctagon className="w-8 h-8 text-slate-600" />
                    No targets matched in active feeds.
                  </div>
                ) : (
                  activeAlerts.slice(0, 6).map((alert) => (
                    <div
                      key={alert.id}
                      className={`p-3.5 rounded-xl border transition-all text-xs space-y-2 hover:bg-slate-900/90 ${alert.severity === 'CRITICAL' ? 'bg-rose-950/20 border-rose-900/50' : 'bg-slate-900/60 border-slate-800/80'}`}
                    >
                      <div className="flex justify-between items-center">
                        <span className="font-mono font-bold tracking-wider flex items-center gap-1.5 text-slate-200">
                          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                          {alert.event_type}
                        </span>
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-950 text-rose-400 border border-rose-800/50">
                          {alert.severity}
                        </span>
                      </div>
                      <div className="text-slate-300 font-semibold text-sm">
                        {alert.subject || alert.details}
                      </div>

                      {/* Video Evidence Clip Preview */}
                      {alert.videoUrl && (
                        <div className="mt-2 rounded-lg overflow-hidden border border-slate-800">
                          <div className="text-[10px] font-mono text-cyan-400 bg-slate-950 px-2 py-1 flex items-center gap-1">
                            🎥 RECORDED EVIDENCE CLIP
                          </div>
                          <video src={alert.videoUrl} controls autoPlay muted loop className="w-full max-h-36 object-cover" />
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: LIVE MAP VIEW */}
        {activeTab === 'MAP' && (
          <div className="flex flex-col gap-4 h-[calc(100vh-160px)]">
            <div className="flex justify-between items-center">
              <h2 className="text-sm font-semibold text-slate-400 uppercase flex items-center gap-2">
                <Layers className="w-4 h-4 text-blue-400" />
                Live Overwatch Tactical GIS Map
              </h2>
              <button
                onClick={triggerGpsSync}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-bold font-mono flex items-center gap-1.5 transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Sync Live Laptop GPS
              </button>
            </div>

            <div className="flex-1 w-full bg-slate-950 rounded-2xl relative border border-slate-800 overflow-hidden min-h-[500px]">
              <MapContainer
                center={mapCenter}
                zoom={14}
                scrollWheelZoom={true}
                className="w-full h-full min-h-[500px] z-0"
              >
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <RecenterMap coords={mapCenter} />

                {laptopLocation && (
                  <Marker
                    position={laptopLocation}
                    icon={userLocationIcon}
                    draggable={true}
                    eventHandlers={{
                      dragend: (e) => {
                        const marker = e.target;
                        const position = marker.getLatLng();
                        const newCoords = [position.lat, position.lng];
                        setLaptopLocation(newCoords);
                        setMapCenter(newCoords);
                        setLocationSource('DRAGGED');
                      }
                    }}
                  >
                    <Popup>
                      <div className="text-xs font-mono text-slate-200">
                        <div className="font-bold text-cyan-400">💻 CURRENT LAPTOP LOCATION</div>
                        <div className="mt-1">GPS: {laptopLocation[0].toFixed(5)}, {laptopLocation[1].toFixed(5)}</div>
                        <div className="text-blue-400 text-[10px] mt-1 font-normal">(Drag to refine location)</div>
                      </div>
                    </Popup>
                  </Marker>
                )}

                {cameras.map((cam) => (
                  <Marker key={cam.id} position={[cam.lat, cam.lng]} icon={cameraIcon}>
                    <Popup>
                      <div className="text-xs font-mono text-slate-200">
                        <div className="font-bold text-blue-400">📹 {cam.id} // {cam.name}</div>
                        <div className="mt-1">📍 {cam.address}</div>
                        <div className="mt-0.5">GPS: {cam.lat.toFixed(5)}, {cam.lng.toFixed(5)}</div>
                      </div>
                    </Popup>
                  </Marker>
                ))}

                {activeAlerts.map((alert, idx) => {
                  if (!alert.lat || !alert.lng) return null;
                  return (
                    <Marker
                      key={alert.id || alert.timestamp || idx}
                      position={[alert.lat, alert.lng]}
                      icon={alertIcon}
                    >
                      <Popup>
                        <div className="text-xs font-mono text-slate-200">
                          <div className="font-bold text-rose-500 uppercase flex items-center gap-1.5 mb-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse"></span>
                            🚨 {alert.event_type || 'ALERT DETECTED'}
                          </div>
                          <div className="text-slate-300"><strong>TARGET:</strong> {alert.subject || 'UNKNOWN'}</div>
                          <div className="text-slate-300"><strong>SEVERITY:</strong> {alert.severity || 'HIGH'}</div>
                          <div className="text-slate-300"><strong>DETAILS:</strong> {alert.details || ''}</div>
                          <div className="text-slate-400 text-[10px] mt-1"><strong>TIME:</strong> {alert.timestamp}</div>
                        </div>
                      </Popup>
                    </Marker>
                  );
                })}
              </MapContainer>

              {/* Map Info Overlay */}
              <div className="absolute top-4 right-4 bg-slate-950/90 border border-slate-800 p-4 rounded-xl z-[1000] w-72 text-xs font-mono backdrop-blur-md shadow-2xl space-y-2">
                <div className="font-bold text-cyan-400 border-b border-slate-800 pb-2 flex items-center justify-between">
                  <span>🛰️ TACTICAL GPS LOCK</span>
                  <span className={`w-2.5 h-2.5 rounded-full ${locationSource === 'GPS LOCK' ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`}></span>
                </div>
                <div className="space-y-1.5 text-slate-300">
                  <div className="flex justify-between">
                    <span>Source:</span>
                    <span className="text-emerald-400 font-bold">{locationSource}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Latitude:</span>
                    <span className="text-white">{laptopLocation ? laptopLocation[0].toFixed(5) : 'N/A'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Longitude:</span>
                    <span className="text-white">{laptopLocation ? laptopLocation[1].toFixed(5) : 'N/A'}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: WATCHLIST & SECURITY RULES VIEW */}
        {activeTab === 'RULES_WATCHLIST' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Watchlist Enrollment Card */}
            <section className="bg-slate-900/40 border border-slate-800 rounded-2xl p-6">
              <h2 className="text-sm font-semibold tracking-wider text-slate-300 uppercase flex items-center gap-2 mb-4">
                <UserPlus className="w-4 h-4 text-blue-400" />
                Watchlist Enrollment (Face Target Photo & ANPR Plate)
              </h2>
              <form onSubmit={handleEnrollSubmit} className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider block">Subject Full Name</label>
                  <input
                    type="text"
                    value={enrollForm.name}
                    onChange={(e) => setEnrollForm(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="Subject Full Name (e.g. John Doe)"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 focus:border-blue-500 outline-none"
                  />
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => setSelectedFile(e.target.files[0])}
                    className="text-xs text-slate-400 block w-full mt-2"
                  />
                </div>

                <div className="border-t border-slate-800/80 my-3"></div>

                <div className="space-y-2">
                  <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                    <Car className="w-3.5 h-3.5 text-amber-400" />
                    Target License Plate (ANPR)
                  </label>
                  <input
                    type="text"
                    value={enrollForm.targetPlate}
                    onChange={(e) => setEnrollForm(prev => ({ ...prev, targetPlate: e.target.value }))}
                    placeholder="e.g. DL01AB1234"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm font-mono text-amber-300 uppercase tracking-widest focus:border-amber-500 outline-none"
                  />
                </div>

                <div className="flex gap-2 pt-2">
                  <button
                    type="submit"
                    className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-bold transition-all"
                  >
                    Enroll Target to Watchlist
                  </button>
                  <button
                    type="button"
                    onClick={handleSnapWebcamFace}
                    className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition-all flex items-center gap-1.5"
                  >
                    <Camera className="w-4 h-4" />
                    Snap Face
                  </button>
                </div>
              </form>

              {enrollStatus.success && (
                <div className="mt-4 text-xs p-3 bg-emerald-950/40 border border-emerald-800/50 text-emerald-400 rounded-lg">
                  {enrollStatus.success}
                </div>
              )}
              {enrollStatus.error && (
                <div className="mt-4 text-xs p-3 bg-rose-950/40 border border-rose-800/50 text-rose-400 rounded-lg">
                  {enrollStatus.error}
                </div>
              )}

              {/* Enrolled Targets Gallery */}
              <div className="mt-6 pt-4 border-t border-slate-800">
                <h3 className="text-xs font-bold text-slate-400 uppercase mb-3">Enrolled Targets ({enrolledTargets.length})</h3>
                <div className="grid grid-cols-3 gap-3">
                  {enrolledTargets.map((target, idx) => (
                    <div key={idx} className="p-2 bg-slate-950 border border-slate-800 rounded-lg flex flex-col items-center gap-1">
                      <img src={target.imageSrc} alt={target.name} className="w-12 h-12 object-cover rounded-full border border-blue-500" />
                      <span className="text-[10px] font-bold text-slate-200 truncate max-w-full">{target.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {/* Restricted Zone Rules Card */}
            <section className="bg-slate-900/40 border border-slate-800 rounded-2xl p-6">
              <h2 className="text-sm font-semibold tracking-wider text-slate-300 uppercase flex items-center gap-2 mb-4">
                <AlertOctagon className="w-4 h-4 text-rose-500" />
                Restricted Zone & Off-Hours Security Rules
              </h2>
              <form onSubmit={handleAddRule} className="space-y-4">
                <div>
                  <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-1">Rule Designation</label>
                  <input
                    type="text"
                    value={ruleForm.name}
                    onChange={(e) => setRuleForm(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="e.g. Off-Hours Perimeter Guard"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:border-rose-500 outline-none"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] font-semibold text-slate-400 uppercase block mb-1">Camera Node</label>
                    <select
                      value={ruleForm.cameraId}
                      onChange={(e) => setRuleForm(prev => ({ ...prev, cameraId: e.target.value }))}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 outline-none"
                    >
                      <option value="CAM_01">CAM_01 (LOCAL_NODE)</option>
                      <option value="CAM_02">CAM_02 (UPTOWN_NODE)</option>
                      <option value="ALL_CAMERAS">ALL SURVEILLANCE NODES</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-semibold text-slate-400 uppercase block mb-1">Constraint</label>
                    <select
                      value={ruleForm.constraint}
                      onChange={(e) => setRuleForm(prev => ({ ...prev, constraint: e.target.value }))}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 outline-none"
                    >
                      <option value="PERSON_OR_CAR">ANY PERSON OR CAR</option>
                      <option value="PERSON_ONLY">PERSON ONLY</option>
                      <option value="VEHICLE_ONLY">VEHICLE ONLY</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] font-semibold text-slate-400 uppercase block mb-1">Start Time</label>
                    <input
                      type="time"
                      value={ruleForm.startTime}
                      onChange={(e) => setRuleForm(prev => ({ ...prev, startTime: e.target.value }))}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-rose-300 font-mono outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-semibold text-slate-400 uppercase block mb-1">End Time</label>
                    <input
                      type="time"
                      value={ruleForm.endTime}
                      onChange={(e) => setRuleForm(prev => ({ ...prev, endTime: e.target.value }))}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-rose-300 font-mono outline-none"
                    />
                  </div>
                </div>

                {/* Preset Shortcuts */}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setRuleForm(prev => ({ ...prev, startTime: '22:00', endTime: '06:00' }))}
                    className="flex-1 py-1 px-2 bg-slate-950 hover:bg-slate-800 border border-slate-800 text-[10px] font-mono text-slate-300 rounded transition-all"
                  >
                    🌙 Night (22:00-06:00)
                  </button>
                  <button
                    type="button"
                    onClick={() => setRuleForm(prev => ({ ...prev, startTime: '00:00', endTime: '00:00' }))}
                    className="flex-1 py-1 px-2 bg-slate-950 hover:bg-slate-800 border border-slate-800 text-[10px] font-mono text-slate-300 rounded transition-all"
                  >
                    🕒 24/7 All-Day
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const now = new Date();
                      const startH = String(now.getHours()).padStart(2, '0');
                      const startM = String(now.getMinutes()).padStart(2, '0');
                      const endH = String((now.getHours() + 4) % 24).padStart(2, '0');
                      setRuleForm(prev => ({ ...prev, startTime: `${startH}:${startM}`, endTime: `${endH}:${startM}` }));
                    }}
                    className="flex-1 py-1 px-2 bg-slate-950 hover:bg-slate-800 border border-slate-800 text-[10px] font-mono text-slate-300 rounded transition-all"
                  >
                    ⚡ Current + 4 Hrs
                  </button>
                </div>

                <button
                  type="submit"
                  className="w-full py-2.5 bg-rose-700 hover:bg-rose-600 text-white rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-2 cursor-pointer shadow-lg active:scale-98"
                >
                  <Clock className="w-4 h-4" />
                  Create Security Intrusion Rule
                </button>
              </form>

              {ruleStatus.success && (
                <div className="mt-3 text-xs p-2.5 bg-emerald-950/60 border border-emerald-800/60 text-emerald-300 rounded-lg flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>{ruleStatus.success}</span>
                </div>
              )}
              {ruleStatus.error && (
                <div className="mt-3 text-xs p-2.5 bg-rose-950/60 border border-rose-800/60 text-rose-300 rounded-lg flex items-center gap-2">
                  <AlertOctagon className="w-4 h-4 text-rose-400 shrink-0" />
                  <span>{ruleStatus.error}</span>
                </div>
              )}

              {/* Active Rules List */}
              <div className="mt-6 pt-4 border-t border-slate-800 space-y-2">
                <div className="text-xs font-bold text-slate-400 uppercase flex justify-between">
                  <span>Active Intrusion Rules</span>
                  <span className="text-rose-400 font-mono">{restrictedRules.filter(r => r.enabled).length} ACTIVE</span>
                </div>
                {restrictedRules.length === 0 ? (
                  <div className="text-[11px] text-slate-500 italic py-2 text-center">
                    No active restricted rules. Detections for non-enrolled persons are currently suppressed.
                  </div>
                ) : (
                  restrictedRules.map((rule) => (
                    <div key={rule.id} className="p-3 bg-slate-950 border border-slate-800 rounded-lg text-xs flex justify-between items-center group">
                      <div>
                        <div className="font-bold text-slate-200">{rule.name}</div>
                        <div className="text-[10px] text-slate-400 font-mono mt-0.5 flex items-center gap-2">
                          <span>📍 {rule.cameraId}</span>
                          <span>⏰ {rule.startTime} - {rule.endTime}</span>
                          <span className="text-slate-500 uppercase">({rule.constraint})</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleToggleRule(rule.id)}
                          className={`px-2 py-1 rounded text-[10px] font-bold cursor-pointer transition-all ${rule.enabled
                              ? 'bg-emerald-950 text-emerald-400 border border-emerald-800 hover:bg-emerald-900'
                              : 'bg-slate-900 text-slate-500 border border-slate-800 hover:bg-slate-800'
                            }`}
                        >
                          {rule.enabled ? 'ENABLED' : 'PAUSED'}
                        </button>
                        <button
                          onClick={() => handleDeleteRule(rule.id)}
                          title="Delete Rule"
                          className="p-1 text-slate-500 hover:text-rose-400 hover:bg-rose-950/40 rounded transition-all cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        )}

        {/* TAB 4: RECORDINGS & ALERTS VIEW */}
        {activeTab === 'RECORDINGS' && (
          <div className="flex flex-col gap-4 max-w-4xl mx-auto">
            <div className="flex items-center justify-between border-b border-slate-900 pb-3">
              <h2 className="text-base font-bold tracking-wider text-slate-200 uppercase flex items-center gap-2">
                <Bell className="w-5 h-5 text-blue-400" />
                Interactive Telemetry & Video Clip Recordings Feed
              </h2>
              {engineMode === 'CLIENT-SIDE' && localAlerts.length > 0 && (
                <button
                  onClick={() => {
                    setLocalAlerts([]);
                    localStorage.removeItem('watchlist_alerts');
                  }}
                  className="text-xs text-rose-400 hover:text-rose-300 font-bold uppercase tracking-wider bg-slate-950 border border-slate-800 px-3 py-1 rounded cursor-pointer"
                >
                  Clear All Alerts
                </button>
              )}
            </div>

            <div className="space-y-4">
              {activeAlerts.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-64 border border-dashed border-slate-800 rounded-2xl text-slate-500 gap-3">
                  <AlertOctagon className="w-10 h-10 text-slate-600" />
                  No detection alerts recorded yet.
                </div>
              ) : (
                activeAlerts.map((alert) => (
                  <div
                    key={alert.id}
                    className={`p-5 rounded-2xl border transition-all space-y-3 ${alert.severity === 'CRITICAL' ? 'bg-rose-950/20 border-rose-900/50' : 'bg-slate-900/60 border-slate-800/80'}`}
                  >
                    <div className="flex justify-between items-center">
                      <span className="font-mono font-bold tracking-wider text-sm flex items-center gap-2 text-slate-200">
                        <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
                        {alert.event_type}
                      </span>
                      <span className="px-3 py-1 rounded text-xs font-bold bg-rose-950 text-rose-400 border border-rose-800/50">
                        {alert.severity}
                      </span>
                    </div>

                    <div className="text-slate-200 font-semibold text-base">
                      {alert.details || `Spotted: ${alert.subject}`}
                    </div>

                    {/* Playable Recorded Video Clip */}
                    {alert.videoUrl && (
                      <div className="mt-3 rounded-xl overflow-hidden border border-slate-800 bg-black">
                        <div className="text-xs font-mono text-cyan-400 bg-slate-950 px-3 py-1.5 font-bold flex items-center gap-2">
                          🎥 RECORDED EVIDENCE VIDEO CLIP
                        </div>
                        <video src={alert.videoUrl} controls autoPlay muted loop className="w-full max-h-72 object-contain" />
                      </div>
                    )}

                    <div className="flex justify-between items-center text-xs text-slate-400 font-mono pt-2 border-t border-slate-800/60">
                      <span>📍 {alert.address} (GPS: {alert.lat ? alert.lat.toFixed(4) : '0.00'}, {alert.lng ? alert.lng.toFixed(4) : '0.00'})</span>
                      <span className="flex items-center gap-1 text-slate-400 font-sans">
                        <Clock className="w-3.5 h-3.5" />
                        {alert.timestamp}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* Add IP CCTV Stream Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md p-6 shadow-2xl relative">
            <h2 className="text-lg font-bold text-slate-100 mb-4 flex items-center gap-2">
              <Radio className="w-5 h-5 text-blue-500 animate-pulse" />
              Add IP CCTV Stream
            </h2>

            {modalError && (
              <div className="mb-4 text-xs p-3 bg-rose-950/30 border border-rose-800/40 text-rose-400 rounded-lg">
                {modalError}
              </div>
            )}

            <form onSubmit={handleModalSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">Camera ID</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. CAM_02"
                    value={modalForm.cameraId}
                    onChange={(e) => setModalForm(prev => ({ ...prev, cameraId: e.target.value }))}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">IP Address</label>
                  <input
                    type="text"
                    required
                    placeholder="192.168.1.100"
                    value={modalForm.ipAddress}
                    onChange={(e) => setModalForm(prev => ({ ...prev, ipAddress: e.target.value }))}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">RTSP Port</label>
                  <input
                    type="number"
                    placeholder="554"
                    value={modalForm.port}
                    onChange={(e) => setModalForm(prev => ({ ...prev, port: e.target.value }))}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">RTSP Path</label>
                  <input
                    type="text"
                    placeholder="/live"
                    value={modalForm.rtspPath}
                    onChange={(e) => setModalForm(prev => ({ ...prev, rtspPath: e.target.value }))}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              <div className="flex gap-3 justify-end pt-4">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 border border-slate-800 rounded-lg text-xs font-bold text-slate-400 hover:bg-slate-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={modalLoading}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-xs font-bold text-white rounded-lg flex items-center gap-2"
                >
                  {modalLoading && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                  Connect & Stream
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 bg-slate-900 border border-emerald-800 text-emerald-400 px-4 py-3 rounded-xl shadow-2xl flex items-center gap-2 z-50">
          <CheckCircle className="w-5 h-5 text-emerald-400" />
          <span className="text-xs font-bold">{toastMessage}</span>
        </div>
      )}
    </div>
  );
}