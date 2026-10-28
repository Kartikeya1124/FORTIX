import express from 'express';

const app = express();
const PORT = 3001;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'fortix-demo-api' });
});

app.all('/api/v1/data', (req, res) => {
  res.json({
    status: 'ok',
    service: 'fortix-demo-api',
    endpoint: '/api/v1/data',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/payment', (req, res) => {
  res.json({ status: 'ok', message: 'Payment processed successfully' });
});

app.get('/api/slow', (req, res) => {
  setTimeout(() => {
    res.json({ status: 'ok', message: 'Slow response complete' });
  }, 2000); // 2 seconds latency
});

app.get('/api/flaky', (req, res) => {
  if (Math.random() < 0.5) {
    res.status(500).json({ status: 'error', message: 'Internal Server Error' });
  } else {
    res.json({ status: 'ok', message: 'Flaky response succeeded' });
  }
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`FortiX Demo API listening on http://0.0.0.0:${PORT}`);
});

server.on('error', (err: any) => {
  if (err?.code === 'EADDRINUSE') {
    console.warn(`[Demo API] Port ${PORT} already in use, continuing...`);
  } else {
    console.error('[Demo API] Server error:', err);
  }
});
