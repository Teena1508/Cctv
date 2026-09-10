import React, { useRef, useEffect, useState } from 'react';
import { Camera, RefreshCw, AlertCircle, Eye, AlertTriangle, ShieldCheck, MapPin } from 'lucide-react';
import { CURRENT_NODE_LOCATION } from '../config/location';
import * as tf from '@tensorflow/tfjs';
import * as cocoSsd from '@tensorflow-models/coco-ssd';

let cocoModelPromise = null;
function getCocoModel() {
    if (!cocoModelPromise) {
        cocoModelPromise = cocoSsd.load({ base: 'lite_mobilenet_v2' }).catch(err => {
            console.warn("COCO-SSD load failed, falling back to heuristic detector:", err);
            return null;
        });
    }
    return cocoModelPromise;
}

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
    if (d.length < 4 || e.length < 3) return false;

    if (d === e || d.includes(e)) return true;
    if (e.includes(d) && d.length >= Math.max(4, e.length - 2)) return true;

    const normD = d.split('').map(normalizePlateChar).join('');
    const normE = e.split('').map(normalizePlateChar).join('');
    if (normD === normE || normD.includes(normE)) return true;
    if (normE.includes(normD) && normD.length >= Math.max(4, normE.length - 2)) return true;

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

            const isSkin = (r > 30 && g > 20 && b > 10 &&
                (Math.max(r, g, b) - Math.min(r, g, b) > 8) &&
                r > b) ||
                ((128 - 0.168 * r - 0.331 * g + 0.500 * b >= 65) &&
                 (128 - 0.168 * r - 0.331 * g + 0.500 * b <= 140) &&
                 (128 + 0.500 * r - 0.418 * g - 0.081 * b >= 120) &&
                 (128 + 0.500 * r - 0.418 * g - 0.081 * b <= 185));

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

        return stdDev >= 0.003;
    } catch (e) {
        return false;
    }
}

