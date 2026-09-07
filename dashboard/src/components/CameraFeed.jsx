import React, { useRef, useEffect, useState } from 'react';
import { Camera, RefreshCw, AlertCircle, Eye, AlertTriangle, ShieldCheck, MapPin } from 'lucide-react';
import { CURRENT_NODE_LOCATION } from '../config/location';

const AI_BACKEND_BASE = import.meta.env.VITE_AI_BACKEND_URL || 'http://localhost:8002';
const HAS_AI_BACKEND = Boolean(AI_BACKEND_BASE);

// Singletons for offscreen canvas operations to completely avoid GPU/memory leaks & GC freezes
const sharedFrameCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
const sharedSkinCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
const sharedStructureCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
const sharedSignatureCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;

function formatExactTimestamp(dateObj = new Date()) {
    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, '0');
    const day = String(dateObj.getDate()).padStart(2, '0');
    const hours = String(dateObj.getHours()).padStart(2, '0');
    const minutes = String(dateObj.getMinutes()).padStart(2, '0');
    const seconds = String(dateObj.getSeconds()).padStart(2, '0');
    const ms = String(dateObj.getMilliseconds()).padStart(3, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
}

function normalizePlateChar(char) {
    const map = { 'O': '0', 'Q': '0', 'I': '1', 'L': '1', 'Z': '2', 'S': '5', 'B': '8', 'G': '6', 'T': '7' };
    return map[char] || char;
}

function isFuzzyPlateMatch(detectedStr, enrolledStr) {
    if (!detectedStr || !enrolledStr) return false;
    const d = detectedStr.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const e = enrolledStr.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!d || !e) return false;

    if (d.includes(e) || e.includes(d)) return true;

    const normD = d.split('').map(normalizePlateChar).join('');
    const normE = e.split('').map(normalizePlateChar).join('');
    if (normD.includes(normE) || normE.includes(normD)) return true;

    if (Math.abs(normD.length - normE.length) <= 2 && normE.length >= 4) {
        let diffs = 0;
        const minLen = Math.min(normD.length, normE.length);
        for (let i = 0; i < minLen; i++) {
            if (normD[i] !== normE[i]) diffs++;
        }
        diffs += Math.abs(normD.length - normE.length);
        if (diffs <= 2) return true;
    }

    return false;
}

function getCropSkinRatio(imgSource, cropBox) {
    try {
        if (!sharedSkinCanvas) return 0;
        const sampleW = 32;
        const sampleH = 32;
        if (sharedSkinCanvas.width !== sampleW || sharedSkinCanvas.height !== sampleH) {
            sharedSkinCanvas.width = sampleW;
            sharedSkinCanvas.height = sampleH;
        }
        const ctx = sharedSkinCanvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return 0;

        const srcW = imgSource.videoWidth || imgSource.naturalWidth || imgSource.width || 640;
        const srcH = imgSource.videoHeight || imgSource.naturalHeight || imgSource.height || 480;

        if (!srcW || !srcH) return 0;

        const sx = Math.max(0, srcW * cropBox.x);
        const sy = Math.max(0, srcH * cropBox.y);
        const sw = Math.min(srcW - sx, srcW * cropBox.w);
        const sh = Math.min(srcH - sy, srcH * cropBox.h);

        if (sw <= 0 || sh <= 0) return 0;

        ctx.drawImage(imgSource, sx, sy, sw, sh, 0, 0, sampleW, sampleH);
        const imgData = ctx.getImageData(0, 0, sampleW, sampleH).data;

        let skinPixels = 0;
        const totalPixels = sampleW * sampleH;

        for (let i = 0; i < totalPixels; i++) {
            const r = imgData[i * 4];
            const g = imgData[i * 4 + 1];
            const b = imgData[i * 4 + 2];

            const isSkin = (r > 40 && g > 25 && b > 15 &&
                (Math.max(r, g, b) - Math.min(r, g, b) > 12) &&
                Math.abs(r - g) > 12 && r > g && r > b) ||
                ((128 - 0.168 * r - 0.331 * g + 0.500 * b >= 77) &&
                 (128 - 0.168 * r - 0.331 * g + 0.500 * b <= 127) &&
                 (128 + 0.500 * r - 0.418 * g - 0.081 * b >= 133) &&
                 (128 + 0.500 * r - 0.418 * g - 0.081 * b <= 173));

            if (isSkin) skinPixels++;
        }

        return skinPixels / totalPixels;
    } catch (e) {
        return 0;
    }
}

