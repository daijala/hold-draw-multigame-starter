import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.static(path.join(__dirname, 'test-client')));

app.get('/api/config', (req, res) => {
  const hostname = req.get('host');
  let backendUrl;
  
  if (hostname.includes('localhost') || hostname.includes('127.0.0.1')) {
    backendUrl = 'http://localhost:8000';
  } else if (hostname.includes('replit.dev') || hostname.includes('repl.co')) {
    const replitDomain = process.env.REPLIT_DEV_DOMAIN || process.env.REPLIT_DOMAINS;
    if (replitDomain) {
      backendUrl = `https://8000-${replitDomain}`;
    } else {
      backendUrl = `https://${hostname.replace(/^[^-]+-/, '8000-')}`;
    }
  } else {
    backendUrl = `${req.protocol}://${hostname.split(':')[0]}:8000`;
  }
  
  res.json({ backendUrl });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'test-client', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Frontend server running on http://0.0.0.0:${PORT}`);
});
