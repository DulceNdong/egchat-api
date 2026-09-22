const express = require('express');
const path = require('path');
const fs = require('fs');


function resolveTargetCandidates(target) {
  const normalized = String(target || '').toLowerCase();
  const pairs = [];
  const add = (platform, arch) => pairs.push([platform, arch]);

  if (normalized.includes('windows')) add('windows', normalized.includes('aarch64') || normalized.includes('arm64') ? 'aarch64' : 'x86_64');
  if (normalized.includes('darwin') || normalized.includes('macos')) add('darwin', normalized.includes('aarch64') || normalized.includes('arm64') ? 'aarch64' : 'x86_64');
  if (normalized.includes('linux')) add('linux', normalized.includes('aarch64') || normalized.includes('arm64') ? 'aarch64' : 'x86_64');

  const parts = normalized.split('-').filter(Boolean);
  if (parts.length >= 2) {
    add(parts[0], parts.slice(1).join('-'));
    add(parts.slice(0, -1).join('-'), parts.at(-1));
  }
  return [...new Map(pairs.map((pair) => [pair.join('/'), pair])).values()];
}


function appendUpdateAudit(releasesDir, entry) {
  const auditDir = path.join(releasesDir, '_audit');
  fs.mkdirSync(auditDir, { recursive: true });
  const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n';
  fs.appendFileSync(path.join(auditDir, 'updates.jsonl'), line);
}

function createUpdateServer({ releasesDir = path.join(__dirname, '..', 'releases') } = {}) {
  const router = express.Router();


  router.get('/updates/:app/:target/latest.json', (req, res) => {
    const { app, target } = req.params;
    const candidates = resolveTargetCandidates(target);
    for (const [platform, arch] of candidates) {
      const manifestPath = path.join(releasesDir, app, platform, arch, 'latest.json');
      if (!manifestPath.startsWith(path.resolve(releasesDir))) return res.status(400).json({ error: 'BAD_PATH' });
      if (fs.existsSync(manifestPath)) {
        res.setHeader('Cache-Control', 'no-cache');
        return res.sendFile(manifestPath);
      }
    }
    return res.status(404).json({ error: 'NO_UPDATE', message: `No hay actualización para ${target}` });
  });

  router.get('/updates/:app/:platform/:arch/latest.json', (req, res) => {
    const { app, platform, arch } = req.params;
    const manifestPath = path.join(releasesDir, app, platform, arch, 'latest.json');
    if (!manifestPath.startsWith(path.resolve(releasesDir))) return res.status(400).json({ error: 'BAD_PATH' });
    if (!fs.existsSync(manifestPath)) return res.status(404).json({ error: 'NO_UPDATE', message: 'No hay actualización para esta plataforma' });
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(manifestPath);
  });

  router.post('/updates/audit', (req, res) => {
    const body = req.body || {};
    appendUpdateAudit(releasesDir, {
      app: body.app || 'unknown',
      fromVersion: body.fromVersion || null,
      toVersion: body.toVersion || null,
      status: body.status || 'unknown',
      actor: body.actor || req.get('user-agent') || 'unknown',
      ip: req.ip,
    });
    res.json({ ok: true });
  });

  router.get('/updates/audit/log', (req, res) => {
    const auditPath = path.join(releasesDir, '_audit', 'updates.jsonl');
    if (!fs.existsSync(auditPath)) return res.type('text/plain').send('');
    res.type('text/plain').sendFile(auditPath);
  });

  router.use('/downloads', express.static(releasesDir, {
    immutable: true,
    maxAge: '30d',
  }));

  return router;
}

module.exports = { createUpdateServer };
