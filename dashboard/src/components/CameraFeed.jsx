import React, { useRef, useEffect, useState } from 'react';
import { MapPin } from 'lucide-react';
import { CURRENT_NODE_LOCATION } from '../config/location'; // Central coordinate source

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

    const onDetectionRef = useRef(onDetection);
    const onLocationClickRef = useRef(onLocationClick);
    const enrolledPlatesRef = useRef(enrolledPlates);

    useEffect(() => { onDetectionRef.current = onDetection; }, [onDetection]);
    useEffect(() => { onLocationClickRef.current = onLocationClick; }, [onLocationClick]);
    useEffect(() => { enrolledPlatesRef.current = enrolledPlates; }, [enrolledPlates]);

    // Priority: Passed props -> Central config
    const activeLocation = {
        address: 'Primary Surveillance Hub',
        lat: latitude ?? CURRENT_NODE_LOCATION.lat,
        lng: longitude ?? CURRENT_NODE_LOCATION.lng
    };

    const [error, setError] = useState(null);
    const [isScanning, setIsScanning] = useState(false);
    const [lastDetectedPlate, setLastDetectedPlate] = useState(null);

    // Auto-clear match banner after 4 seconds
    useEffect(() => {
        if (lastDetectedPlate) {
            const timer = setTimeout(() => setLastDetectedPlate(null), 4000);
            return () => clearTimeout(timer);
        }
    }, [lastDetectedPlate]);

    // 1. Live Webcam Stream Setup
    useEffect(() => {
        let activeStream = null;

        async function initCamera() {
            if (streamUrl) return;
            try {
                activeStream = await navigator.mediaDevices.getUserMedia({
                    video: { width: { ideal: 1280 }, height: { ideal: 720 } },
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
                setError("Camera access required. Ensure URL is localhost.");
            }
        }

        initCamera();

        return () => {
            if (activeStream) {
                activeStream.getTracks().forEach((track) => track.stop());
            }
        };
    }, [streamUrl]);

    // 2. Snapshot Scanning to Python API
    useEffect(() => {
        let isProcessingFrame = false;

        const scanInterval = setInterval(async () => {
            const targets = enrolledPlatesRef.current;
            if (isProcessingFrame || !targets || targets.length === 0) {
                return;
            }

            const mediaSource = streamUrl ? imgRef.current : videoRef.current;
            if (!mediaSource) return;

            const srcWidth = streamUrl ? mediaSource.naturalWidth : mediaSource.videoWidth;
            const srcHeight = streamUrl ? mediaSource.naturalHeight : mediaSource.videoHeight;

            if (!srcWidth || !srcHeight) return;

            try {
                isProcessingFrame = true;
                setIsScanning(true);

                const frameCanvas = document.createElement('canvas');
                frameCanvas.width = srcWidth;
                frameCanvas.height = srcHeight;
                const ctx = frameCanvas.getContext('2d');
                ctx.drawImage(mediaSource, 0, 0, srcWidth, srcHeight);

                frameCanvas.toBlob(async (blob) => {
                    if (!blob) {
                        isProcessingFrame = false;
                        setIsScanning(false);
                        return;
                    }

                    const formData = new FormData();
                    formData.append('file', blob, 'frame.jpg');

                    try {
                        const response = await fetch('http://localhost:8002/api/scan-plate', {
                            method: 'POST',
                            body: formData,
                        });

                        if (!response.ok) {
                            throw new Error(`Server status ${response.status}`);
                        }

                        const data = await response.json();

                        if (data.results && data.results.length > 0) {
                            data.results.forEach((item) => {
                                const rawDetected = item.text || '';
                                const cleanDetected = rawDetected.replace(/[^A-Z0-9]/gi, '').toUpperCase();

                                const matched = targets.find((target) => {
                                    const cleanTarget = target.replace(/[^A-Z0-9]/gi, '').toUpperCase();
                                    if (!cleanTarget || !cleanDetected) return false;

                                    return cleanDetected.includes(cleanTarget) || cleanTarget.includes(cleanDetected);
                                });

                                if (matched) {
                                    const exactDetectionTime = formatExactTimestamp(new Date());
                                    setLastDetectedPlate(matched);

                                    if (onDetectionRef.current) {
                                        onDetectionRef.current({
                                            id: `ALERT_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                                            eventType: 'PLATE MATCH',
                                            subject: matched,
                                            details: `Target plate identified on ${cameraId}: ${rawDetected}`,
                                            lat: activeLocation.lat,
                                            lng: activeLocation.lng,
                                            address: activeLocation.address,
                                            cameraId: cameraId,
                                            cameraName: cameraName,
                                            timestamp: exactDetectionTime,
                                            confidence: item.confidence ? Math.round(item.confidence * 100) : 95,
                                            severity: 'CRITICAL',
                                        });
                                    }
                                }
                            });
                        }
                    } catch (fetchErr) {
                        console.error("ANPR Endpoint Error:", fetchErr);
                    } finally {
                        isProcessingFrame = false;
                        setIsScanning(false);
                    }
                }, 'image/jpeg', 0.85);

            } catch (e) {
                console.warn("Frame capture exception:", e);
                isProcessingFrame = false;
                setIsScanning(false);
            }
        }, 800);

        return () => clearInterval(scanInterval);
    }, [cameraId, cameraName, activeLocation.lat, activeLocation.lng, activeLocation.address, streamUrl]);

    // 3. UI Canvas Overlay
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

                const hasPlates = enrolledPlates && enrolledPlates.length > 0;

                if (hasPlates) {
                    const boxX = width * 0.15;
                    const boxY = height * 0.15;
                    const boxW = width * 0.70;
                    const boxH = height * 0.70;

                    ctx.strokeStyle = lastDetectedPlate ? '#10b981' : '#f59e0b';
                    ctx.lineWidth = 2;
                    ctx.strokeRect(boxX, boxY, boxW, boxH);

                    const scanLineY = boxY + ((Math.sin(Date.now() / 250) + 1) / 2) * boxH;
                    ctx.strokeStyle = lastDetectedPlate ? 'rgba(16, 185, 129, 0.7)' : 'rgba(245, 158, 11, 0.7)';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(boxX, scanLineY);
                    ctx.lineTo(boxX + boxW, scanLineY);
                    ctx.stroke();

                    ctx.fillStyle = lastDetectedPlate ? 'rgba(6, 78, 59, 0.95)' : 'rgba(120, 53, 4, 0.95)';
                    ctx.fillRect(boxX, boxY - 26, boxW, 26);
                    ctx.fillStyle = '#ffffff';
                    ctx.font = 'bold 11px monospace';

                    const labelText = lastDetectedPlate
                        ? `MATCH DETECTED: ${lastDetectedPlate}`
                        : (isScanning ? 'EASYOCR INFERENCE RUNNING...' : 'ANPR ENGINE READY');

                    ctx.fillText(labelText, boxX + 8, boxY - 9);
                }
            }
            animationId = requestAnimationFrame(renderOverlay);
        }

        renderOverlay();
        return () => cancelAnimationFrame(animationId);
    }, [enrolledPlates, isScanning, lastDetectedPlate]);

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
                width={640}
                height={480}
                className="absolute inset-0 w-full h-full pointer-events-none z-10"
            />
        </div>
    );
}