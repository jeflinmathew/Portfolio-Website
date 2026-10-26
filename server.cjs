const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Lightweight .env reader
const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) {
  try {
    const envContent = fs.readFileSync(ENV_FILE, 'utf8');
    envContent.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const k = trimmed.substring(0, eqIdx).trim();
        const v = trimmed.substring(eqIdx + 1).trim();
        if (!process.env[k]) process.env[k] = v;
      }
    });
  } catch (e) {
    console.warn('[SERVER] Could not load .env file:', e.message);
  }
}

const PORT = parseInt(process.env.PORT, 10) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.resolve(__dirname);
const HTML_FILE = path.join(PUBLIC_DIR, 'index.html');
const DATA_FILE = path.join(PUBLIC_DIR, 'site-data.json');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin2026';
const ADMIN_AUTH_REQUIRED = process.env.ADMIN_AUTH_REQUIRED === 'true';
const MAX_PAYLOAD_SIZE = (parseInt(process.env.MAX_PAYLOAD_MB, 10) || 15) * 1024 * 1024; // Default 15MB
const ALLOWED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif']);

// In-Memory Session Store: token -> { createdAt, expiresAt }
const SESSIONS = new Map();
const SESSION_DURATION = 2 * 60 * 60 * 1000; // 2 hours

function isTokenValid(token) {
  if (!token) return false;
  const session = SESSIONS.get(token);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    SESSIONS.delete(token);
    return false;
  }
  return true;
}

function extractToken(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  return req.headers['x-admin-token'] || '';
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime'
};

// Global error traps for stability
process.on('uncaughtException', (err) => console.error('[SERVER] Uncaught exception:', err));
process.on('unhandledRejection', (reason) => console.error('[SERVER] Unhandled rejection:', reason));

function readJsonBody(req, res, callback) {
  let body = '';
  let size = 0;
  req.on('data', chunk => {
    size += chunk.length;
    if (size > MAX_PAYLOAD_SIZE) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Payload too large. Max allowed size exceeded.' }));
      req.destroy();
      return;
    }
    body += chunk;
  });

  req.on('end', () => {
    if (size > MAX_PAYLOAD_SIZE) return;
    try {
      const parsed = JSON.parse(body || '{}');
      callback(null, parsed);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Malformed JSON payload' }));
    }
  });

  req.on('error', (err) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  });
}

const server = http.createServer((req, res) => {
  // CORS & No-Cache Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Token');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  // API: Admin Authentication (Login) -> 201 Created on success, 401 Unauthorized on failure
  if (req.method === 'POST' && pathname === '/api/login') {
    readJsonBody(req, res, (err, payload) => {
      if (err) return;
      const { password } = payload || {};
      if (!password || String(password).trim() !== ADMIN_PASSWORD) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid admin credentials' }));
        return;
      }

      const token = crypto.randomBytes(24).toString('hex');
      const expiresAt = Date.now() + SESSION_DURATION;
      SESSIONS.set(token, { createdAt: Date.now(), expiresAt });

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, token, expiresAt }));
    });
    return;
  }

  // API: Admin Session Verification -> 200 OK or 401 Unauthorized
  if (req.method === 'GET' && pathname === '/api/session') {
    const token = extractToken(req);
    if (isTokenValid(token)) {
      const session = SESSIONS.get(token);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ valid: true, expiresAt: session.expiresAt }));
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ valid: false, error: 'Unauthorized or session expired' }));
    }
    return;
  }

  // API: Admin Logout -> 200 OK
  if (req.method === 'POST' && pathname === '/api/logout') {
    const token = extractToken(req);
    if (token) SESSIONS.delete(token);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Logged out successfully' }));
    return;
  }

  // API: Save site data permanently -> 200 OK
  if (req.method === 'POST' && pathname === '/api/save') {
    // If auth is required or a token header is provided, enforce token validation
    const token = extractToken(req);
    if (ADMIN_AUTH_REQUIRED || token) {
      if (!isTokenValid(token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Unauthorized: valid admin session token required' }));
        return;
      }
    }

    readJsonBody(req, res, (err, payload) => {
      if (err) return;
      const data = payload && payload.data;
      if (!data || typeof data !== 'object') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Missing or invalid "data" field in payload' }));
        return;
      }

      try {
        // 1. Save data backup JSON
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');

        // 2. Update index.html embedded site-data
        if (fs.existsSync(HTML_FILE)) {
          let html = fs.readFileSync(HTML_FILE, 'utf8');
          const jsonStr = JSON.stringify(data).replace(/</g, '\\u003c');
          html = html.replace(/(<script type="application\/json" id="site-data">)[\s\S]*?(<\/script>)/, `$1${jsonStr}$2`);
          fs.writeFileSync(HTML_FILE, html, 'utf8');
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Saved successfully' }));
      } catch (saveErr) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: saveErr.message }));
      }
    });
    return;
  }

  // API: Upload image file -> 201 Created on success
  if (req.method === 'POST' && pathname === '/api/upload') {
    const token = extractToken(req);
    if (ADMIN_AUTH_REQUIRED || token) {
      if (!isTokenValid(token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Unauthorized: valid admin session token required' }));
        return;
      }
    }

    readJsonBody(req, res, (err, payload) => {
      if (err) return;
      const { filename, dataUrl } = payload || {};
      if (!dataUrl || typeof dataUrl !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Missing or invalid dataUrl' }));
        return;
      }

      // Validate base64 format
      const matches = dataUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
      if (!matches || matches.length !== 3) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid base64 data format' }));
        return;
      }

      // Validate and whitelist file extension
      const rawExt = path.extname(filename || '').toLowerCase() || '.png';
      if (!ALLOWED_IMAGE_EXTS.has(rawExt)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: `Disallowed file extension "${rawExt}". Allowed: ${Array.from(ALLOWED_IMAGE_EXTS).join(', ')}`
        }));
        return;
      }

      const buffer = Buffer.from(matches[2], 'base64');

      // Additional SVG script check
      if (rawExt === '.svg') {
        const svgText = buffer.toString('utf8');
        if (/<script[\s>]/i.test(svgText) || /javascript:/i.test(svgText)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'SVG contains disallowed script content' }));
          return;
        }
      }

      const cleanName = path.basename(filename || 'image', rawExt).replace(/[^a-zA-Z0-9_-]/g, '_') || 'upload';
      const newFilename = `${cleanName}_${Date.now()}${rawExt}`;
      const targetPath = path.join(PUBLIC_DIR, newFilename);

      try {
        fs.writeFileSync(targetPath, buffer);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, url: newFilename }));
      } catch (writeErr) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: writeErr.message }));
      }
    });
    return;
  }

  // API: Get current site data -> 200 OK
  if (req.method === 'GET' && pathname === '/api/data') {
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
      return;
    }

    // Fallback to embedded data from index.html if site-data.json does not exist
    if (fs.existsSync(HTML_FILE)) {
      const html = fs.readFileSync(HTML_FILE, 'utf8');
      const m = html.match(/<script type="application\/json" id="site-data">([\s\S]*?)<\/script>/);
      if (m && m[1]) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(m[1].trim());
        return;
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    return;
  }

  // Static File Serving with Path Traversal Protection
  let reqPath = pathname;
  if (reqPath === '/' || reqPath === '' || reqPath === '/admin') reqPath = '/index.html';

  // Prevent directory traversal attacks
  const safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(data);
  });
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Portfolio website running at http://${HOST}:${PORT}`);
  });
}

module.exports = server;
