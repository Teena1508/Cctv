import React, { useRef, useEffect, useState } from 'react';
import { Camera, RefreshCw, AlertCircle, Eye, AlertTriangle, ShieldCheck, MapPin } from 'lucide-react';
import { CURRENT_NODE_LOCATION } from '../config/location';

const AI_BACKEND_BASE = import.meta.env.VITE_AI_BACKEND_URL || 'http://localhost:8002';
const HAS_AI_BACKEND = Boolean(AI_BACKEND_BASE);

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

    // Exact or substring match
    if (d.includes(e) || e.includes(d)) return true;

    // Character normalization (0/O, 1/I, etc.)
    const normD = d.split('').map(normalizePlateChar).join('');
    const normE = e.split('').map(normalizePlateChar).join('');
    if (normD.includes(normE) || normE.includes(normD)) return true;

    // Levenshtein distance tolerance
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
        const offCanvas = document.createElement('canvas');
        const sampleW = 32;
        const sampleH = 32;
        offCanvas.width = sampleW;
        offCanvas.height = sampleH;
        const ctx = offCanvas.getContext('2d');

        const srcW = imgSource.videoWidth || imgSource.naturalWidth || imgSource.width || 640;
        const srcH = imgSource.videoHeight || imgSource.naturalHeight || imgSource.height || 480;

        if (!srcW || !srcH) return 0;

        const sx = srcW * cropBox.x;
        const sy = srcH * cropBox.y;
        const sw = srcW * cropBox.w;
        const sh = srcH * cropBox.h;

        ctx.drawImage(imgSource, sx, sy, sw, sh, 0, 0, sampleW, sampleH);
        const imgData = ctx.getImageData(0, 0, sampleW, sampleH).data;

        let skinPixels = 0;
        const totalPixels = sampleW * sampleH;

        for (let i = 0; i < totalPixels; i++) {
            const r = imgData[i * 4];
            const g = imgData[i * 4 + 1];
            const b = imgData[i * 4 + 2];

            const isSkin = (r > 45 && g > 30 && b > 20 &&
                (Math.max(r, g, b) - Math.min(r, g, b) > 15) &&
                Math.abs(r - g) > 15 && r > g && r > b) ||
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

const targetSignatureCache = new Map();

function getCanvasImageSignature(imgSource, targetWidth = 16, targetHeight = 16, cropBox = null) {
    try {
        const offCanvas = document.createElement('canvas');
        offCanvas.width = targetWidth;
        offCanvas.height = targetHeight;
        const ctx = offCanvas.getContext('2d');

        const srcW = imgSource.videoWidth || imgSource.naturalWidth || imgSource.width || 640;
        const srcH = imgSource.videoHeight || imgSource.naturalHeight || imgSource.height || 480;

        if (cropBox && srcW > 0 && srcH > 0) {
            const sx = srcW * cropBox.x;
            const sy = srcH * cropBox.y;
            const sw = srcW * cropBox.w;
            const sh = srcH * cropBox.h;
            ctx.drawImage(imgSource, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);
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

        // Extract luminance + Sobel gradient feature vector (captures facial contours & structure)
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
        const img = new Image();
        if (imageSrc.startsWith('http://') || imageSrc.startsWith('https://')) {
            img.crossOrigin = 'anonymous';
        }
        img.onload = () => {
            const sig = getCanvasImageSignature(img, 16, 16, null);
            if (sig) targetSignatureCache.set(imageSrc, sig);
            resolve(sig);
        };
        img.onerror = (err) => {
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

    const triggerAlertThrottled = (subjectKey, alertData) => {
        const now = Date.now();
        const lastTime = lastAlertTimeRef.current.get(subjectKey) || 0;
        if (now - lastTime > 4000) {
            lastAlertTimeRef.current.set(subjectKey, now);
            if (onDetectionRef.current) {
                onDetectionRef.current(alertData);
            }
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
            }, 4000);
            return () => clearTimeout(timer);
        }
    }, [lastMatch]);

    // Clear stale bounding box overlays after 2 seconds of no update
    useEffect(() => {
        const cleanupInterval = setInterval(() => {
            if (activeDetectionsRef.current.length > 0) {
                const now = Date.now();
                activeDetectionsRef.current = activeDetectionsRef.current.filter(d => (now - d.timestamp) < 2500);
            }
        }, 1000);
        return () => clearInterval(cleanupInterval);
    }, []);

    // 1. Live Webcam Stream Setup
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
                        videoRef.current.play().catch(e => console.warn("Autoplay blocked:", e));
                    };
                }
            } catch (err) {
                console.error("Camera Access Error:", err);
                setError("Camera access required. Ensure URL is localhost or HTTPS.");
            }
        }

        initCamera();

        return () => {
            if (activeStream) {
                activeStream.getTracks().forEach((track) => track.stop());
            }
        };
    }, [streamUrl]);

    const captureFrameBlob = (mediaSource, width, height) => {
        return new Promise((resolve) => {
            const frameCanvas = document.createElement('canvas');
            frameCanvas.width = width;
            frameCanvas.height = height;
            const ctx = frameCanvas.getContext('2d');
            ctx.drawImage(mediaSource, 0, 0, width, height);
            frameCanvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.90);
        });
    };

    // 2. Snapshot Scanning Loop (Plates & Faces)
    useEffect(() => {
        let isProcessingFrame = false;

        const scanInterval = setInterval(async () => {
            const plates = enrolledPlatesRef.current;
            const targets = enrolledTargetsRef.current;
            const activeLoc = activeLocationRef.current;

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

                const blob = await captureFrameBlob(mediaSource, srcWidth, srcHeight);
                if (!blob) {
                    isProcessingFrame = false;
                    setIsScanning(false);
                    return;
                }

                frameCounterRef.current += 1;
                const currentFrameId = frameCounterRef.current;
                const currentTimestamp = Date.now() / 1000.0;
                let newDetections = [];

                // Define parallel scanner tasks with in-flight guards
                const scanPlateTask = async () => {
                    if (!plates || plates.length === 0 || isScanningPlateRef.current) return;
                    isScanningPlateRef.current = true;
                    const plateFormData = new FormData();
                    plateFormData.append('file', blob, 'frame.jpg');
                    plateFormData.append('frame_id', currentFrameId.toString());
                    plateFormData.append('timestamp', currentTimestamp.toString());

                    try {
                        const response = await fetch(`${AI_BACKEND_BASE}/api/scan-plate`, {
                            method: 'POST',
                            body: plateFormData,
                        });

                        if (response.ok) {
                            setAiBackendOffline(false);
                            const data = await response.json();
                            if (data.frame_id && data.frame_id < lastProcessedPlateFrameRef.current) {
                                return; // Discard out-of-order stale response
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
                                            newDetections.push({
                                                type: 'PLATE',
                                                label: `PLATE: ${matched}`,
                                                bbox: item.bbox,
                                                confidence: item.confidence ? Math.round(item.confidence * 100) : 95,
                                                timestamp: currentTimestamp
                                            });
                                        }

                                        triggerAlertThrottled(`PLATE_${matched}`, {
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
                        isScanningPlateRef.current = false;
                    }
                };

                const scanFaceTask = async () => {
                    if (!targets || targets.length === 0 || isScanningFaceRef.current) return;
                    isScanningFaceRef.current = true;
                    const faceFormData = new FormData();
                    faceFormData.append('file', blob, 'frame.jpg');
                    faceFormData.append('targets', typeof targets === 'string' ? targets : JSON.stringify(targets));
                    faceFormData.append('frame_id', currentFrameId.toString());
                    faceFormData.append('timestamp', currentTimestamp.toString());

                    try {
                        let backendAvailable = false;
                        try {
                            const response = await fetch(`${AI_BACKEND_BASE}/api/scan-face`, {
                                method: 'POST',
                                body: faceFormData,
                            });

                            if (response.ok) {
                                backendAvailable = true;
                                setAiBackendOffline(false);
                                const data = await response.json();
                                if (data.frame_id && data.frame_id < lastProcessedFaceFrameRef.current) {
                                    return; // Discard out-of-order stale response
                                }
                                if (data.frame_id) lastProcessedFaceFrameRef.current = data.frame_id;

                                if (data.matches && data.matches.length > 0) {
                                    data.matches.forEach((face) => {
                                        const exactTime = formatExactTimestamp(new Date());
                                        const targetName = face.name || face.label || 'UNKNOWN';
                                        setLastMatch(`TARGET: ${targetName}`);

                                        if (face.bbox) {
                                            newDetections.push({
                                                type: 'FACE',
                                                label: `FACE: ${targetName}`,
                                                bbox: face.bbox,
                                                confidence: face.confidence ? Math.round(face.confidence * 100) : 92,
                                                timestamp: currentTimestamp
                                            });
                                        }

                                        triggerAlertThrottled(`FACE_${targetName}`, {
                                            id: `ALERT_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                                            eventType: 'TARGET MATCH',
                                            subject: targetName,
                                            details: `High-precision facial match identified on ${cameraId}`,
                                            lat: activeLoc.lat,
                                            lng: activeLoc.lng,
                                            address: activeLoc.address,
                                            cameraId: cameraId,
                                            cameraName: cameraName,
                                            timestamp: exactTime,
                                            confidence: face.confidence ? Math.round(face.confidence * 100) : 92,
                                            severity: 'CRITICAL',
                                        });
                                    });
                                }
                            }
                        } catch (backendErr) {
                            backendAvailable = false;
                            setAiBackendOffline(false);
                        }

                        // Browser AI Scanner Fallback: ONLY runs if AI Backend server is completely offline/unreachable
                        if (!backendAvailable) {
                            const mediaSource = videoRef.current || imgRef.current;
                            if (mediaSource) {
                                const candidateCrops = [
                                    { x: 0.15, y: 0.10, w: 0.70, h: 0.80 },
                                    { x: 0.25, y: 0.15, w: 0.50, h: 0.65 },
                                    { x: 0.20, y: 0.05, w: 0.60, h: 0.75 },
                                    { x: 0.05, y: 0.05, w: 0.90, h: 0.90 }
                                ];
                                const targetList = typeof targets === 'string' ? JSON.parse(targets || '[]') : targets;

                                let bestMatch = null;
                                let maxScore = -1.0;

                                for (const crop of candidateCrops) {
                                    // Face Presence Verification: reject empty room / wall / desk backgrounds
                                    const skinRatio = getCropSkinRatio(mediaSource, crop);
                                    if (skinRatio < 0.18) continue;

                                    const frameSig = getCanvasImageSignature(mediaSource, 16, 16, crop);
                                    if (!frameSig) continue;

                                    for (const target of targetList) {
                                        if (target.imageSrc) {
                                            const targetSig = await getTargetImageSignature(target.imageSrc);
                                            if (targetSig) {
                                                let dot = 0;
                                                for (let i = 0; i < frameSig.length; i++) {
                                                    dot += frameSig[i] * targetSig[i];
                                                }
                                                if (dot > maxScore) {
                                                    maxScore = dot;
                                                    bestMatch = { target, crop, score: dot };
                                                }
                                            }
                                        }
                                    }
                                }

                                if (bestMatch && bestMatch.score >= 0.65) {
                                    const targetName = bestMatch.target.name || 'WATCHLIST TARGET';
                                    const exactTime = formatExactTimestamp(new Date());
                                    setLastMatch(`TARGET: ${targetName}`);

                                    const bx1 = srcWidth * bestMatch.crop.x;
                                    const by1 = srcHeight * bestMatch.crop.y;
                                    const bx2 = srcWidth * (bestMatch.crop.x + bestMatch.crop.w);
                                    const by2 = srcHeight * (bestMatch.crop.y + bestMatch.crop.h);
                                    const matchConfidence = Math.min(98, Math.max(78, Math.round(bestMatch.score * 100)));

                                    newDetections.push({
                                        type: 'FACE',
                                        label: `FACE: ${targetName}`,
                                        bbox: [bx1, by1, bx2, by2],
                                        confidence: matchConfidence,
                                        timestamp: currentTimestamp
                                    });

                                    triggerAlertThrottled(`FACE_${targetName}`, {
                                        id: `ALERT_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                                        eventType: 'TARGET MATCH',
                                        subject: targetName,
                                        details: `Live Browser AI matched target portrait on ${cameraId}`,
                                        lat: activeLoc.lat,
                                        lng: activeLoc.lng,
                                        address: activeLoc.address,
                                        cameraId: cameraId,
                                        cameraName: cameraName,
                                        timestamp: exactTime,
                                        confidence: matchConfidence,
                                        severity: 'CRITICAL',
                                    });
                                }
                            }
                        }
                    } catch (err) {
                        console.warn("Scan face error:", err);
                    } finally {
                        isScanningFaceRef.current = false;
                    }
                };

                // Execute scanners concurrently in parallel
                await Promise.all([scanFaceTask(), scanPlateTask()]);

                activeDetectionsRef.current = newDetections;
            } catch (e) {
                console.warn("Frame processing exception:", e);
            } finally {
                isProcessingFrame = false;
                setIsScanning(false);
            }
        }, 200);

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

                const hasActiveWatchlist = (enrolledPlates && enrolledPlates.length > 0) || (enrolledTargets && enrolledTargets.length > 0);

                if (hasActiveWatchlist) {
                    const boxX = width * 0.15;
                    const boxY = height * 0.15;
                    const boxW = width * 0.70;
                    const boxH = height * 0.70;

                    // Central Scanner Box
                    ctx.strokeStyle = lastMatch ? '#10b981' : '#f59e0b';
                    ctx.lineWidth = 3;
                    ctx.strokeRect(boxX, boxY, boxW, boxH);

                    // Scan line
                    const scanLineY = boxY + ((Math.sin(Date.now() / 250) + 1) / 2) * boxH;
                    ctx.strokeStyle = lastMatch ? 'rgba(16, 185, 129, 0.7)' : 'rgba(245, 158, 11, 0.7)';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(boxX, scanLineY);
                    ctx.lineTo(boxX + boxW, scanLineY);
                    ctx.stroke();

                    // Status Bar Header
                    ctx.fillStyle = lastMatch ? 'rgba(6, 78, 59, 0.95)' : 'rgba(120, 53, 4, 0.95)';
                    ctx.fillRect(boxX, boxY - 30, boxW, 30);
                    ctx.fillStyle = '#ffffff';
                    ctx.font = 'bold 14px monospace';

                    const labelText = lastMatch
                        ? `MATCH DETECTED: ${lastMatch}`
                        : (isScanning ? 'AI SCANNER ACTIVE...' : 'DETECTION ENGINE READY');

                    ctx.fillText(labelText, boxX + 10, boxY - 10);
                }

                // Render Bounding Boxes for Active Detections (Faces & License Plates)
                if (activeDetectionsRef.current && activeDetectionsRef.current.length > 0) {
                    activeDetectionsRef.current.forEach((det) => {
                        if (det.bbox && det.bbox.length === 4) {
                            const [x1, y1, x2, y2] = det.bbox;
                            const bw = x2 - x1;
                            const bh = y2 - y1;

                            const isFace = det.type === 'FACE';
                            const boxColor = isFace ? '#10b981' : '#3b82f6';
                            const bgColor = isFace ? 'rgba(6, 78, 59, 0.90)' : 'rgba(30, 58, 138, 0.90)';

                            // Bounding Box Rectangle with Glowing Stroke
                            ctx.strokeStyle = boxColor;
                            ctx.lineWidth = 3;
                            ctx.shadowColor = boxColor;
                            ctx.shadowBlur = 8;
                            ctx.strokeRect(x1, y1, bw, bh);
                            ctx.shadowBlur = 0;

                            // Corner Accents
                            const cornerLen = Math.min(15, bw * 0.2, bh * 0.2);
                            ctx.lineWidth = 4;
                            // Top-Left
                            ctx.beginPath();
                            ctx.moveTo(x1, y1 + cornerLen);
                            ctx.lineTo(x1, y1);
                            ctx.lineTo(x1 + cornerLen, y1);
                            ctx.stroke();
                            // Top-Right
                            ctx.beginPath();
                            ctx.moveTo(x2 - cornerLen, y1);
                            ctx.lineTo(x2, y1);
                            ctx.lineTo(x2, y1 + cornerLen);
                            ctx.stroke();
                            // Bottom-Left
                            ctx.beginPath();
                            ctx.moveTo(x1, y2 - cornerLen);
                            ctx.lineTo(x1, y2);
                            ctx.lineTo(x1 + cornerLen, y2);
                            ctx.stroke();
                            // Bottom-Right
                            ctx.beginPath();
                            ctx.moveTo(x2 - cornerLen, y2);
                            ctx.lineTo(x2, y2);
                            ctx.lineTo(x2, y2 - cornerLen);
                            ctx.stroke();

                            // Label Tag Badge Above Box
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
        <div className="relative w-full h-full bg-slate-950 flex items-center justify-center overflow-hidden">
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
                    muted
                    playsInline
                    crossOrigin="anonymous"
                />
            )}

            <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full pointer-events-none z-10"
            />
        </div>
    );
}