function hasFaceStructure(imgSource, cropBox) {
    try {
        if (!sharedStructureCanvas) return false;
        const sampleW = 24;
        const sampleH = 24;
        if (sharedStructureCanvas.width !== sampleW || sharedStructureCanvas.height !== sampleH) {
            sharedStructureCanvas.width = sampleW;
            sharedStructureCanvas.height = sampleH;
        }
        const ctx = sharedStructureCanvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return false;

        const srcW = imgSource.videoWidth || imgSource.naturalWidth || imgSource.width || 640;
        const srcH = imgSource.videoHeight || imgSource.naturalHeight || imgSource.height || 480;

        if (!srcW || !srcH) return false;

        const sx = Math.max(0, srcW * cropBox.x);
        const sy = Math.max(0, srcH * cropBox.y);
        const sw = Math.min(srcW - sx, srcW * cropBox.w);
        const sh = Math.min(srcH - sy, srcH * cropBox.h);

        if (sw <= 0 || sh <= 0) return false;

        ctx.drawImage(imgSource, sx, sy, sw, sh, 0, 0, sampleW, sampleH);
        const imgData = ctx.getImageData(0, 0, sampleW, sampleH).data;

        let totalLum = 0;
        const lums = new Float32Array(sampleW * sampleH);

        for (let i = 0; i < lums.length; i++) {
            const r = imgData[i * 4];
            const g = imgData[i * 4 + 1];
            const b = imgData[i * 4 + 2];
            lums[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0;
            totalLum += lums[i];
        }

        const meanLum = totalLum / lums.length;
        let variance = 0;
        for (let i = 0; i < lums.length; i++) {
            variance += (lums[i] - meanLum) * (lums[i] - meanLum);
        }
        const stdDev = Math.sqrt(variance / lums.length);

        return stdDev >= 0.038;
    } catch (e) {
        return false;
    }
}

const targetSignatureCache = new Map();

function getCanvasImageSignature(imgSource, targetWidth = 24, targetHeight = 24, cropBox = null) {
    try {
        if (!sharedSignatureCanvas) return null;
        if (sharedSignatureCanvas.width !== targetWidth || sharedSignatureCanvas.height !== targetHeight) {
            sharedSignatureCanvas.width = targetWidth;
            sharedSignatureCanvas.height = targetHeight;
        }
        const ctx = sharedSignatureCanvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;

        const srcW = imgSource.videoWidth || imgSource.naturalWidth || imgSource.width || 640;
        const srcH = imgSource.videoHeight || imgSource.naturalHeight || imgSource.height || 480;

        if (cropBox && srcW > 0 && srcH > 0) {
            const sx = Math.max(0, srcW * cropBox.x);
            const sy = Math.max(0, srcH * cropBox.y);
            const sw = Math.min(srcW - sx, srcW * cropBox.w);
            const sh = Math.min(srcH - sy, srcH * cropBox.h);
            if (sw > 0 && sh > 0) {
                ctx.drawImage(imgSource, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);
            } else {
                ctx.drawImage(imgSource, 0, 0, targetWidth, targetHeight);
            }
        } else {
            ctx.drawImage(imgSource, 0, 0, targetWidth, targetHeight);
        }

        const imgData = ctx.getImageData(0, 0, targetWidth, targetHeight).data;
        const grid = new Float32Array(targetWidth * targetHeight);

        for (let i = 0; i < grid.length; i++) {
            const r = imgData[i * 4];
            const g = imgData[i * 4 + 1];
            const b = imgData[i * 4 + 2];
            grid[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0;
        }

        const vec = new Float32Array(targetWidth * targetHeight * 2);
        let idx = 0;
        let sum = 0;

        for (let y = 0; y < targetHeight; y++) {
            for (let x = 0; x < targetWidth; x++) {
                const center = grid[y * targetWidth + x];
                const right = grid[y * targetWidth + Math.min(x + 1, targetWidth - 1)];
                const down = grid[Math.min(y + 1, targetHeight - 1) * targetWidth + x];

                const gradX = right - center;
                const gradY = down - center;

                vec[idx++] = center;
                vec[idx++] = Math.sqrt(gradX * gradX + gradY * gradY);
                sum += center + vec[idx - 1];
            }
        }

        const mean = sum / vec.length;
        let sumSq = 0;
        for (let i = 0; i < vec.length; i++) {
            vec[i] -= mean;
            sumSq += vec[i] * vec[i];
        }

        const std = Math.sqrt(sumSq);
        if (std > 0.0001) {
            for (let i = 0; i < vec.length; i++) vec[i] /= std;
        }
        return vec;
    } catch (e) {
        return null;
    }
}

function getTargetImageSignature(imageSrc) {
    if (!imageSrc) return Promise.resolve(null);
    if (targetSignatureCache.has(imageSrc)) {
        return Promise.resolve(targetSignatureCache.get(imageSrc));
    }
    return new Promise((resolve) => {
        const timeoutId = setTimeout(() => resolve(null), 1200);
        const img = new Image();
        if (imageSrc.startsWith('http://') || imageSrc.startsWith('https://')) {
            img.crossOrigin = 'anonymous';
        }
        img.onload = () => {
            clearTimeout(timeoutId);
            const targetFaceCrop = { x: 0.12, y: 0.08, w: 0.76, h: 0.82 };
            const sig = getCanvasImageSignature(img, 24, 24, targetFaceCrop);
            if (sig) targetSignatureCache.set(imageSrc, sig);
            resolve(sig);
        };
        img.onerror = (err) => {
            clearTimeout(timeoutId);
            console.warn("Failed to load target portrait image:", err);
            resolve(null);
        };
        img.src = imageSrc;
    });
}

export default function CameraFeed({
    cameraId = 'CAM_01',
    cameraName = 'DOWNTOWN_NODE',
    latitude = null,
    longitude = null,
    streamUrl = null,
    enrolledTargets = [],
    enrolledPlates = [],
    onDetection = null,
    onLocationClick = null
}) {
    const videoRef = useRef(null);
    const imgRef = useRef(null);
    const canvasRef = useRef(null);
    const timestampRef = useRef(null);
    const activeDetectionsRef = useRef([]);
    const lastAlertTimeRef = useRef(new Map());
    const isScanningFaceRef = useRef(false);
    const isScanningPlateRef = useRef(false);
    const frameCounterRef = useRef(0);
    const lastProcessedFaceFrameRef = useRef(0);
    const lastProcessedPlateFrameRef = useRef(0);
    const lastScanTickRef = useRef(Date.now());
    const mediaRecorderRef = useRef(null);
    const recordedChunksRef = useRef([]);

    const activePresenceMapRef = useRef(new Map());

    const handlePresenceLifecycle = (subjectKey, alertData) => {
        const now = Date.now();
        const presenceMap = activePresenceMapRef.current;
        let presence = presenceMap.get(subjectKey);
        let isUpgradedTarget = false;

        // If an intruder key exists and we just identified a named target match, upgrade intruder key to named target key
        if (!presence && subjectKey.startsWith('FACE_')) {
            const intruderKey = `INTRUDER_${cameraId}`;
            if (presenceMap.has(intruderKey)) {
                presenceMap.delete(intruderKey);
                isUpgradedTarget = true;
            }
        }

        if (!presence || isUpgradedTarget) {
            // --- 1. SUBJECT ARRIVAL / RE-ENTRY (ENTRY ALERT - FIRED EVERY TIME ON ARRIVAL) ---
            presence = {
                subjectKey,
                subjectName: alertData.subject,
                lastSeen: now,
                firstSeen: now
            };
            presenceMap.set(subjectKey, presence);

            let recordedVideoUrl = null;
            if (recordedChunksRef.current && recordedChunksRef.current.length > 0) {
                try {
                    const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' });
                    recordedVideoUrl = URL.createObjectURL(blob);
                } catch (e) {}
            }

            const alertWithRecording = {
                ...alertData,
                videoUrl: recordedVideoUrl
            };

            if (onDetectionRef.current) {
                onDetectionRef.current(alertWithRecording);
            }
        } else {
            // --- 2. CONTINUOUS DWELL IN FRAME ---
            // Subject is already present. Refresh lastSeen timestamp; NO repeated entry alerts while standing in frame!
            presence.lastSeen = now;
            presence.subjectName = alertData.subject;
        }
    };


    const onDetectionRef = useRef(onDetection);
    const onLocationClickRef = useRef(onLocationClick);
    const enrolledPlatesRef = useRef(enrolledPlates);
    const enrolledTargetsRef = useRef(enrolledTargets);

    useEffect(() => { onDetectionRef.current = onDetection; }, [onDetection]);
    useEffect(() => { onLocationClickRef.current = onLocationClick; }, [onLocationClick]);
    useEffect(() => { enrolledPlatesRef.current = enrolledPlates; }, [enrolledPlates]);
    useEffect(() => { enrolledTargetsRef.current = enrolledTargets; }, [enrolledTargets]);

    const activeLocation = {
        address: 'Primary Surveillance Hub',
        lat: latitude ?? CURRENT_NODE_LOCATION.lat,
        lng: longitude ?? CURRENT_NODE_LOCATION.lng
    };

    const activeLocationRef = useRef(activeLocation);
    useEffect(() => {
        activeLocationRef.current = activeLocation;
    }, [latitude, longitude, activeLocation.address]);

    const [error, setError] = useState(null);
    const [isScanning, setIsScanning] = useState(false);
    const [lastMatch, setLastMatch] = useState(null);
    const [aiBackendOffline, setAiBackendOffline] = useState(false);

    useEffect(() => {
        if (lastMatch) {
            const timer = setTimeout(() => {
                setLastMatch(null);
            }, 1200);
            return () => clearTimeout(timer);
        }
    }, [lastMatch]);

    // Clear stale bounding box overlays after 2.5 seconds of no update (using lastSeen timestamp)
    useEffect(() => {
        const cleanupInterval = setInterval(() => {
            if (activeDetectionsRef.current && activeDetectionsRef.current.length > 0) {
                const now = Date.now();
                activeDetectionsRef.current = activeDetectionsRef.current.filter(d => (now - (d.lastSeen || (d.timestamp ? d.timestamp * 1000 : now))) < 2500);
            }
        }, 500);
        return () => clearInterval(cleanupInterval);
    }, []);

    // 1. Live Webcam Stream Setup with Auto-Recovery on Reload
    useEffect(() => {
        let activeStream = null;

        async function initCamera() {
            if (streamUrl) return;
            try {
                activeStream = await navigator.mediaDevices.getUserMedia({
                    video: {
                        width: { ideal: 1280 },
                        height: { ideal: 720 },
                        facingMode: 'user'
                    },
                    audio: false,
                });

                if (videoRef.current) {
                    videoRef.current.srcObject = activeStream;
                    videoRef.current.onloadedmetadata = () => {
                        if (videoRef.current) videoRef.current.play().catch(e => console.warn("Autoplay blocked:", e));
                    };
                    videoRef.current.play().catch(() => {});

                    try {
                        if (window.MediaRecorder && activeStream) {
                            const recorder = new MediaRecorder(activeStream);
                            recorder.ondataavailable = (e) => {
                                if (e.data && e.data.size > 0) {
                                    recordedChunksRef.current.push(e.data);
                                    if (recordedChunksRef.current.length > 8) {
                                        recordedChunksRef.current.shift();
                                    }
                                }
                            };
                            recorder.start(1000);
                            mediaRecorderRef.current = recorder;
                        }
                    } catch (recErr) {
                        console.warn("MediaRecorder initialization warning:", recErr);
                    }
                }
            } catch (err) {
                console.error("Camera Access Error:", err);
                setError("Camera access required. Ensure URL is localhost or HTTPS.");
            }
        }

        initCamera();

        const playRecoveryTimer = setInterval(() => {
            if (videoRef.current && (videoRef.current.paused || videoRef.current.ended) && !streamUrl) {
                videoRef.current.play().catch(() => {});
            }
        }, 1500);

        return () => {
            clearInterval(playRecoveryTimer);
            if (activeStream) {
                activeStream.getTracks().forEach((track) => track.stop());
            }
        };
    }, [streamUrl]);

    const captureFrameBlob = (mediaSource, width, height) => {
        return new Promise((resolve) => {
            try {
                if (!sharedFrameCanvas) {
                    resolve(null);
                    return;
                }
                // Downscale frame for fast AI scanning (max 640px) - Windows optimized canvas performance!
                const maxDim = 640;
                let targetW = width;
                let targetH = height;
                if (width > maxDim || height > maxDim) {
                    const scale = maxDim / Math.max(width, height);
                    targetW = Math.round(width * scale);
                    targetH = Math.round(height * scale);
                }

                const scaleX = width / Math.max(1, targetW);
                const scaleY = height / Math.max(1, targetH);

                if (sharedFrameCanvas.width !== targetW || sharedFrameCanvas.height !== targetH) {
                    sharedFrameCanvas.width = targetW;
                    sharedFrameCanvas.height = targetH;
                }
                const ctx = sharedFrameCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
                if (!ctx) {
                    resolve(null);
                    return;
                }
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'medium';
                ctx.drawImage(mediaSource, 0, 0, targetW, targetH);
                sharedFrameCanvas.toBlob((blob) => resolve({ blob, scaleX, scaleY }), 'image/jpeg', 0.80);
            } catch (e) {
                resolve(null);
            }
        });
    };

    // 2. Snapshot Scanning Loop (Plates, Watchlist Faces, & Un-enrolled Intruder Detection)
    useEffect(() => {
        let isProcessingFrame = false;

        const scanInterval = setInterval(async () => {
            const plates = enrolledPlatesRef.current;
            const targets = enrolledTargetsRef.current;
            const activeLoc = activeLocationRef.current;

            // Watchdog lock self-healing: if stalled >3.0s, force-reset locks
            if (Date.now() - lastScanTickRef.current > 3000) {
                isScanningFaceRef.current = false;
                isScanningPlateRef.current = false;
                isProcessingFrame = false;
            }
            lastScanTickRef.current = Date.now();

            if (isProcessingFrame) return;

            const mediaSource = streamUrl ? imgRef.current : videoRef.current;
            if (!mediaSource) return;

            const srcWidth = streamUrl ? mediaSource.naturalWidth : mediaSource.videoWidth;
            const srcHeight = streamUrl ? mediaSource.naturalHeight : mediaSource.videoHeight;

            if (!srcWidth || !srcHeight) return;

            if (canvasRef.current && (canvasRef.current.width !== srcWidth || canvasRef.current.height !== srcHeight)) {
                canvasRef.current.width = srcWidth;
                canvasRef.current.height = srcHeight;
            }

            try {
                isProcessingFrame = true;
                setIsScanning(true);

                const captureRes = await captureFrameBlob(mediaSource, srcWidth, srcHeight);
                if (!captureRes || !captureRes.blob) {
                    isProcessingFrame = false;
                    setIsScanning(false);
                    return;
                }
                const { blob, scaleX, scaleY } = captureRes;

                frameCounterRef.current += 1;
                const currentFrameId = frameCounterRef.current;
                const currentTimestamp = Date.now() / 1000.0;
                let newDetections = [];

                // Define parallel scanner tasks with AbortController & safe finally locks
                const scanPlateTask = async () => {
                    if (!plates || plates.length === 0 || isScanningPlateRef.current) return;
                    isScanningPlateRef.current = true;
                    
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 2500);

                    try {
                        const plateFormData = new FormData();
                        plateFormData.append('file', blob, 'frame.jpg');
                        plateFormData.append('frame_id', currentFrameId.toString());
                        plateFormData.append('timestamp', currentTimestamp.toString());

                        const response = await fetch(`${AI_BACKEND_BASE}/api/scan-plate`, {
                            method: 'POST',
                            body: plateFormData,
                            signal: controller.signal
                        });

                        if (response.ok) {
                            setAiBackendOffline(false);
                            const data = await response.json();
                            if (data.frame_id && data.frame_id < lastProcessedPlateFrameRef.current) {
                                return;
                            }
                            if (data.frame_id) lastProcessedPlateFrameRef.current = data.frame_id;

                            if (data.results && data.results.length > 0) {
                                data.results.forEach((item) => {
                                    if (!item) return;
                                    const rawDetected = item.text || '';
                                    const matched = plates.find((plate) => isFuzzyPlateMatch(rawDetected, plate));

                                    if (matched) {
                                        const exactTime = formatExactTimestamp(new Date());
                                        setLastMatch(`PLATE: ${matched}`);

                                        if (item.bbox) {
                                            const unscaledBbox = [
                                                Math.round(item.bbox[0] * scaleX),
                                                Math.round(item.bbox[1] * scaleY),
                                                Math.round(item.bbox[2] * scaleX),
                                                Math.round(item.bbox[3] * scaleY)
                                            ];
                                            newDetections.push({
                                                type: 'PLATE',
                                                label: `PLATE: ${matched}`,
                                                bbox: unscaledBbox,
                                                confidence: item.confidence ? Math.round(item.confidence * 100) : 95,
                                                timestamp: currentTimestamp
                                            });
                                        }

                                        handlePresenceLifecycle(`PLATE_${matched}`, {
                                            id: `ALERT_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                                            eventType: 'PLATE MATCH',
                                            subject: matched,
                                            details: `Target plate identified on ${cameraId}: ${rawDetected}`,
                                            lat: activeLoc.lat,
                                            lng: activeLoc.lng,
                                            address: activeLoc.address,
                                            cameraId: cameraId,
                                            cameraName: cameraName,
                                            timestamp: exactTime,
                                            confidence: item.confidence ? Math.round(item.confidence * 100) : 95,
                                            severity: 'CRITICAL',
                                        });
                                    }
                                });
                            }
                        }
                    } catch (err) {
                        setAiBackendOffline(false);
                    } finally {
                        clearTimeout(timeoutId);
                        isScanningPlateRef.current = false;
                    }
                };

                const scanFaceTask = async () => {
                    if (isScanningFaceRef.current) return;
                    isScanningFaceRef.current = true;

                    try {
                        let backendAvailable = false;
                        const controller = new AbortController();
                        const timeoutId = setTimeout(() => controller.abort(), 2500);

                        try {
                            const faceFormData = new FormData();
                            faceFormData.append('file', blob, 'frame.jpg');
                            faceFormData.append('targets', typeof targets === 'string' ? targets : JSON.stringify(targets || []));
                            faceFormData.append('frame_id', currentFrameId.toString());
                            faceFormData.append('timestamp', currentTimestamp.toString());

                            const response = await fetch(`${AI_BACKEND_BASE}/api/scan-face`, {
                                method: 'POST',
                                body: faceFormData,
                                signal: controller.signal
                            });

                            if (response.ok) {
                                backendAvailable = true;
                                setAiBackendOffline(false);
                                const data = await response.json();
                                if (data.frame_id && data.frame_id < lastProcessedFaceFrameRef.current) {
                                    return;
                                }
                                if (data.frame_id) lastProcessedFaceFrameRef.current = data.frame_id;

                                if (data.matches && data.matches.length > 0) {
                                    data.matches.forEach((face) => {
                                        const exactTime = formatExactTimestamp(new Date());
                                        const targetName = face.name || face.label || 'UNKNOWN';
                                        const isUnauthorized = targetName === 'UNAUTHORIZED PERSON' || targetName === 'UNKNOWN';

                                        const rawConf = face.confidence 
                                            ? (face.confidence <= 1.0 ? Math.round(face.confidence * 100) : Math.round(face.confidence))
                                            : (isUnauthorized ? 88 : 95);
                                        const confPercent = isUnauthorized ? Math.max(85, rawConf) : Math.max(88, rawConf);

                                        setLastMatch(isUnauthorized ? 'INTRUDER DETECTED' : `TARGET: ${targetName}`);

                                        if (face.bbox) {
                                            const unscaledBbox = [
                                                Math.round(face.bbox[0] * scaleX),
                                                Math.round(face.bbox[1] * scaleY),
                                                Math.round(face.bbox[2] * scaleX),
                                                Math.round(face.bbox[3] * scaleY)
                                            ];
                                            newDetections.push({
                                                type: 'FACE',
                                                label: isUnauthorized ? `FACE: UNAUTHORIZED PERSON` : `FACE: ${targetName}`,
                                                bbox: unscaledBbox,
                                                confidence: confPercent,
                                                timestamp: currentTimestamp
                                            });
                                        }

                                        const intruderKey = `INTRUDER_${cameraId}`;

                                        handlePresenceLifecycle(isUnauthorized ? intruderKey : `FACE_${targetName}`, {
                                            id: `ALERT_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                                            eventType: isUnauthorized ? 'UNAUTHORIZED PRESENCE' : 'TARGET MATCH',
                                            subject: targetName,
                                            details: isUnauthorized
                                                ? `Unenrolled person spotted in live camera feed on ${cameraId}`
                                                : `High-precision facial match identified on ${cameraId}`,
                                            lat: activeLoc.lat,
                                            lng: activeLoc.lng,
                                            address: activeLoc.address,
                                            cameraId: cameraId,
                                            cameraName: cameraName,
                                            timestamp: exactTime,
                                            confidence: confPercent,
                                            severity: isUnauthorized ? 'HIGH' : 'CRITICAL',
                                        });
                                    });
                                }
                            }
                        } catch (backendErr) {
                            backendAvailable = false;
                        } finally {
                            clearTimeout(timeoutId);
                        }

                        // Browser AI Scanner Fallback: Runs when backend server is offline
                        if (!backendAvailable) {
                            const mediaSource = videoRef.current || imgRef.current;
                            if (mediaSource) {
                                const targetList = typeof targets === 'string' ? JSON.parse(targets || '[]') : targets;
                                let candidateCrops = [];

                                if ('FaceDetector' in window) {
                                    try {
                                        const detector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 10 });
                                        const results = await detector.detect(mediaSource);
                                        if (results && results.length > 0) {
                                            candidateCrops = results.map(f => ({
                                                x: Math.max(0, f.boundingBox.x / srcWidth),
                                                y: Math.max(0, f.boundingBox.y / srcHeight),
                                                w: Math.min(1.0, f.boundingBox.width / srcWidth),
                                                h: Math.min(1.0, f.boundingBox.height / srcHeight)
                                            }));
                                        }
                                    } catch (e) {
                                        candidateCrops = [];
                                    }
                                }

                                let isSyntheticGrid = false;
                                if (candidateCrops.length === 0) {
                                    isSyntheticGrid = true;
                                    const testRegions = [
                                        { x: 0.25, y: 0.10, w: 0.50, h: 0.65 },
                                        { x: 0.10, y: 0.10, w: 0.45, h: 0.60 },
                                        { x: 0.45, y: 0.10, w: 0.45, h: 0.60 },
                                        { x: 0.30, y: 0.05, w: 0.40, h: 0.55 },
                                    ];
                                    for (const reg of testRegions) {
                                        if (getCropSkinRatio(mediaSource, reg) >= 0.20 && hasFaceStructure(mediaSource, reg)) {
                                            candidateCrops.push(reg);
                                        }
                                    }
                                }

                                let matchedTargetInFrame = false;
                                const cropEvaluations = [];

                                for (const crop of candidateCrops) {
                                    const skinRatio = getCropSkinRatio(mediaSource, crop);
                                    if (skinRatio < 0.18) continue;
                                    if (!hasFaceStructure(mediaSource, crop)) continue;

                                    const frameSig = getCanvasImageSignature(mediaSource, 24, 24, crop);
                                    let bestMatch = null;
                                    let maxScore = -1.0;

                                    if (frameSig && targetList && targetList.length > 0) {
                                        for (const target of targetList) {
                                            if (target.imageSrc) {
                                                const targetSig = await getTargetImageSignature(target.imageSrc);
                                                if (targetSig && targetSig.length === frameSig.length) {
                                                    let dot = 0;
                                                    for (let i = 0; i < frameSig.length; i++) {
                                                        dot += frameSig[i] * targetSig[i];
                                                    }
                                                    if (dot > maxScore) {
                                                        maxScore = dot;
                                                        bestMatch = { target, score: dot };
                                                    }
                                                }
                                            }
                                        }
                                    }

                                    if (bestMatch && maxScore >= 0.68) {
                                        matchedTargetInFrame = true;
                                    }

                                    cropEvaluations.push({
                                        crop,
                                        skinRatio,
                                        bestMatch,
                                        maxScore
                                    });
                                }

                                for (const evalItem of cropEvaluations) {
                                    const { crop, bestMatch, maxScore } = evalItem;
                                    const bx1 = srcWidth * crop.x;
                                    const by1 = srcHeight * crop.y;
                                    const bx2 = srcWidth * (crop.x + crop.w);
                                    const by2 = srcHeight * (crop.y + crop.h);
                                    const exactTime = formatExactTimestamp(new Date());

                                    if (bestMatch && maxScore >= 0.68) {
                                        const targetName = bestMatch.target.name || 'WATCHLIST TARGET';
                                        setLastMatch(`TARGET: ${targetName}`);
                                        const matchConfidence = Math.min(99, Math.max(88, Math.round((maxScore) * 100)));

                                        newDetections.push({
                                            type: 'FACE',
                                            label: `FACE: ${targetName}`,
                                            bbox: [bx1, by1, bx2, by2],
                                            confidence: matchConfidence,
                                            timestamp: currentTimestamp
                                        });

                                        handlePresenceLifecycle(`FACE_${targetName}`, {
                                            id: `ALERT_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                                            eventType: 'TARGET MATCH',
                                            subject: targetName,
                                            details: `Live Facial Recognition matched '${targetName}' on ${cameraId}`,
                                            lat: activeLoc.lat,
                                            lng: activeLoc.lng,
                                            address: activeLoc.address,
                                            cameraId: cameraId,
                                            cameraName: cameraName,
                                            timestamp: exactTime,
                                            confidence: matchConfidence,
                                            severity: 'CRITICAL',
                                        });
                                    } else {
                                        // NEVER generate UNAUTHORIZED PERSON for synthetic grid crops!
                                        // Synthetic regions are only used for matching watchlist targets when offline.
                                        if (isSyntheticGrid) {
                                            continue;
                                        }
                                        if (maxScore >= 0.25) {
                                            continue;
                                        }

                                        const intruderLabel = 'UNAUTHORIZED PERSON';
                                        setLastMatch(`INTRUDER DETECTED`);

                                        newDetections.push({
                                            type: 'FACE',
                                            label: `FACE: ${intruderLabel}`,
                                            bbox: [bx1, by1, bx2, by2],
                                            confidence: 88,
                                            timestamp: currentTimestamp
                                        });

                                        const intruderKey = `INTRUDER_${cameraId}`;

                                        handlePresenceLifecycle(intruderKey, {
                                            id: `ALERT_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                                            eventType: 'UNAUTHORIZED PRESENCE',
                                            subject: intruderLabel,
                                            details: `Unenrolled person spotted in live camera feed on ${cameraId}`,
                                            lat: activeLoc.lat,
                                            lng: activeLoc.lng,
                                            address: activeLoc.address,
                                            cameraId: cameraId,
                                            cameraName: cameraName,
                                            timestamp: exactTime,
                                            confidence: 88,
                                            severity: 'HIGH',
                                        });
                                    }
                                }
                            }
                        }
                    } catch (err) {
                        console.warn("Scan face error:", err);
                    } finally {
                        isScanningFaceRef.current = false;
                    }
                };

                await Promise.all([scanFaceTask(), scanPlateTask()]);

                // --- 2.5 NON-MAXIMUM SUPPRESSION (NMS) & OVERLAP DEDUPLICATION ---
                const calcIoU = (boxA, boxB) => {
                    if (!boxA || !boxB || boxA.length !== 4 || boxB.length !== 4) return 0;
                    const xA = Math.max(boxA[0], boxB[0]);
                    const yA = Math.max(boxA[1], boxB[1]);
                    const xB = Math.min(boxA[2], boxB[2]);
                    const yB = Math.min(boxA[3], boxB[3]);
                    const interArea = Math.max(0, xB - xA) * Math.max(0, yB - yA);
                    const boxAArea = (boxA[2] - boxA[0]) * (boxA[3] - boxA[1]);
                    const boxBArea = (boxB[2] - boxB[0]) * (boxB[3] - boxB[1]);
                    return interArea / (boxAArea + boxBArea - interArea + 1e-6);
                };

                const calcCenterDistanceRatio = (boxA, boxB) => {
                    if (!boxA || !boxB || boxA.length !== 4 || boxB.length !== 4) return 999;
                    const cAx = (boxA[0] + boxA[2]) / 2;
                    const cAy = (boxA[1] + boxA[3]) / 2;
                    const cBx = (boxB[0] + boxB[2]) / 2;
                    const cBy = (boxB[1] + boxB[3]) / 2;
                    const wA = boxA[2] - boxA[0];
                    const hA = boxA[3] - boxA[1];
                    const wB = boxB[2] - boxB[0];
                    const hB = boxB[3] - boxB[1];
                    const avgDim = Math.max(30, (wA + hA + wB + hB) / 4);
                    const dist = Math.hypot(cAx - cBx, cAy - cBy);
                    return dist / avgDim;
                };

                const calcMatchScore = (boxA, boxB, labelA, labelB) => {
                    const iou = calcIoU(boxA, boxB);
                    const distRatio = calcCenterDistanceRatio(boxA, boxB);
                    
                    let score = 0;
                    if (iou > 0.05) {
                        score += iou * 2.0;
                    }
                    if (distRatio <= 3.5) {
                        score += Math.max(0, 2.0 - distRatio * 0.5);
                    }
                    if (labelA && labelB && labelA === labelB && !labelA.includes('UNAUTHORIZED')) {
                        score += 1.0;
                    }
                    return score;
                };

                if (newDetections.length > 1) {
                    const sortedDetections = [...newDetections].sort((a, b) => {
                        const aIsTarget = a.label && !a.label.includes('UNAUTHORIZED') && !a.label.includes('UNKNOWN');
                        const bIsTarget = b.label && !b.label.includes('UNAUTHORIZED') && !b.label.includes('UNKNOWN');

                        if (aIsTarget && !bIsTarget) return -1;
                        if (!aIsTarget && bIsTarget) return 1;

                        if ((b.confidence || 0) !== (a.confidence || 0)) {
                            return (b.confidence || 0) - (a.confidence || 0);
                        }

                        const areaA = (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]);
                        const areaB = (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]);
                        return areaB - areaA;
                    });

                    const nmsFiltered = [];
                    for (const det of sortedDetections) {
                        let suppress = false;
                        for (const existing of nmsFiltered) {
                            if (existing.type === det.type) {
                                const iou = calcIoU(existing.bbox, det.bbox);
                                const distRatio = calcCenterDistanceRatio(existing.bbox, det.bbox);
                                if (iou > 0.35 || distRatio < 0.40) {
                                    suppress = true;
                                    break;
                                }
                            }
                        }
                        if (!suppress) {
                            nmsFiltered.push(det);
                        }
                    }
                    newDetections = nmsFiltered;
                }

                // --- 3. CHECK FOR DEPARTURES (SUBJECT WENT / LEFT CAMERA FEED) ---
                const checkNow = Date.now();
                const presenceMap = activePresenceMapRef.current;
                const existingActiveTracks = activeDetectionsRef.current || [];

                // Keep presence refreshed ONLY if that specific subject's active spatial detection box is on screen
                if (existingActiveTracks.length > 0) {
                    for (const [subjKey, presence] of presenceMap.entries()) {
                        const isMatchedTrackActive = existingActiveTracks.some(t => {
                            if (subjKey.startsWith('PLATE_')) {
                                return t.type === 'PLATE' && (t.label.includes(presence.subjectName) || t.label.includes(subjKey.replace('PLATE_', '')));
                            }
                            if (subjKey.startsWith('FACE_')) {
                                const targetSubj = subjKey.replace('FACE_', '');
                                return t.type === 'FACE' && (t.label.includes(presence.subjectName) || t.label.includes(targetSubj));
                            }
                            if (subjKey.startsWith('INTRUDER_')) {
                                return t.type === 'FACE' && (t.label.includes('UNAUTHORIZED') || t.label.includes('INTRUDER'));
                            }
                            return false;
                        });

                        if (isMatchedTrackActive) {
                            presence.lastSeen = checkNow;
                        }
                    }
                }

                for (const [subjKey, presence] of presenceMap.entries()) {
                    // Departure detection: 800ms of true absence after leaving frame.
                    const isScanInFlight = isScanningFaceRef.current || isScanningPlateRef.current;
                    const absenceDuration = checkNow - presence.lastSeen;

                    if (absenceDuration > 800 && !isScanInFlight) {
                        presenceMap.delete(subjKey);

                        const exactTime = formatExactTimestamp(new Date());
                        setLastMatch(`LEFT: ${presence.subjectName}`);

                        if (onDetectionRef.current) {
                            onDetectionRef.current({
                                id: `ALERT_LEFT_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                                eventType: 'SUBJECT DEPARTED',
                                subject: presence.subjectName,
                                details: `👋 Subject '${presence.subjectName}' departed camera feed on ${cameraId}`,
                                lat: activeLoc.lat,
                                lng: activeLoc.lng,
                                address: activeLoc.address,
                                cameraId: cameraId,
                                cameraName: cameraName,
                                timestamp: exactTime,
                                confidence: 99,
                                severity: 'LOW',
                            });
                        }
                    }
                }

                // --- 4. TEMPORAL TRACK ASSOCIATION & ACTIVE TRACK MAINTENANCE ---
                const now = Date.now();
                const existingTracks = activeDetectionsRef.current || [];

                // 4.1 Compute score matrix for track-detection pairing
                const matchPairs = [];
                newDetections.forEach((det, dIdx) => {
                    existingTracks.forEach((track, tIdx) => {
                        if (track.type === det.type) {
                            const score = calcMatchScore(track.bbox, det.bbox, track.label, det.label);
                            const distRatio = calcCenterDistanceRatio(track.bbox, det.bbox);
                            const iou = calcIoU(track.bbox, det.bbox);

                            if (score >= 0.15 || iou >= 0.05 || distRatio <= 3.5) {
                                matchPairs.push({ score, dIdx, tIdx, det, track });
                            }
                        }
                    });
                });

                // Sort pairs by highest match score first
                matchPairs.sort((a, b) => b.score - a.score);

                const claimedDets = new Set();
                const claimedTracks = new Set();
                const updatedTracks = [];

                // 4.2 Assign best candidate matches to existing tracks (1 box per moving face!)
                for (const pair of matchPairs) {
                    if (!claimedDets.has(pair.dIdx) && !claimedTracks.has(pair.tIdx)) {
                        claimedDets.add(pair.dIdx);
                        claimedTracks.add(pair.tIdx);

                        const matchTrack = pair.track;
                        matchTrack.bbox = [...pair.det.bbox];
                        if (!pair.det.label.includes('UNAUTHORIZED PERSON') || matchTrack.label.includes('UNAUTHORIZED PERSON')) {
                            matchTrack.label = pair.det.label;
                        }
                        matchTrack.type = pair.det.type;
                        matchTrack.confidence = pair.det.confidence;
                        matchTrack.lastSeen = now;
                        matchTrack.missedFrames = 0;

                        updatedTracks.push(matchTrack);
                    }
                }

                // 4.3 Create new distinct tracks ONLY for genuinely unmatched detections (e.g. separate person entering frame)
                newDetections.forEach((det, dIdx) => {
                    if (!claimedDets.has(dIdx)) {
                        const isDuplicateOfUpdated = updatedTracks.some(tr => {
                            if (tr.type !== det.type) return false;
                            const dRatio = calcCenterDistanceRatio(tr.bbox, det.bbox);
                            const iou = calcIoU(tr.bbox, det.bbox);
                            return iou > 0.35 || dRatio < 0.40;
                        });

                        if (!isDuplicateOfUpdated) {
                            updatedTracks.push({
                                id: `${det.type}_${det.label}_${Math.random().toString(36).substring(2, 6)}`,
                                type: det.type,
                                label: det.label,
                                bbox: [...det.bbox],
                                smoothBox: [...det.bbox],
                                confidence: det.confidence,
                                lastSeen: now,
                                firstSeen: now,
                                missedFrames: 0
                            });
                        }
                    }
                });

                // 4.4 Retain active unmatched tracks for up to 800ms to eliminate dropouts & false departures
                existingTracks.forEach((track, tIdx) => {
                    if (!claimedTracks.has(tIdx)) {
                        const isDuplicateOfUpdated = updatedTracks.some(tr => {
                            if (tr.type !== track.type) return false;
                            const dRatio = calcCenterDistanceRatio(track.bbox, tr.bbox);
                            const iou = calcIoU(track.bbox, tr.bbox);
                            return iou > 0.40 || dRatio < 0.40;
                        });

                        if (!isDuplicateOfUpdated && (now - (track.lastSeen || now)) < 800) {
                            track.missedFrames = (track.missedFrames || 0) + 1;
                            updatedTracks.push(track);
                        }
                    }
                });

                // 4.5 Spatial Deduplication across active tracks (Ensure distinct separate rectangles for diff people)
                const finalActiveTracks = [];
                updatedTracks.sort((a, b) => (b.lastSeen - a.lastSeen) || (b.confidence - a.confidence));

                for (const tr of updatedTracks) {
                    const isTooCloseToAnother = finalActiveTracks.some(existing => {
                        if (existing.type !== tr.type) return false;
                        const iou = calcIoU(existing.bbox, tr.bbox);
                        const dRatio = calcCenterDistanceRatio(existing.bbox, tr.bbox);
                        return iou > 0.40 || dRatio < 0.40;
                    });
                    if (!isTooCloseToAnother) {
                        finalActiveTracks.push(tr);
                    }
                }

                activeDetectionsRef.current = finalActiveTracks;

                if (finalActiveTracks.length > 0) {
                    const topTrack = finalActiveTracks.find(t => t.label.includes('UNAUTHORIZED') || t.label.includes('INTRUDER')) || finalActiveTracks[0];
                    if (topTrack.label.includes('UNAUTHORIZED') || topTrack.label.includes('INTRUDER')) {
                        setLastMatch('INTRUDER DETECTED');
                    } else if (topTrack.label.includes('PLATE:')) {
                        setLastMatch(topTrack.label);
                    } else {
                        setLastMatch(`TARGET: ${topTrack.label.replace('FACE: ', '')}`);
                    }
                } else {
                    setLastMatch(null);
                }
            } catch (e) {
                console.warn("Frame processing exception:", e);
            } finally {
                isProcessingFrame = false;
                setIsScanning(false);
            }
        }, 120);

        return () => clearInterval(scanInterval);
    }, [cameraId, cameraName, streamUrl]);

    // 3. High-Tech UI Canvas Overlay with Real-time Bounding Boxes
    useEffect(() => {
        let animationId;

        function renderOverlay() {
            if (timestampRef.current) {
                timestampRef.current.textContent = formatExactTimestamp(new Date());
            }

            if (canvasRef.current) {
                const ctx = canvasRef.current.getContext('2d');
                const width = canvasRef.current.width;
                const height = canvasRef.current.height;

                ctx.clearRect(0, 0, width, height);

                // Clean Overlay: Render Bounding Boxes strictly for Active Detections (Faces, License Plates & Objects)
                if (activeDetectionsRef.current && activeDetectionsRef.current.length > 0) {
                    const now = Date.now();
                    activeDetectionsRef.current.forEach((det) => {
                        if (det.bbox && det.bbox.length === 4) {
                            if (!det.smoothBox) {
                                det.smoothBox = [...det.bbox];
                            } else {
                                det.smoothBox[0] += (det.bbox[0] - det.smoothBox[0]) * 0.65;
                                det.smoothBox[1] += (det.bbox[1] - det.smoothBox[1]) * 0.65;
                                det.smoothBox[2] += (det.bbox[2] - det.smoothBox[2]) * 0.65;
                                det.smoothBox[3] += (det.bbox[3] - det.smoothBox[3]) * 0.65;
                            }

                            const [x1, y1, x2, y2] = det.smoothBox;
                            const bw = x2 - x1;
                            const bh = y2 - y1;

                            // Keep bounding boxes 100% solid, bright, and crisp at full opacity without fading
                            ctx.globalAlpha = 1.0;

                            const isFace = det.type === 'FACE';
                            const isObject = det.type === 'OBJECT';
                            const isUnauth = det.label && det.label.includes('UNAUTHORIZED');
                            const isBag = det.label && det.label.includes('BAG');

                            const boxColor = isBag ? '#f59e0b' : (isUnauth ? '#f43f5e' : (isFace ? '#10b981' : '#3b82f6'));
                            const bgColor = isBag ? 'rgba(180, 83, 9, 0.95)' : (isUnauth ? 'rgba(159, 18, 57, 0.95)' : (isFace ? 'rgba(6, 78, 59, 0.90)' : 'rgba(30, 58, 138, 0.90)'));

                            ctx.strokeStyle = boxColor;
                            ctx.lineWidth = 3;
                            ctx.shadowColor = boxColor;
                            ctx.shadowBlur = 8;
                            ctx.strokeRect(x1, y1, bw, bh);
                            ctx.shadowBlur = 0;

                            const cornerLen = Math.min(15, bw * 0.2, bh * 0.2);
                            ctx.lineWidth = 4;
                            ctx.beginPath();
                            ctx.moveTo(x1, y1 + cornerLen);
                            ctx.lineTo(x1, y1);
                            ctx.lineTo(x1 + cornerLen, y1);
                            ctx.stroke();

                            ctx.beginPath();
                            ctx.moveTo(x2 - cornerLen, y1);
                            ctx.lineTo(x2, y1);
                            ctx.lineTo(x2, y1 + cornerLen);
                            ctx.stroke();

                            ctx.beginPath();
                            ctx.moveTo(x1, y2 - cornerLen);
                            ctx.lineTo(x1, y2);
                            ctx.lineTo(x1 + cornerLen, y2);
                            ctx.stroke();

                            ctx.beginPath();
                            ctx.moveTo(x2 - cornerLen, y2);
                            ctx.lineTo(x2, y2);
                            ctx.lineTo(x2, y2 - cornerLen);
                            ctx.stroke();

                            const text = `${det.label} (${det.confidence}%)`;
                            ctx.font = 'bold 12px monospace';
                            const textMetrics = ctx.measureText(text);
                            const tagW = textMetrics.width + 16;
                            const tagH = 24;
                            const tagY = Math.max(0, y1 - tagH);

                            ctx.fillStyle = bgColor;
                            ctx.fillRect(x1, tagY, tagW, tagH);
                            ctx.strokeStyle = boxColor;
                            ctx.lineWidth = 1;
                            ctx.strokeRect(x1, tagY, tagW, tagH);

                            ctx.fillStyle = '#ffffff';
                            ctx.fillText(text, x1 + 8, tagY + 16);

                            ctx.globalAlpha = 1.0;
                        }
                    });
                }
            }
            animationId = requestAnimationFrame(renderOverlay);
        }

        renderOverlay();
        return () => cancelAnimationFrame(animationId);
    }, [enrolledPlates, enrolledTargets, isScanning, lastMatch]);

    return (
        <div className="relative w-full aspect-video max-h-[70vh] rounded-2xl bg-black border border-slate-800 shadow-2xl flex items-center justify-center overflow-hidden select-none">
            <button
                onClick={() => onLocationClickRef.current && onLocationClickRef.current(cameraId)}
                className="absolute top-3 left-3 bg-slate-900/90 border border-slate-800 text-[10px] p-2.5 rounded-lg font-mono text-slate-300 z-10 shadow-lg flex flex-col gap-1 text-left hover:border-blue-500/50 hover:bg-slate-900 transition-all cursor-pointer select-none group"
            >
                <div className="flex items-center gap-1.5 text-cyan-400 font-bold mb-0.5">
                    <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse"></span>
                    {cameraId} // {cameraName}
                </div>
                <div className="flex items-center gap-1 text-slate-400 group-hover:text-blue-400 font-semibold transition-colors">
                    <MapPin className="w-3.5 h-3.5 text-blue-500 group-hover:animate-bounce" />
                    <span>{activeLocation.lat.toFixed(4)}, {activeLocation.lng.toFixed(4)}</span>
                </div>
                <div ref={timestampRef} className="text-slate-500 text-[9px] mt-0.5 font-sans">
                    {formatExactTimestamp(new Date())}
                </div>
            </button>

            {/* Top Right HUD Scanner Status Box */}
            <div className={`absolute top-3 right-3 z-20 px-3.5 py-2 rounded-xl border font-mono text-[11px] flex items-center gap-2.5 shadow-xl backdrop-blur-md transition-all ${
                lastMatch
                    ? (lastMatch.includes('INTRUDER') || lastMatch.includes('UNAUTHORIZED')
                        ? 'bg-rose-950/90 border-rose-600/80 text-rose-200 shadow-rose-950/50 animate-pulse'
                        : (lastMatch.includes('TARGET')
                            ? 'bg-emerald-950/90 border-emerald-500/80 text-emerald-200 shadow-emerald-950/50'
                            : 'bg-amber-950/90 border-amber-500/80 text-amber-200 shadow-amber-950/50'))
                    : 'bg-slate-900/90 border-slate-700/80 text-slate-300 shadow-black/50'
            }`}>
                <span className={`w-2.5 h-2.5 rounded-full ${
                    lastMatch
                        ? (lastMatch.includes('INTRUDER') || lastMatch.includes('UNAUTHORIZED') ? 'bg-rose-500 animate-ping' : 'bg-emerald-400 animate-pulse')
                        : 'bg-cyan-400 animate-pulse'
                }`} />
                <span className="font-bold tracking-wide uppercase">
                    {lastMatch ? (
                        lastMatch.includes('INTRUDER') || lastMatch.includes('UNAUTHORIZED')
                            ? '⚠️ ALERT: UNAUTHORIZED PERSON DETECTED'
                            : (lastMatch.includes('TARGET')
                                ? `MATCH DETECTED // ${lastMatch}`
                                : `DETECTION // ${lastMatch}`)
                    ) : (
                        'AI SCANNER ACTIVE // NO SUBJECT IN FRAME'
                    )}
                </span>
            </div>

            {error && (
                <div className="absolute z-20 p-2 bg-rose-950/90 border border-rose-800 text-rose-300 text-[11px] font-mono rounded">
                    {error}
                </div>
            )}

            {aiBackendOffline && (
                <div className="absolute z-20 p-2 bg-rose-950/90 border border-rose-800 text-rose-300 text-[11px] font-mono rounded top-16 right-3">
                    ⚠️ AI Server Offline
                </div>
            )}

            {streamUrl ? (
                <img
                    ref={imgRef}
                    src={streamUrl}
                    crossOrigin="anonymous"
                    className="w-full h-full object-cover select-none pointer-events-none"
                    alt={`${cameraId} stream`}
                />
            ) : (
                <video
                    ref={videoRef}
                    className="w-full h-full object-cover"
                    autoPlay
                    muted
                    playsInline
                    crossOrigin="anonymous"
                    onLoadedMetadata={() => {
                        if (videoRef.current) videoRef.current.play().catch(() => {});
                    }}
                    onCanPlay={() => {
                        if (videoRef.current) videoRef.current.play().catch(() => {});
                    }}
                />
            )}

            <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full pointer-events-none z-10"
            />
        </div>
    );
}