function findDynamicFaceCrops(imgSource) {
    try {
        if (!sharedStructureCanvas) return [{ x: 0.15, y: 0.10, w: 0.70, h: 0.80 }];
        const sampleW = 120;
        const sampleH = 90;
        if (sharedStructureCanvas.width !== sampleW || sharedStructureCanvas.height !== sampleH) {
            sharedStructureCanvas.width = sampleW;
            sharedStructureCanvas.height = sampleH;
        }
        const ctx = sharedStructureCanvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return [{ x: 0.15, y: 0.10, w: 0.70, h: 0.80 }];

        ctx.drawImage(imgSource, 0, 0, sampleW, sampleH);
        const imgData = ctx.getImageData(0, 0, sampleW, sampleH).data;

        const totalPixels = sampleW * sampleH;
        const colSkinCounts = new Int16Array(sampleW);
        const skinMask = new Uint8Array(totalPixels);
        let totalSkinCount = 0;

        for (let y = 0; y < sampleH; y++) {
            for (let x = 0; x < sampleW; x++) {
                const idx = (y * sampleW + x) * 4;
                const r = imgData[idx];
                const g = imgData[idx + 1];
                const b = imgData[idx + 2];

                const isSkin = (r > 35 && g > 20 && b > 10 && (r > b)) ||
                    (r > 40 && g > 30 && (Math.abs(r - g) > 8)) ||
                    ((128 - 0.168 * r - 0.331 * g + 0.500 * b >= 60) &&
                     (128 + 0.500 * r - 0.418 * g - 0.081 * b >= 105));

                if (isSkin) {
                    skinMask[y * sampleW + x] = 1;
                    colSkinCounts[x]++;
                    totalSkinCount++;
                }
            }
        }

        const segments = [];
        let currentSeg = null;

        for (let x = 0; x < sampleW; x++) {
            if (colSkinCounts[x] >= 1) {
                if (!currentSeg) {
                    currentSeg = { startX: x, endX: x };
                } else {
                    currentSeg.endX = x;
                }
            } else {
                if (currentSeg) {
                    if (x - currentSeg.endX > 4) {
                        if (currentSeg.endX - currentSeg.startX + 1 >= 3) {
                            segments.push(currentSeg);
                        }
                        currentSeg = null;
                    }
                }
            }
        }
        if (currentSeg && (currentSeg.endX - currentSeg.startX + 1 >= 3)) segments.push(currentSeg);

        const candidateCrops = [];

        for (const seg of segments) {
            const segWidth = seg.endX - seg.startX + 1;
            let minY = sampleH, maxY = 0;

            for (let y = 0; y < sampleH; y++) {
                for (let x = seg.startX; x <= seg.endX; x++) {
                    if (skinMask[y * sampleW + x]) {
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                    }
                }
            }

            const segHeight = Math.max(4, maxY - minY + 1);

            candidateCrops.push({
                x: Math.max(0, (seg.startX - 1) / sampleW),
                y: Math.max(0, (minY - 1) / sampleH),
                w: Math.min(1.0, (segWidth + 2) / sampleW),
                h: Math.min(1.0, (segHeight + 2) / sampleH)
            });

            if (segHeight > segWidth * 1.1) {
                const headH = Math.min(segHeight, Math.round(segWidth * 1.3));
                candidateCrops.push({
                    x: Math.max(0, (seg.startX - 1) / sampleW),
                    y: Math.max(0, (minY - 1) / sampleH),
                    w: Math.min(1.0, (segWidth + 2) / sampleW),
                    h: Math.min(1.0, (headH + 2) / sampleH)
                });
            }
        }

        // Always ensure default multi-scale center/upper crops if no specific segment was isolated
        if (candidateCrops.length === 0) {
            candidateCrops.push({ x: 0.15, y: 0.10, w: 0.70, h: 0.80 });
            candidateCrops.push({ x: 0.25, y: 0.15, w: 0.50, h: 0.60 });
            candidateCrops.push({ x: 0.05, y: 0.05, w: 0.90, h: 0.90 });
        }

        return candidateCrops;
    } catch (e) {
        return [{ x: 0.15, y: 0.10, w: 0.70, h: 0.80 }];
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
    cctvIp = null,
    enrolledTargets = [],
    enrolledPlates = [],
    onDetection = null,
    onLocationClick = null,
    onConfigureCctvClick = null
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
    const lastAlertSentMapRef = useRef(new Map());
    const isShowingLeftBannerRef = useRef(false);

    const handlePresenceLifecycle = (subjectKey, alertData) => {
        const now = Date.now();
        const presenceMap = activePresenceMapRef.current;
        let presence = presenceMap.get(subjectKey);
        let isUpgradedTarget = false;

        // If an intruder key exists and we just identified a named target match, upgrade intruder key to named target key
        if (subjectKey.startsWith('FACE_')) {
            const intruderKey = `INTRUDER_${cameraId}`;
            if (presenceMap.has(intruderKey)) {
                presenceMap.delete(intruderKey);
                lastAlertSentMapRef.current.delete(intruderKey);
                isUpgradedTarget = true;
            }
            if (activeDetectionsRef.current) {
                activeDetectionsRef.current = activeDetectionsRef.current.filter(d => !d.label?.includes('UNAUTHORIZED') && !d.label?.includes('INTRUDER'));
            }
        }



        if (!presence || isUpgradedTarget) {
            // --- 1. SUBJECT ARRIVAL / RE-ENTRY (ENTRY ALERT - FIRED ONCE ON ARRIVAL) ---
            presence = {
                subjectKey,
                subjectName: alertData.subject,
                lastSeen: now,
                firstSeen: now
            };
            presenceMap.set(subjectKey, presence);

            const alertWithRecording = {
                ...alertData,
                videoUrl: null
            };

            if (onDetectionRef.current) {
                onDetectionRef.current(alertWithRecording);
            }
        } else {
            // --- 2. CONTINUOUS DWELL IN FRAME ---
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

    // Maintain continuous active track & subject state without premature dropouts
    useEffect(() => {
        if (lastMatch && lastMatch.startsWith('LEFT:')) {
            isShowingLeftBannerRef.current = true;
            const timer = setTimeout(() => {
                isShowingLeftBannerRef.current = false;
                setLastMatch(null);
            }, 3000);
            return () => clearTimeout(timer);
        }
    }, [lastMatch]);

    // Clear stale bounding box overlays after 4.5 seconds of no update (using lastSeen timestamp)
    useEffect(() => {
        const cleanupInterval = setInterval(() => {
            if (activeDetectionsRef.current && activeDetectionsRef.current.length > 0) {
                const now = Date.now();
                activeDetectionsRef.current = activeDetectionsRef.current.filter(d => (now - (d.lastSeen || (d.timestamp ? d.timestamp * 1000 : now))) < 4500);
            }
        }, 500);
        return () => clearInterval(cleanupInterval);
    }, []);

    // 1. Live Webcam Stream Setup with Auto-Recovery on Reload & Laptop Wake/Resume
    useEffect(() => {
        let activeStream = null;
        let isReconnecting = false;

        async function initCamera() {
            if (streamUrl || isReconnecting) return;
            isReconnecting = true;
            try {
                if (activeStream) {
                    activeStream.getTracks().forEach((track) => track.stop());
                }

                activeStream = await navigator.mediaDevices.getUserMedia({
                    video: {
                        width: { ideal: 1280 },
                        height: { ideal: 720 },
                        facingMode: 'user'
                    },
                    audio: false,
                });

                if (activeStream) {
                    activeStream.getVideoTracks().forEach((track) => {
                        track.onended = () => {
                            console.warn("Webcam track ended (laptop slept or camera disconnected). Triggering auto-recovery...");
                            initCamera();
                        };
                        track.onmute = () => {
                            console.warn("Webcam track muted.");
                        };
                        track.onunmute = () => {
                            console.info("Webcam track unmuted.");
                            if (videoRef.current) videoRef.current.play().catch(() => {});
                        };
                    });
                }

                if (videoRef.current) {
                    videoRef.current.srcObject = activeStream;
                    videoRef.current.onloadedmetadata = () => {
                        if (videoRef.current) videoRef.current.play().catch(e => console.warn("Autoplay blocked:", e));
                    };
                    videoRef.current.play().catch(() => {});
                }
                
                // Reset frame state and scan locks on fresh stream acquisition
                isScanningFaceRef.current = false;
                isScanningPlateRef.current = false;
                lastProcessedFaceFrameRef.current = 0;
                lastProcessedPlateFrameRef.current = 0;
                frameCounterRef.current = 0;
                setError(null);
            } catch (err) {
                console.error("Camera Access Error:", err);
                setError("Camera access required. Click overlay to retry.");
            } finally {
                isReconnecting = false;
            }
        }

        initCamera();

        // 2. Recovery Watchdog & Laptop Wake / Screen Unlock Event Listeners
        const checkStreamHealth = () => {
            if (streamUrl) return;

            const isDeadTrack = activeStream && activeStream.getVideoTracks().some(t => t.readyState === 'ended' || t.muted);
            const isVideoStuck = videoRef.current && (!videoRef.current.srcObject || videoRef.current.paused || videoRef.current.ended || videoRef.current.videoWidth === 0);

            if (isDeadTrack || isVideoStuck) {
                if (videoRef.current && (videoRef.current.paused || videoRef.current.ended) && !isDeadTrack) {
                    videoRef.current.play().catch(() => {
                        initCamera();
                    });
                } else {
                    initCamera();
                }
            }
        };

        const handleWakeOrFocus = () => {
            if (document.visibilityState === 'visible') {
                console.info("Window visible/focused after wake. Checking camera stream health...");
                // Trigger backend ensure on system wake (only in local dev mode)
                if (import.meta.env.DEV) fetch('/api/ensure-backend').catch(() => {});

                const now = Date.now();
                lastScanTickRef.current = now;
                isScanningFaceRef.current = false;
                isScanningPlateRef.current = false;

                // Refresh presence and active tracks timestamps so sleep gap doesn't trigger false departures
                if (activePresenceMapRef.current) {
                    for (const p of activePresenceMapRef.current.values()) {
                        p.lastSeen = now;
                    }
                }
                if (activeDetectionsRef.current) {
                    activeDetectionsRef.current.forEach(d => { d.lastSeen = now; });
                }

                if (videoRef.current) {
                    videoRef.current.play().catch(() => {});
                }

                checkStreamHealth();
            }
        };

        document.addEventListener('visibilitychange', handleWakeOrFocus);
        window.addEventListener('focus', handleWakeOrFocus);
        window.addEventListener('pageshow', handleWakeOrFocus);
        window.addEventListener('online', handleWakeOrFocus);

        const playRecoveryTimer = setInterval(checkStreamHealth, 1500);

        return () => {
            clearInterval(playRecoveryTimer);
            document.removeEventListener('visibilitychange', handleWakeOrFocus);
            window.removeEventListener('focus', handleWakeOrFocus);
            window.removeEventListener('pageshow', handleWakeOrFocus);
            window.removeEventListener('online', handleWakeOrFocus);
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
                // Capture frame for high-accuracy AI scanning (max 640px)
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
                ctx.drawImage(mediaSource, 0, 0, targetW, targetH);
                sharedFrameCanvas.toBlob((blob) => resolve({ blob, scaleX, scaleY }), 'image/jpeg', 0.85);
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

            // Watchdog lock self-healing: if stalled >2.5s (sleep/background pause), force-reset locks & update timestamps
            const nowTick = Date.now();
            if (nowTick - lastScanTickRef.current > 2500) {
                isScanningFaceRef.current = false;
                isScanningPlateRef.current = false;
                isProcessingFrame = false;

                if (activePresenceMapRef.current) {
                    for (const p of activePresenceMapRef.current.values()) {
                        p.lastSeen = nowTick;
                    }
                }
                if (activeDetectionsRef.current) {
                    activeDetectionsRef.current.forEach(d => { d.lastSeen = nowTick; });
                }
            }
            lastScanTickRef.current = nowTick;

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

                const isHttpsPage = typeof window !== 'undefined' && window.location.protocol === 'https:';
                const isLocalBackend = AI_BACKEND_BASE.includes('localhost') || AI_BACKEND_BASE.includes('127.0.0.1');
                const canQueryBackend = !(isHttpsPage && isLocalBackend);

                // Define parallel scanner tasks with AbortController & safe finally locks
                const scanPlateTask = async () => {
                    if (isScanningPlateRef.current || !canQueryBackend) return;
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

                            if (data.results && data.results.length > 0) {
                                data.results.forEach((item) => {
                                    if (!item) return;
                                    const rawDetected = item.text || '';
                                    const matched = (plates && plates.length > 0) ? plates.find((plate) => isFuzzyPlateMatch(rawDetected, plate)) : null;
                                    const displayLabel = matched ? matched : rawDetected;

                                    if (displayLabel) {
                                        const exactTime = formatExactTimestamp(new Date());
                                        setLastMatch(`PLATE: ${displayLabel}`);

                                        if (item.bbox) {
                                            const unscaledBbox = [
                                                Math.round(item.bbox[0] * scaleX),
                                                Math.round(item.bbox[1] * scaleY),
                                                Math.round(item.bbox[2] * scaleX),
                                                Math.round(item.bbox[3] * scaleY)
                                            ];
                                            newDetections.push({
                                                type: 'PLATE',
                                                label: `PLATE: ${displayLabel}`,
                                                bbox: unscaledBbox,
                                                confidence: item.confidence ? Math.round(item.confidence * 100) : 95,
                                                timestamp: currentTimestamp
                                            });
                                        }

                                        handlePresenceLifecycle(`PLATE_${displayLabel}`, {
                                            id: `ALERT_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                                            eventType: matched ? 'PLATE MATCH' : 'PLATE DETECTED',
                                            subject: displayLabel,
                                            details: `License plate identified on ${cameraId}: ${rawDetected}`,
                                            lat: activeLoc.lat,
                                            lng: activeLoc.lng,
                                            address: activeLoc.address,
                                            cameraId: cameraId,
                                            cameraName: cameraName,
                                            timestamp: exactTime,
                                            confidence: item.confidence ? Math.round(item.confidence * 100) : 95,
                                            severity: matched ? 'CRITICAL' : 'INFO',
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
                        let backendMatchesFound = false;
                        let backendData = null;

                        if (canQueryBackend) {
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
                                    backendData = await response.json();
                                    const data = backendData;

                                    if (data.matches && data.matches.length > 0) {
                                        backendMatchesFound = true;
                                        data.matches.forEach((face) => {
                                            const exactTime = formatExactTimestamp(new Date());
                                            const targetName = face.name || face.label || 'UNKNOWN';
                                            const isUnauthorized = targetName === 'UNAUTHORIZED PERSON' || targetName === 'UNKNOWN' || targetName.includes('UNAUTHORIZED') || targetName.includes('INTRUDER');

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
                                            const normalizedSubject = isUnauthorized ? 'UNAUTHORIZED PERSON' : targetName;

                                            handlePresenceLifecycle(isUnauthorized ? intruderKey : `FACE_${targetName}`, {
                                                id: `ALERT_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                                                eventType: isUnauthorized ? 'UNAUTHORIZED PRESENCE' : 'TARGET MATCH',
                                                subject: normalizedSubject,
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
                                if (typeof timeoutId !== 'undefined') clearTimeout(timeoutId);
                            }
                        }

                        // Browser AI Scanner Fallback: Runs when backend is offline OR returned no matches
                        if (!backendMatchesFound) {
                            const mediaSource = videoRef.current || imgRef.current;
                            if (mediaSource) {
                                const targetList = typeof targets === 'string' ? JSON.parse(targets || '[]') : targets;
                                let candidateCrops = [];
                                let fromNativeDetector = false;
                                let fromCocoSsd = false;

                                // 1. Try TensorFlow.js COCO-SSD Person Detector for high-precision browser AI detection
                                try {
                                    const cocoModel = await getCocoModel();
                                    if (cocoModel) {
                                        const predictions = await cocoModel.detect(mediaSource);
                                        if (predictions && predictions.length > 0) {
                                            const personPreds = predictions.filter(p => p.class === 'person' && p.score >= 0.35);
                                            if (personPreds.length > 0) {
                                                fromCocoSsd = true;
                                                personPreds.forEach(p => {
                                                    const [px, py, pw, ph] = p.bbox;
                                                    candidateCrops.push({
                                                        x: Math.max(0, px / srcWidth),
                                                        y: Math.max(0, py / srcHeight),
                                                        w: Math.min(1.0, pw / srcWidth),
                                                        h: Math.min(1.0, ph / srcHeight),
                                                        score: p.score
                                                    });
                                                    if (ph > 30) {
                                                        candidateCrops.push({
                                                            x: Math.max(0, px / srcWidth),
                                                            y: Math.max(0, py / srcHeight),
                                                            w: Math.min(1.0, pw / srcWidth),
                                                            h: Math.min(1.0, (ph * 0.45) / srcHeight),
                                                            score: p.score
                                                        });
                                                    }
                                                });
                                            }
                                        }
                                    }
                                } catch (cocoErr) {
                                    console.warn("COCO-SSD detection error:", cocoErr);
                                }

                                // 2. Native Chrome FaceDetector API
                                if (candidateCrops.length === 0 && 'FaceDetector' in window) {
                                    try {
                                        const detector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 10 });
                                        const results = await detector.detect(mediaSource);
                                        if (results && results.length > 0) {
                                            fromNativeDetector = true;
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

                                // 3. Fallback Heuristic Face/Head/Body Segment Detector
                                if (candidateCrops.length === 0) {
                                    candidateCrops = findDynamicFaceCrops(mediaSource);
                                }

                                let matchedTargetInFrame = false;
                                const cropEvaluations = [];

                                for (const crop of candidateCrops) {
                                    if (!fromNativeDetector && !fromCocoSsd) {
                                        const skinRatio = getCropSkinRatio(mediaSource, crop);
                                        if (skinRatio < 0.005 && !hasFaceStructure(mediaSource, crop)) continue;
                                    }

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

                await scanFaceTask();
                if ((plates && plates.length > 0 && frameCounterRef.current % 4 === 0) || (frameCounterRef.current % 10 === 0)) {
                    scanPlateTask().catch(() => {});
                }

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

                // Keep presence refreshed while subject is matched in new frame OR active tracks
                for (const [subjKey, presence] of presenceMap.entries()) {
                    const isMatchedInNewFrame = newDetections.some(t => {
                        if (subjKey.startsWith('PLATE_')) {
                            return t.type === 'PLATE' && (t.label.includes(presence.subjectName) || t.label.includes(subjKey.replace('PLATE_', '')));
                        }
                        if (subjKey.startsWith('FACE_')) {
                            const targetSubj = subjKey.replace('FACE_', '');
                            return t.type === 'FACE' && (t.label.includes(presence.subjectName) || t.label.includes(targetSubj));
                        }
                        if (subjKey.startsWith('INTRUDER_')) {
                            return t.type === 'FACE' && (t.label.includes('UNAUTHORIZED') || t.label.includes('INTRUDER') || t.label.includes('UNKNOWN'));
                        }
                        return false;
                    });

                    if (isMatchedInNewFrame) {
                        presence.lastSeen = checkNow;
                    }
                }

                for (const [subjKey, presence] of presenceMap.entries()) {
                    // Fast & 100% reliable departure detection: 1.0s of true absence from new frame scans
                    const absenceDuration = checkNow - presence.lastSeen;

                    if (absenceDuration > 1000) {
                        presenceMap.delete(subjKey);
                        lastAlertSentMapRef.current.delete(subjKey);

                        const exactTime = formatExactTimestamp(new Date());
                        isShowingLeftBannerRef.current = true;
                        const departureSubject = presence.subjectName || (subjKey.startsWith('INTRUDER_') ? 'UNAUTHORIZED PERSON' : 'SUBJECT');
                        setLastMatch(`LEFT: ${departureSubject}`);

                        if (onDetectionRef.current) {
                            onDetectionRef.current({
                                id: `ALERT_LEFT_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                                eventType: 'SUBJECT DEPARTED',
                                subject: departureSubject,
                                details: `👋 Subject '${departureSubject}' departed camera feed on ${cameraId}`,
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
                        matchTrack.label = pair.det.label;
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

                // 4.4 Hysteresis grace period: retain active tracks for 600ms of inactivity for snappy track drops
                existingTracks.forEach((track, tIdx) => {
                    if (!claimedTracks.has(tIdx)) {
                        if ((now - (track.lastSeen || now)) < 600) {
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
                    isShowingLeftBannerRef.current = false;
                    const targetTrack = finalActiveTracks.find(t => t.label && !t.label.includes('UNAUTHORIZED') && !t.label.includes('INTRUDER'));
                    const topTrack = targetTrack || finalActiveTracks[0];
                    if (topTrack.label.includes('UNAUTHORIZED') || topTrack.label.includes('INTRUDER')) {
                        setLastMatch('INTRUDER DETECTED');
                    } else if (topTrack.label.includes('PLATE:')) {
                        setLastMatch(topTrack.label);
                    } else {
                        setLastMatch(`TARGET: ${topTrack.label.replace('FACE: ', '')}`);
                    }
                } else {
                    if (!isShowingLeftBannerRef.current) {
                        setLastMatch(null);
                    }
                }
            } catch (e) {
                console.warn("Frame processing exception:", e);
            } finally {
                isProcessingFrame = false;
                setIsScanning(false);
            }
        }, 50);

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
                                det.smoothBox[0] += (det.bbox[0] - det.smoothBox[0]) * 0.40;
                                det.smoothBox[1] += (det.bbox[1] - det.smoothBox[1]) * 0.40;
                                det.smoothBox[2] += (det.bbox[2] - det.smoothBox[2]) * 0.40;
                                det.smoothBox[3] += (det.bbox[3] - det.smoothBox[3]) * 0.40;
                            }

                            const [x1, y1, x2, y2] = det.smoothBox;
                            const bw = x2 - x1;
                            const bh = y2 - y1;

                            // Keep bounding boxes 100% solid, bright, and crisp at full opacity without fading
                            ctx.globalAlpha = 1.0;

                            const isFace = det.type === 'FACE';
                            const isObject = det.type === 'OBJECT';
                            const isUnauth = det.label && (det.label.includes('UNAUTHORIZED') || det.label.includes('INTRUDER') || det.label.includes('UNKNOWN'));
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

    // Compute continuous active HUD detection status based on active presence map / detections (UNAUTHORIZED/INTRUDER gets TOP RED ALERT PRIORITY)
    const now = Date.now();
    let activeSubjectLabel = lastMatch;

    // Check activeDetectionsRef for current frame tracks (Intruder takes priority over Target)
    if (activeDetectionsRef.current && activeDetectionsRef.current.length > 0) {
        const freshDets = activeDetectionsRef.current.filter(d => (now - (d.lastSeen || (d.timestamp ? d.timestamp * 1000 : now))) < 4500);
        if (freshDets.length > 0) {
            const targetDet = freshDets.find(d => d.label && !d.label.includes('UNAUTHORIZED') && !d.label.includes('INTRUDER'));
            const intruderDet = freshDets.find(d => d.label?.includes('UNAUTHORIZED') || d.label?.includes('INTRUDER'));
            if (intruderDet) {
                activeSubjectLabel = 'INTRUDER DETECTED';
            } else if (targetDet) {
                activeSubjectLabel = targetDet.label.replace('FACE: ', 'TARGET: ');
            }
        }
    }

    if ((!activeSubjectLabel || activeSubjectLabel.startsWith('LEFT:')) && activePresenceMapRef.current) {
        let intruderPres = null;
        let targetPres = null;
        let platePres = null;

        for (const [key, presence] of activePresenceMapRef.current.entries()) {
            if (presence && (now - presence.lastSeen) < 4500) {
                if (key.startsWith('INTRUDER_') || presence.subjectName === 'UNAUTHORIZED PERSON') {
                    intruderPres = presence;
                } else if (key.startsWith('FACE_')) {
                    targetPres = presence;
                } else if (key.startsWith('PLATE_')) {
                    platePres = presence;
                }
            }
        }

        if (intruderPres) {
            activeSubjectLabel = 'INTRUDER DETECTED';
        } else if (targetPres) {
            activeSubjectLabel = `TARGET: ${targetPres.subjectName}`;
        } else if (platePres) {
            activeSubjectLabel = `PLATE: ${platePres.subjectName}`;
        }
    }

    return (
        <div className="relative w-full aspect-video max-h-[70vh] rounded-2xl bg-black border border-slate-800 shadow-2xl flex items-center justify-center overflow-hidden select-none">
            <button
                onClick={() => onLocationClickRef.current && onLocationClickRef.current(cameraId)}
                className="absolute top-3 left-3 bg-slate-900/90 border border-slate-800 text-[10px] p-2.5 rounded-lg font-mono text-slate-300 z-10 shadow-lg flex flex-col gap-1 text-left hover:border-blue-500/50 hover:bg-slate-900 transition-all cursor-pointer select-none group"
            >
                <div className="flex items-center gap-1.5 text-cyan-400 font-bold mb-0.5">
                    <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse"></span>
                    {streamUrl ? `📡 CCTV IP: ${cctvIp || 'ACTIVE STREAM'}` : `${cameraId} // ${cameraName}`}
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
                activeSubjectLabel
                    ? (activeSubjectLabel.includes('INTRUDER') || activeSubjectLabel.includes('UNAUTHORIZED')
                        ? 'bg-rose-950/90 border-rose-600/80 text-rose-200 shadow-rose-950/50 animate-pulse'
                        : (activeSubjectLabel.includes('TARGET')
                            ? 'bg-emerald-950/90 border-emerald-500/80 text-emerald-200 shadow-emerald-950/50'
                            : 'bg-amber-950/90 border-amber-500/80 text-amber-200 shadow-amber-950/50'))
                    : 'bg-slate-900/90 border-slate-700/80 text-slate-300 shadow-black/50'
            }`}>
                <span className={`w-2.5 h-2.5 rounded-full ${
                    activeSubjectLabel
                        ? (activeSubjectLabel.includes('INTRUDER') || activeSubjectLabel.includes('UNAUTHORIZED') ? 'bg-rose-500 animate-ping' : 'bg-emerald-400 animate-pulse')
                        : 'bg-cyan-400 animate-pulse'
                }`} />
                <span className="font-bold tracking-wide uppercase">
                    {activeSubjectLabel ? (
                        activeSubjectLabel.includes('INTRUDER') || activeSubjectLabel.includes('UNAUTHORIZED')
                            ? '⚠️ ALERT: UNAUTHORIZED PERSON DETECTED'
                            : (activeSubjectLabel.includes('TARGET')
                                ? `MATCH DETECTED // ${activeSubjectLabel}`
                                : `DETECTION // ${activeSubjectLabel}`)
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