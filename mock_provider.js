// mock_provider.js — mock OpenAI-compatible upstream untuk test custom provider.
// Bukan bagian server utama; dipakai e2e_test.sh saja.
// Run: node mock_provider.js   (listen 127.0.0.1:20299)
const http = require('node:http');

const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://x');
  if (req.method === 'GET' && u.pathname === '/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
    return;
  }
  if (req.method === 'POST' && u.pathname === '/chat/completions') {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => {
      let j = {};
      try { j = JSON.parse(b || '{}'); } catch {}
      const auth = req.headers['authorization'] || '';
      if (j.model === 'fail-model') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'mock upstream exploded' }));
        return;
      }
      if (j.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.end(
          'data: {"id":"m1","object":"chat.completion.chunk","choices":[{"delta":{"content":"MOCK-OK"}}]}\n\n' +
          'data: {"id":"m1","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n'
        );
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'm1', object: 'chat.completion', model: j.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'MOCK-OK auth=' + (auth ? 'yes' : 'no') }, finish_reason: 'stop' }],
          usage: {},
        }));
      }
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{}');
});

server.listen(20299, '127.0.0.1', () => console.log('mock provider on 127.0.0.1:20299'));
