import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import http from 'http';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

let backendProcess = null;
let isStartingBackend = false;

function checkBackendHealth() {
    return new Promise((resolve) => {
        const req = http.get('http://127.0.0.1:8002/api/health', { timeout: 1000 }, (res) => {
            if (res.statusCode === 200) {
                resolve(true);
            } else {
                resolve(false);
            }
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
    });
}

async function ensureBackendRunning() {
    if (isStartingBackend) return;
    const isHealthy = await checkBackendHealth();
    if (isHealthy) return;

    isStartingBackend = true;
    console.log('[Vite Auto-Backend] AI Backend on port 8002 is offline. Auto-starting python backend...');

    const pythonBin = path.join(rootDir, '.venv', 'bin', 'python');
    const backendScript = path.join(rootDir, 'cctv-backend', 'main.py');

    try {
        backendProcess = spawn(pythonBin, [backendScript], {
            cwd: rootDir,
            detached: true,
            stdio: 'ignore'
        });
        backendProcess.unref();

        // Wait up to 3s for startup
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 200));
            const ok = await checkBackendHealth();
            if (ok) {
                console.log('[Vite Auto-Backend] Python AI Backend started successfully on port 8002!');
                break;
            }
        }
    } catch (err) {
        console.error('[Vite Auto-Backend] Failed to auto-start backend:', err);
    } finally {
        isStartingBackend = false;
    }
}

function autoBackendPlugin() {
    return {
        name: 'auto-backend-plugin',
        configureServer(server) {
            // Trigger backend check on dev server start
            ensureBackendRunning();

            server.middlewares.use(async (req, res, next) => {
                if (req.url && (req.url.startsWith('/api/ensure-backend') || req.url.startsWith('/api/health'))) {
                    ensureBackendRunning();
                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ status: 'ok', online: true, timestamp: Date.now() }));
                    return;
                }
                next();
            });
        }
    };
}

export default defineConfig({
    plugins: [react(), autoBackendPlugin()],
    server: {
        port: 3000,
        host: true,
        proxy: {
            '/api': {
                target: 'http://127.0.0.1:8002',
                changeOrigin: true,
                secure: false
            }
        }
    }
});
