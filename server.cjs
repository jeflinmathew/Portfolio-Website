const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const PUBLIC_DIR = __dirname;
const HTML_FILE = path.join(PUBLIC_DIR, 'index.html');
const DATA_FILE = path.join(PUBLIC_DIR, 'site-data.json');

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
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime'
};

const server = http.createServer((req, res) => {
  // CORS & No-Cache
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  // API: Save site data permanently
  if (req.method === 'POST' && pathname === '/api/save') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const data = payload.data;
        if (!data) throw new Error('No data provided');

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
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // API: Upload image file
  if (req.method === 'POST' && pathname === '/api/upload') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { filename, dataUrl } = payload;
        if (!dataUrl) throw new Error('No dataUrl provided');

        // Extract base64
        const matches = dataUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        if (!matches || matches.length !== 3) throw new Error('Invalid base64 data');

        const buffer = Buffer.from(matches[2], 'base64');
        const ext = path.extname(filename || '').toLowerCase() || '.png';
        const cleanName = path.basename(filename || 'image', ext).replace(/[^a-zA-Z0-9_-]/g, '_');
        const newFilename = `${cleanName}_${Date.now()}${ext}`;
        const targetPath = path.join(PUBLIC_DIR, newFilename);

        fs.writeFileSync(targetPath, buffer);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, url: newFilename }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // API: Get current site data
  if (req.method === 'GET' && pathname === '/api/data') {
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
      return;
    }
  }

  // Static File Serving
  let reqPath = pathname;
  if (reqPath === '/' || reqPath === '' || reqPath === '/admin') reqPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, reqPath);

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

server.listen(PORT, () => {
  console.log(`Portfolio website running at http://localhost:${PORT}`);
});
