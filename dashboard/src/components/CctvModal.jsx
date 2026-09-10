import React, { useState, useEffect } from 'react';
import { Camera, Wifi, X, Video, Sliders, Check, Radio, HelpCircle, RefreshCw } from 'lucide-react';

export default function CctvModal({
  isOpen,
  onClose,
  onConnect,
  onUseWebcam,
  currentStreamUrl = null,
  currentIp = '192.168.1.100',
  currentCameraName = 'CAM_01 // CCTV_NODE'
}) {
  const [ipAddress, setIpAddress] = useState(currentIp || '192.168.1.100');
  const [port, setPort] = useState('8080');
  const [protocol, setProtocol] = useState('IP_WEBCAM'); // 'IP_WEBCAM', 'MJPEG', 'PYTHON_FEED', 'CUSTOM'
  const [customUrl, setCustomUrl] = useState(currentStreamUrl || '');
  const [nodeName, setNodeName] = useState(currentCameraName || 'CAM_01 // CCTV_NODE');

  useEffect(() => {
    if (currentIp) setIpAddress(currentIp);
    if (currentStreamUrl) setCustomUrl(currentStreamUrl);
    if (currentCameraName) setNodeName(currentCameraName);
  }, [currentIp, currentStreamUrl, currentCameraName]);

  if (!isOpen) return null;

  const constructStreamUrl = () => {
    if (protocol === 'CUSTOM') {
      return customUrl.trim();
    }
    const cleanIp = ipAddress.trim().replace(/^(https?:\/\/)/, '').replace(/\/.*$/, '');
    const cleanPort = port.trim();

    if (protocol === 'IP_WEBCAM') {
      return `http://${cleanIp}${cleanPort ? ':' + cleanPort : ''}/video`;
    } else if (protocol === 'MJPEG') {
      return `http://${cleanIp}${cleanPort ? ':' + cleanPort : ''}/video.mjpg`;
    } else if (protocol === 'PYTHON_FEED') {
      return `http://${cleanIp}${cleanPort ? ':' + cleanPort : ''}/video_feed`;
    }
    return `http://${cleanIp}${cleanPort ? ':' + cleanPort : ''}/video`;
  };

  const handleFormSubmit = (e) => {
    e.preventDefault();
    const finalUrl = constructStreamUrl();
    if (!finalUrl) return;
    onConnect({
      ip: ipAddress.trim(),
      streamUrl: finalUrl,
      cameraName: nodeName.trim() || 'CAM_01 // CCTV_NODE'
    });
  };

  const handleApplyPreset = (presetType, sampleIp = '192.168.1.100', samplePort = '8080') => {
    setProtocol(presetType);
    setIpAddress(sampleIp);
    setPort(samplePort);
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 select-none">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-xl shadow-2xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-200">
        
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-800 bg-slate-950/70 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-blue-950/80 border border-blue-600/40 text-blue-400">
              <Wifi className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-100 tracking-wide flex items-center gap-2">
                FOG CLUSTER // CCTV IP CAMERA CONFIGURATION
              </h3>
              <p className="text-xs text-slate-400 font-mono">
                Connect live CCTV IP stream for real-time edge AI processing
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <form onSubmit={handleFormSubmit} className="p-6 space-y-5 overflow-y-auto max-h-[75vh]">
          
          {/* Quick Protocol Presets */}
          <div>
            <label className="block text-xs font-mono font-bold text-slate-300 uppercase mb-2 flex items-center justify-between">
              <span>Select Stream Protocol / Preset</span>
              <span className="text-[10px] text-blue-400 font-normal">Auto-formats URL</span>
            </label>
            <div className="grid grid-cols-2 gap-2 font-mono text-xs">
              <button
                type="button"
                onClick={() => handleApplyPreset('IP_WEBCAM', '192.168.1.100', '8080')}
                className={`p-3 rounded-xl border text-left flex flex-col gap-1 transition-all cursor-pointer ${
                  protocol === 'IP_WEBCAM'
                    ? 'bg-blue-950/60 border-blue-500 text-blue-200 shadow-md shadow-blue-950/50'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700'
                }`}
              >
                <div className="font-bold flex items-center gap-1.5">
                  <Video className="w-3.5 h-3.5 text-cyan-400" />
                  IP Webcam App
                </div>
                <span className="text-[10px] text-slate-500">Android/iOS App (http://ip:8080/video)</span>
              </button>

              <button
                type="button"
                onClick={() => handleApplyPreset('MJPEG', '192.168.1.100', '80')}
                className={`p-3 rounded-xl border text-left flex flex-col gap-1 transition-all cursor-pointer ${
                  protocol === 'MJPEG'
                    ? 'bg-blue-950/60 border-blue-500 text-blue-200 shadow-md shadow-blue-950/50'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700'
                }`}
              >
                <div className="font-bold flex items-center gap-1.5">
                  <Camera className="w-3.5 h-3.5 text-emerald-400" />
                  MJPEG IP Camera
                </div>
                <span className="text-[10px] text-slate-500">Standard CCTV (http://ip:port/video.mjpg)</span>
              </button>

              <button
                type="button"
                onClick={() => handleApplyPreset('PYTHON_FEED', 'localhost', '8000')}
                className={`p-3 rounded-xl border text-left flex flex-col gap-1 transition-all cursor-pointer ${
                  protocol === 'PYTHON_FEED'
                    ? 'bg-blue-950/60 border-blue-500 text-blue-200 shadow-md shadow-blue-950/50'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700'
                }`}
              >
                <div className="font-bold flex items-center gap-1.5">
                  <Radio className="w-3.5 h-3.5 text-amber-400" />
                  Python/Flask Stream
                </div>
                <span className="text-[10px] text-slate-500">OpenCV Stream (http://ip:port/video_feed)</span>
              </button>

              <button
                type="button"
                onClick={() => setProtocol('CUSTOM')}
                className={`p-3 rounded-xl border text-left flex flex-col gap-1 transition-all cursor-pointer ${
                  protocol === 'CUSTOM'
                    ? 'bg-blue-950/60 border-blue-500 text-blue-200 shadow-md shadow-blue-950/50'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700'
                }`}
              >
                <div className="font-bold flex items-center gap-1.5">
                  <Sliders className="w-3.5 h-3.5 text-purple-400" />
                  Custom Stream URL
                </div>
                <span className="text-[10px] text-slate-500">Direct RTSP / HTTP Stream Link</span>
              </button>
            </div>
          </div>

          {/* Dynamic Input Fields depending on protocol */}
          {protocol !== 'CUSTOM' ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="md:col-span-2">
                <label className="block text-xs font-mono font-bold text-slate-300 uppercase mb-1">
                  CCTV Camera IP Address
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. 192.168.1.100"
                  value={ipAddress}
                  onChange={(e) => setIpAddress(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 font-mono focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-mono font-bold text-slate-300 uppercase mb-1">
                  Port
                </label>
                <input
                  type="text"
                  placeholder="8080"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 font-mono focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-xs font-mono font-bold text-slate-300 uppercase mb-1">
                Full Stream / RTSP URL
              </label>
              <input
                type="text"
                required
                placeholder="http://192.168.1.100:8080/video or rtsp://..."
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 font-mono focus:outline-none focus:border-blue-500"
              />
            </div>
          )}

          {/* Camera Node Identifier */}
          <div>
            <label className="block text-xs font-mono font-bold text-slate-300 uppercase mb-1">
              Camera Node Identifier Name
            </label>
            <input
              type="text"
              placeholder="CAM_01 // CCTV_NODE_NORTH"
              value={nodeName}
              onChange={(e) => setNodeName(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 font-mono focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* Live Preview Constructed Stream URL */}
          <div className="bg-slate-950 p-3 rounded-xl border border-slate-800/80 font-mono text-xs text-slate-400 flex items-center justify-between">
            <span className="text-[11px] text-slate-500 uppercase">Target Stream URL:</span>
            <span className="text-cyan-400 font-bold truncate max-w-xs">{constructStreamUrl()}</span>
          </div>

          {/* Actions Footer */}
          <div className="pt-2 flex flex-col sm:flex-row gap-2 justify-end">
            <button
              type="button"
              onClick={() => {
                if (onUseWebcam) onUseWebcam();
                onClose();
              }}
              className="px-4 py-2.5 rounded-xl border border-slate-800 bg-slate-950 text-slate-300 hover:bg-slate-800 hover:text-white text-xs font-mono font-bold transition-all flex items-center justify-center gap-2 cursor-pointer"
            >
              <Camera className="w-4 h-4 text-slate-400" />
              Use Built-in Laptop Webcam
            </button>

            <button
              type="submit"
              className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-mono font-bold transition-all shadow-lg shadow-blue-900/50 flex items-center justify-center gap-2 cursor-pointer"
            >
              <Check className="w-4 h-4" />
              Connect CCTV Stream
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
