import React, { useState, useEffect, useRef } from 'react';
import CameraFeed from './components/CameraFeed';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { CURRENT_NODE_LOCATION } from './config/location';

import {
  Shield, Bell, Radio, MapPin, UserPlus,
  AlertOctagon, RefreshCw, Layers, CheckCircle, Clock, Car
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


// Helper component to center map dynamically & fix tile offset issues
function RecenterMap({ coords }) {
  const map = useMap();
  useEffect(() => {
    if (coords && coords.length === 2 && coords[0] !== 0) {
      // Force Leaflet to recalculate map dimensions and center properly
      map.invalidateSize();
      map.setView(coords, 14, { animate: true });
    }
  }, [coords, map]);
  return null;
}

const CENTRAL_API_URL = 'http://localhost:8000/api/alerts';
const CENTRAL_WS_URL = 'ws://localhost:8000/ws/alerts';

export default function App() {
  const [engineMode, setEngineMode] = useState('CLIENT-SIDE');
  const [alerts, setAlerts] = useState([]);
  const [localAlerts, setLocalAlerts] = useState(() => {
    try {
      const saved = localStorage.getItem('watchlist_alerts');
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      return [];
    }
  });
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
  const [laptopLocation, setLaptopLocation] = useState([CURRENT_NODE_LOCATION.lat, CURRENT_NODE_LOCATION.lng]);
  const [mapCenter, setMapCenter] = useState([CURRENT_NODE_LOCATION.lat, CURRENT_NODE_LOCATION.lng]);
  const [locationSource, setLocationSource] = useState('CONFIG'); // 'GPS' | 'IP_GEOLOCATION' | 'CONFIG' | 'DRAGGED'
  const [gpsError, setGpsError] = useState(null);

  // Active watchlists initialized from localStorage
  const [enrolledTargets, setEnrolledTargets] = useState(() => {
    try {
      const saved = localStorage.getItem('watchlist_targets');
      if (!saved) return [];
      const parsed = JSON.parse(saved);
      // Clean up stale blob URLs from previous code version to prevent backend failure on reload
      const valid = parsed.filter(t => t && t.imageSrc && !t.imageSrc.startsWith('blob:'));
      if (valid.length !== parsed.length) {
        localStorage.setItem('watchlist_targets', JSON.stringify(valid));
      }
      return valid;
    } catch (e) {
      return [];
    }
  });

  const [enrolledPlates, setEnrolledPlates] = useState(() => {
    try {
      const saved = localStorage.getItem('watchlist_plates');
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      return [];
    }
  });

  const ws = useRef(null);
  const [aiBackendOnline, setAiBackendOnline] = useState(false);

  // Background health check for the AI Scan server on port 8002
  useEffect(() => {
    const checkBackend = async () => {
      try {
        const res = await fetch('http://localhost:8002/');
        if (res.ok) {
          setAiBackendOnline(true);
        } else {
          setAiBackendOnline(false);
        }
      } catch (e) {
        setAiBackendOnline(false);
      }
    };
    
    checkBackend();
    const interval = setInterval(checkBackend, 5000);
    return () => clearInterval(interval);
  }, []);

  // 1. Update triggerGpsSync in App.jsx to gracefully fallback instead of erroring
  const triggerGpsSync = () => {
    setGpsError(null);
    setLocationSource('ACQUIRING GPS...');
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const userCoords = [pos.coords.latitude, pos.coords.longitude];
          setLaptopLocation(userCoords);
          setMapCenter(userCoords);
          setLocationSource('GPS LOCK');
          setGpsError(null);
        },
        (err) => {
          console.warn("Browser GPS failed, trying IP-based geolocation fallback:", err);
          fetch('https://ipapi.co/json/')
            .then(res => res.json())
            .then(data => {
              if (data.latitude && data.longitude) {
                const userCoords = [data.latitude, data.longitude];
                setLaptopLocation(userCoords);
                setMapCenter(userCoords);
                setLocationSource('IP GEOLOCATION');
                setGpsError(null);
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
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
      );
    } else {
      setLocationSource('STATIC NODE');
    }
  };

  // Watch precise live GPS coordinates of device in real-time
  useEffect(() => {
    let watchId = null;
    if ('geolocation' in navigator) {
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
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
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

  // HANDLER: Continuous Feed with Strict Detection Filters
  const handleDetection = (detection) => {
    // 1. Silent Camera Mode: Block detection alerts if neither a face photo nor a plate is actively enrolled
    if (enrolledTargets.length === 0 && enrolledPlates.length === 0) {
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

    const currentCam = cameras.find(c => c.id === detection.cameraId) || cameras[0];

    const newAlert = {
      id: Date.now() + Math.random().toString(36).substring(2, 7),
      camera_id: currentCam.id,
      event_type: detection.eventType || (enrolledTargets.length > 0 ? 'TARGET MATCH' : 'PLATE MATCH'),
      severity: detection.severity || 'CRITICAL',
      details: detection.details || `Matched Target: ${enrolledTargets[enrolledTargets.length - 1]?.name || enrolledPlates[enrolledPlates.length - 1]}`,
      subject: detection.subject || enrolledTargets[enrolledTargets.length - 1]?.name || 'UNKNOWN VEHICLE',
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

  const handleEnrollSubmit = (e) => {
    e.preventDefault();
    if (!enrollForm.name && !selectedFile && !enrollForm.targetPlate) {
      setEnrollStatus({ loading: false, success: null, error: "Please enter a subject name + photo OR a license plate number." });
      return;
    }

    setEnrollStatus({ loading: true, success: null, error: null });

    // Enroll Face Target with Base64 encoding
    if (enrollForm.name && selectedFile) {
      const reader = new FileReader();
      reader.onloadend = () => {
        const newTarget = {
          name: enrollForm.name,
          imageSrc: reader.result // Base64 data string accessible across components
        };
        const updatedTargets = [...enrolledTargets, newTarget];
        setEnrolledTargets(updatedTargets);
        localStorage.setItem('watchlist_targets', JSON.stringify(updatedTargets));
      };
      reader.readAsDataURL(selectedFile);
    }

    // Enroll License Plate Target
    if (enrollForm.targetPlate.trim()) {
      const cleanedPlate = enrollForm.targetPlate.trim().toUpperCase();
      const updatedPlates = [...enrolledPlates, cleanedPlate];
      setEnrolledPlates(updatedPlates);
      localStorage.setItem('watchlist_plates', JSON.stringify(updatedPlates));
    }

    setEnrollStatus({
      loading: false,
      success: `Target(s) enrolled successfully!`,
      error: null
    });

    setEnrollForm({ name: '', targetPlate: '' });
    setSelectedFile(null);
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
            AI SERVER: {aiBackendOnline ? 'ONLINE' : 'OFFLINE'}
          </div>

          <div className="px-4 py-1.5 rounded-full border text-xs font-semibold flex items-center gap-2 bg-cyan-950/30 border-cyan-800/50 text-cyan-400">
            <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-pulse"></span>
            {engineMode === 'CLIENT-SIDE' ? 'CLIENT ENGINE: ACTIVE' : connected ? 'BROKER: ONLINE' : 'BROKER: OFFLINE'}
          </div>
        </div>
      </header>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-6 p-6 h-[calc(100vh-80px)] overflow-hidden">
        {/* Left Panel */}
        <div className="lg:col-span-4 flex flex-col gap-6 overflow-y-auto pr-2">
          {/* Combined Watchlist Enrollment */}
          <section className="bg-slate-900/30 border border-slate-900 rounded-xl p-5">
            <h2 className="text-sm font-semibold tracking-wider text-slate-400 uppercase flex items-center gap-2 mb-4">
              <UserPlus className="w-4 h-4 text-blue-400" />
              Watchlist Enrollment (Face & ANPR)
            </h2>
            <form onSubmit={handleEnrollSubmit} className="space-y-4">
              {/* Face Target Inputs */}
              <div className="space-y-2">
                <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">Target Facial Recognition</label>
                <input
                  type="text"
                  value={enrollForm.name}
                  onChange={(e) => setEnrollForm(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="Subject Full Name"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 focus:border-blue-500 outline-none"
                />
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => setSelectedFile(e.target.files[0])}
                  className="text-xs text-slate-400 block w-full"
                />
              </div>

              <div className="border-t border-slate-800/80 my-2"></div>

              {/* Number Plate Target Input */}
              <div className="space-y-2">
                <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                  <Car className="w-3.5 h-3.5 text-amber-400" />
                  Target License Plate (ANPR)
                </label>
                <input
                  type="text"
                  value={enrollForm.targetPlate}
                  onChange={(e) => setEnrollForm(prev => ({ ...prev, targetPlate: e.target.value }))}
                  placeholder="e.g. 7XYZ123 or DL01AB1234"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm font-mono text-amber-300 uppercase tracking-widest focus:border-amber-500 outline-none placeholder:font-sans placeholder:tracking-normal placeholder:text-slate-600"
                />
              </div>

              <button
                type="submit"
                className="w-full py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-semibold transition-all mt-2"
              >
                Enroll Target to Watchlist
              </button>
            </form>

            <div className="mt-4 pt-3 border-t border-slate-800 flex justify-between text-xs text-slate-400 font-mono">
              <div>Enrolled Faces: <span className="text-cyan-400 font-bold">{enrolledTargets.length}</span></div>
              <div>Target Plates: <span className="text-amber-400 font-bold">{enrolledPlates.length}</span></div>
            </div>

            {enrollStatus.success && (
              <div className="mt-3 text-xs p-2 bg-emerald-950/20 border border-emerald-800/30 text-emerald-400 rounded-lg">
                {enrollStatus.success}
              </div>
            )}
            {enrollStatus.error && (
              <div className="mt-3 text-xs p-2 bg-rose-950/20 border border-rose-800/30 text-rose-400 rounded-lg">
                {enrollStatus.error}
              </div>
            )}
          </section>

          {/* Leaflet Spatio-Temporal Map */}
          <section className="bg-slate-900/30 border border-slate-900 rounded-xl p-5 flex-1 min-h-[280px] flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-slate-400 uppercase flex items-center gap-2">
              <Layers className="w-4 h-4 text-blue-400" />
              Spatio-Temporal GIS Map
            </h2>
            <div className="flex-1 w-full bg-slate-950 rounded-lg relative border border-slate-800 overflow-hidden min-h-[200px]">
              <MapContainer
                center={mapCenter}
                zoom={14}
                scrollWheelZoom={true}
                className="w-full h-full min-h-[200px] z-0"
              >
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/">OpenStreetMap</a>'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <RecenterMap coords={mapCenter} />

                {/* Plot Real Laptop GPS location if acquired (draggable to refine) */}
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
                      <div className="text-xs font-mono font-bold text-slate-800">
                        💻 YOUR CURRENT LAPTOP LOCATION<br />
                        GPS: {laptopLocation[0].toFixed(5)}, {laptopLocation[1].toFixed(5)}<br />
                        <span className="text-blue-500 font-normal">(Drag to refine location)</span>
                      </div>
                    </Popup>
                  </Marker>
                )}

                {/* Plot installed CCTV hardware pins */}
                {cameras.map((cam) => (
                  <Marker key={cam.id} position={[cam.lat, cam.lng]} icon={cameraIcon}>
                    <Popup>
                      <div className="text-xs font-mono font-bold text-slate-800">
                        📹 {cam.id} // {cam.name}<br />
                        📍 {cam.address}<br />
                        GPS: {cam.lat.toFixed(5)}, {cam.lng.toFixed(5)}
                      </div>
                    </Popup>
                  </Marker>
                ))}
              </MapContainer>

              {/* Map Info Overlay Card */}
              <div className="absolute top-3 right-3 bg-slate-950/90 border border-slate-800 p-3 rounded-lg z-[1000] w-64 text-xs font-mono backdrop-blur-md shadow-2xl">
                <div className="font-bold text-cyan-400 border-b border-slate-800 pb-1.5 mb-1.5 flex items-center justify-between">
                  <span>🛰️ TACTICAL GPS</span>
                  <span className={`w-2 h-2 rounded-full ${locationSource === 'GPS LOCK' ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`}></span>
                </div>
                <div className="space-y-1 text-slate-300">
                  <div className="flex justify-between">
                    <span>Status:</span>
                    <span className={`font-bold ${locationSource === 'GPS LOCK' ? 'text-emerald-400' : 'text-amber-400'}`}>
                      {locationSource}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Latitude:</span>
                    <span className="text-white">{laptopLocation ? laptopLocation[0].toFixed(5) : 'N/A'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Longitude:</span>
                    <span className="text-white">{laptopLocation ? laptopLocation[1].toFixed(5) : 'N/A'}</span>
                  </div>
                  {gpsError && (
                    <div className="text-rose-400 text-[10px] mt-1.5 border-t border-slate-800/50 pt-1.5 whitespace-normal break-words leading-relaxed">
                      ⚠️ {gpsError}
                    </div>
                  )}
                </div>
                <button
                  onClick={triggerGpsSync}
                  className="mt-2.5 w-full bg-blue-600 hover:bg-blue-500 text-white font-sans py-1.5 px-2 rounded font-bold text-[10px] uppercase tracking-wider transition-colors flex items-center justify-center gap-1.5"
                >
                  <RefreshCw className="w-3.5 h-3.5 animate-spin-slow" />
                  Sync Live GPS
                </button>
              </div>
            </div>
          </section>
        </div>

        {/* Center Panel (Continuous Feeds) */}
        <div className="lg:col-span-4 flex flex-col gap-6 overflow-hidden">
          <h2 className="text-sm font-semibold tracking-wider text-slate-400 uppercase flex items-center gap-2">
            <Radio className="w-4 h-4 text-blue-400" />
            Live Camera Feeds (Continuous)
          </h2>
          <div className="grid grid-rows-2 gap-4 flex-1 overflow-y-auto pr-2">
            {/* Camera Feed 1 runs webcam continuously */}
            <div className="bg-black border border-slate-900 rounded-xl overflow-hidden relative min-h-[220px]">
              <CameraFeed
                cameraId="CAM_01"
                cameraName="LOCAL_LAPTOP_NODE"
                latitude={laptopLocation ? laptopLocation[0] : CURRENT_NODE_LOCATION.lat}
                longitude={laptopLocation ? laptopLocation[1] : CURRENT_NODE_LOCATION.lng}
                enrolledTargets={enrolledTargets}
                enrolledPlates={enrolledPlates}
                onDetection={handleDetection}
                onLocationClick={highlightCameraPin}
              />
            </div>

            <div className="bg-black border border-slate-900 rounded-xl overflow-hidden relative flex items-center justify-center min-h-[220px] group">
              {engineMode === 'FOG-CLUSTER' && connectedCameras['Camera Slot 2'] ? (
                <CameraFeed
                  cameraId={connectedCameras['Camera Slot 2'].cameraId}
                  cameraName="UPTOWN_NODE"
                  latitude={laptopLocation ? laptopLocation[0] + 0.005 : CURRENT_NODE_LOCATION.lat + 0.005}
                  longitude={laptopLocation ? laptopLocation[1] + 0.005 : CURRENT_NODE_LOCATION.lng + 0.005}
                  streamUrl={`http://localhost:8000/video_feed_slot/${encodeURIComponent('Camera Slot 2')}`}
                  enrolledTargets={enrolledTargets}
                  enrolledPlates={enrolledPlates}
                  onDetection={handleDetection}
                  onLocationClick={highlightCameraPin}
                />
              ) : (
                <span className="text-xs text-slate-500 uppercase">Camera 02 // STANDBY</span>
              )}
            </div>
          </div>
        </div>

        {/* Right Panel (Alerts Feed) */}
        <div className="lg:col-span-4 flex flex-col gap-4 overflow-hidden h-full">
          <div className="flex items-center justify-between border-b border-slate-900 pb-2">
            <h2 className="text-sm font-semibold tracking-wider text-slate-400 uppercase flex items-center gap-2">
              <Bell className="w-4 h-4 text-blue-400" />
              Interactive Alerts Feed
            </h2>
            <div className="flex items-center gap-2">
              {engineMode === 'CLIENT-SIDE' && localAlerts.length > 0 && (
                <button
                  onClick={() => {
                    setLocalAlerts([]);
                    localStorage.removeItem('watchlist_alerts');
                  }}
                  className="text-[10px] text-rose-400 hover:text-rose-300 font-bold uppercase tracking-wider transition-colors bg-slate-950 border border-slate-800 px-2 py-0.5 rounded cursor-pointer"
                >
                  Clear
                </button>
              )}
              <span className="text-[10px] text-slate-500 bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
                {activeAlerts.length} Records
              </span>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto space-y-4 pr-2 pb-6">
            {activeAlerts.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 border border-dashed border-slate-800 rounded-xl text-slate-500 text-sm gap-2">
                <AlertOctagon className="w-8 h-8 text-slate-600" />
                No targets matched in active feeds.
              </div>
            ) : (
              activeAlerts.map((alert) => (
                <div
                  key={alert.id}
                  className={`p-3.5 rounded-xl border transition-all text-xs space-y-2 hover:bg-slate-900/90 ${alert.severity === 'CRITICAL' ? 'bg-rose-950/20 border-rose-900/50 hover:border-rose-700/60' :
                    'bg-slate-900/60 border-slate-800/80 hover:border-slate-700/60'
                    }`}
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
                    {alert.event_type === 'PLATE MATCH' ? 'Plate Flagged: ' : 'Subject Matched: '}
                    <span className={alert.event_type === 'PLATE MATCH' ? 'text-amber-400 font-mono font-bold' : 'text-emerald-400'}>
                      {alert.subject || alert.details}
                    </span>
                  </div>

                  <div className="flex flex-col gap-1 text-[10px] text-slate-400 font-mono">
                    <button
                      onClick={() => highlightCameraPin(alert.camera_id)}
                      className="flex items-center gap-1.5 hover:text-blue-400 text-left transition-colors font-semibold group cursor-pointer"
                    >
                      <MapPin className="w-3.5 h-3.5 text-blue-500 group-hover:animate-bounce" />
                      <span>{alert.address}</span>
                    </button>
                    <div className="pl-5 text-slate-500 text-[9px] flex justify-between items-center">
                      <span>GPS: {alert.lat ? alert.lat.toFixed(5) : '0.00'}, {alert.lng ? alert.lng.toFixed(5) : '0.00'}</span>
                      <span className="flex items-center gap-0.5 text-slate-500 font-sans">
                        <Clock className="w-3 h-3" />
                        {alert.timestamp}
                      </span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
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